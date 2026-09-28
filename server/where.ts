// WHERE IT SITS — for each Circle asset on Arc (USDC, EURC, cirBTC), how its supply splits between lending, DEX pools,
// Circle's Gateway, other contracts and wallets. Owner 09-28: the $405M cirBTC "market cap" vs its ~$12.8M DEX liquidity.
// Every bucket is an on-chain balanceOf() of known addresses, bundled through Multicall3; "Wallets & others" = supply − the
// rest, so the buckets always add up to the supply exactly.
// ⛔ arc-scan has NO holder list for native USDC and marks contracts (e.g. the Aave Hub) as wallets — so contract/pool status
// is checked on chain here (eth_getCode, token0()), never taken from arc-scan.
import { encAggregate3, decAggregate3 } from '../scripts/lib/multicall.mjs';

type Rpc = (method: string, params: unknown[]) => Promise<any>;
const MC = '0xca11bde05977b3631167028862be2a173976ca11';
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
export const ASSETS = [
  { sym: 'USDC', addr: '0x3600000000000000000000000000000000000000', dec: 6 },
  { sym: 'EURC', addr: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', dec: 6 },
  { sym: 'cirBTC', addr: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', dec: 8 },
];
// Named contracts (each verified on chain or in the protocols' own docs — see server/lending.ts, chain.ts).
const LENDING: Record<string, string> = { '0x34cd04070dd72b14e241112f6d83812df5af7fcd': 'Morpho', '0x17288dfc86205301064577b98b02b81017e6f79c': 'Aave V4' };
const BRIDGE: Record<string, string> = { '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee': 'Circle Gateway' };
const V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

async function multicall(rpc: Rpc, calls: { target: string; data: string }[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < calls.length; i += 100) {
    const ch = calls.slice(i, i + 100);
    const r = await rpc('eth_call', [{ to: MC, data: encAggregate3(ch) }, 'latest']);
    if (!r || r.length < 3) throw new Error('multicall failed');
    out.push(...decAggregate3(r));
  }
  return out;
}
const n = (h: string | undefined, dec: number) => (h && h.length >= 66 ? Number(BigInt(h.slice(0, 66))) / 10 ** dec : 0);

let snap: any = null;
export const whereSummary = () => snap;
export const whereStats = { runs: 0, errors: 0 };
const poolCache = new Map<string, boolean>(); // address → is a DEX pool (answers token0()); contracts only

/** poolAddrs = every pool address the live token list knows (V2/V3/CL primary pools); prices = USD per token. */
export async function refreshWhere(rpc: Rpc, poolAddrs: string[], priceOf: (a: string) => number | null) {
  const pools = [...new Set(poolAddrs.map((a) => a.toLowerCase()))];
  const result: any[] = [];
  for (const as of ASSETS) {
    // candidates: named contracts + the V4 PoolManager + every known pool + (EURC/cirBTC) the top 100 holders from arc-scan
    const cands = new Set<string>([...Object.keys(LENDING), ...Object.keys(BRIDGE), V4_POOL_MANAGER, ...pools]);
    if (as.sym !== 'USDC') {
      try {
        const j: any = await fetch(`https://api.arc-scan.org/v1/tokens/${as.addr}/holders?limit=100`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
        for (const h of j.items || []) { const a = (h.address?.address || h.address || '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(a)) cands.add(a); }
      } catch { /* the known places still count */ }
    }
    const list = [...cands];
    const [supHex, ...bals] = await multicall(rpc, [{ target: as.addr, data: '0x18160ddd' }, ...list.map((a) => ({ target: as.addr, data: '0x70a08231' + pad(a) }))]);
    const supply = n(supHex, as.dec);
    const held = list.map((a, i) => ({ a, v: n(bals[i], as.dec) })).filter((x) => x.v > 0);
    // Unknown holders with a balance: contract? pool? (checked once each, cached)
    const unknown = held.filter((x) => !LENDING[x.a] && !BRIDGE[x.a] && x.a !== V4_POOL_MANAGER && !pools.includes(x.a) && !poolCache.has(x.a));
    if (unknown.length) {
      const codes = await Promise.all(unknown.map((x) => rpc('eth_getCode', [x.a, 'latest']).catch(() => null)));
      const contracts = unknown.filter((_, i) => codes[i] && codes[i] !== '0x');
      for (const x of unknown) if (!contracts.includes(x)) poolCache.set(x.a, false);
      if (contracts.length) {
        const t0 = await multicall(rpc, contracts.map((x) => ({ target: x.a, data: '0x0dfe1681' }))); // token0()
        contracts.forEach((x, i) => poolCache.set(x.a, !!t0[i] && t0[i].length >= 66));
        for (const x of contracts) if (!poolCache.get(x.a)) poolCache.set(x.a + ':contract', true);
      }
    }
    const b = { lending: 0, dex: 0, bridge: 0, contracts: 0, wallets: 0 };
    const lendBy: Record<string, number> = {};
    for (const x of held) {
      if (LENDING[x.a]) { b.lending += x.v; lendBy[LENDING[x.a]] = (lendBy[LENDING[x.a]] || 0) + x.v; }
      else if (BRIDGE[x.a]) b.bridge += x.v;
      else if (x.a === V4_POOL_MANAGER || pools.includes(x.a) || poolCache.get(x.a)) b.dex += x.v;
      else if (poolCache.get(x.a + ':contract')) b.contracts += x.v;
    }
    b.wallets = Math.max(0, supply - b.lending - b.dex - b.bridge - b.contracts);
    const px = as.sym === 'USDC' ? 1 : priceOf(as.addr);
    result.push({ sym: as.sym, supply, price: px, buckets: b, lendingBy: lendBy });
  }
  snap = { at: Date.now(), assets: result };
  whereStats.runs++;
}
