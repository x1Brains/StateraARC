// THE LIVE LAYER — turning raw sources into screener rows, and re-pricing rows from the chain between indexer bakes.
// Pure logic with the RPC injected (`call`), so the browser (arc.ts wraps it with its RPC rotation) and the VPS API
// (server/statera-api.ts, its own RPC rotation) run the SAME code. Moved out of arc.ts / App.tsx 2026-09-28 with the
// function bodies unchanged. ⛔ Node imports this with type-stripping: .ts extensions on relative imports, no enums.
import { keccak_256 } from '@noble/hashes/sha3';
import { NATIVE_USDC_ADDR, sanitizeToken, type Token } from './rules.ts';

/** eth_call(to, data) at latest → hex result, or null. */
export type Call = (to: string, data: string) => Promise<any>;

export const rnum = (v: any): number | null => (v == null || isNaN(Number(v)) ? null : Number(v));
// Unwrap Next.js image-optimizer URLs (e.g. arguspad.io/_next/image?url=<ipfs>&w=128) to the underlying
// image. Those optimizer endpoints rate-limit (HTTP 429) so the <img> fails and falls back to a letter
// tile; the wrapped source (IPFS/pinata) loads reliably. Applies to every launchpad's logos.
export function normIcon(u: string | null | undefined): string | null {
  if (!u) return null;
  const m = u.match(/\/_next\/image\?url=([^&]+)/);
  let v = u;
  if (m) { try { v = decodeURIComponent(m[1]); } catch { /* keep u */ } }
  // Browsers can't load ipfs:// or ar:// (52 broken screener logos, 09-28) — same gateway as toHttp().
  return v.trim().replace(/^ipfs:\/\/(ipfs\/)?/i, 'https://gateway.pinata.cloud/ipfs/').replace(/^ar:\/\//i, 'https://arweave.net/');
}
// Launchpad display names (radar uses lowercase slugs). Falls back to a capitalized slug.
export const RADAR_LP: Record<string, string> = {
  argus: 'Argus', tolly: 'Tolly', long: 'LONG', dyor: 'DYOR', o1: 'O1', warp: 'Warp',
  synthra: 'Synthra', ayoo: 'Ayoo', poolstrade: 'PoolsTrade', archemist: 'Archemist', noxa: 'Noxa',
  lotus: 'Lotus', arcfun: 'Arc.fun', arcorigin: 'ArcOrigin', basedpad: 'BasedPad', rwarc: 'RWArc',
  sharc: 'Sharc', pegd: 'PEGD', cusp: 'Cusp', klik: 'Klik', cambo: 'Cambo', dagg: 'Dagg',
};

// A row of the VPS snapshot (/api/snapshot) → a screener Token (before sanitizeToken).
export const snapshotRow = (t: any): Token => ({
  address: t.address, name: t.name, symbol: t.symbol,
  holders: t.holders ?? null, totalSupply: null, type: 'ERC-20',
  iconUrl: normIcon(t.iconUrl) ?? null, launchpad: t.launchpad ?? null,
  isOurs: !!t.isOurs, isEcosystem: !!t.isEcosystem,
  price: rnum(t.price), liq: rnum(t.liq), mcap: rnum(t.mcap),
  volume24h: rnum(t.volume24h), change24h: rnum(t.change24h), change1h: rnum(t.change1h),
  txns24: rnum(t.txns24), spark: Array.isArray(t.spark) ? t.spark.filter((n: any) => typeof n === 'number' && isFinite(n)) : null,
  createdAt: rnum(t.createdAt), source: t.source ?? null,
  pool: t.pool ?? null, poolId: t.poolId ?? null, usdcIsC0: !!t.usdcIsC0, decimals: t.decimals ?? 18, hooked: !!t.hooked,
  v4fee: t.v4fee ?? null, v4tick: t.v4tick ?? null, hooks: t.hooks ?? null,
  v4PoolId: t.v4PoolId ?? null, v4UsdcIsC0: !!t.v4UsdcIsC0,
  v2Pairs: Array.isArray(t.v2Pairs) ? t.v2Pairs.filter((p: any) => p && /^0x[0-9a-f]{40}$/i.test(p.pair)).slice(0, 8) : null, // ⛔ new fields must be copied HERE or the API drops them // the token's V4 pool when pool/poolId point at V3 (pools card)
  priceFrom: t.priceFrom ?? null,
});

// A RadarDEX /tokens row → a Token (RadarDEX = backup source; it only fills gaps on chain-priced rows).
export const radarRow = (t: any): Token => {
  const lp = t.launchpad ? (RADAR_LP[t.launchpad] || (t.launchpad[0].toUpperCase() + t.launchpad.slice(1))) : null;
  const deploy = rnum(t.deployTs ?? t.firstSeen);
  return {
    address: (t.address || '').toLowerCase(), name: t.name || t.symbol || '?', symbol: t.symbol || '?',
    holders: t.holderCount != null ? Number(t.holderCount) : null, totalSupply: null, type: 'ERC-20',
    iconUrl: normIcon(t.icon), launchpad: lp, isOurs: false, isEcosystem: false,
    price: rnum(t.price), liq: rnum(t.liquidityUsdc), mcap: rnum(t.mcap),
    volume24h: rnum(t.volume24 ?? t.volume24hFixed), change24h: rnum(t.change24h),
    change1h: rnum(t.change1h), txns24: rnum(t.txns24),
    spark: Array.isArray(t.spark) ? t.spark.filter((n: any) => typeof n === 'number' && isFinite(n)) : null,
    createdAt: deploy != null ? deploy * 1000 : null,
  };
};

// Run async tasks with bounded concurrency (keeps us under the RPC's rate limit).
export async function runLimited<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) { const idx = i++; out[idx] = await tasks[idx](); }
  }));
  return out;
}

// ── Uniswap V4 (singleton PoolManager): a pool is a poolId; its slot0 via StateView, extsload fallback ──────────────
export const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
// Official Uniswap V4 read contract (docs.arc.io/arc/references/contract-addresses). getSlot0(bytes32)=0xc815641c
export const V4_STATEVIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const v4HexToU8 = (h: string) => { h = h.replace(/^0x/, ''); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
// state lives at _pools[poolId] (mapping slot 6); slot0 (sqrtPriceX96 in low 160 bits) is its base slot.
export const v4StateSlot = (poolId: string) => '0x' + Array.from(keccak_256(v4HexToU8(poolId.replace(/^0x/, '').padStart(64, '0') + (6).toString(16).padStart(64, '0')))).map((b) => b.toString(16).padStart(2, '0')).join('');
export async function v4Slot0Sqrt(call: Call, poolId: string): Promise<bigint | null> {
  const sv = await call(V4_STATEVIEW, '0xc815641c' + poolId.replace(/^0x/, '').padStart(64, '0')).catch(() => null);
  if (sv && sv !== '0x') { try { const sq = BigInt('0x' + sv.slice(2, 66)) & ((1n << 160n) - 1n); if (sq > 0n) return sq; } catch { /* fall through to extsload */ } }
  const s0 = await call(PM_V4, '0x1e2eaeaf' + v4StateSlot(poolId).slice(2)).catch(() => null);
  if (!s0 || s0 === '0x') return null;
  try { const sq = BigInt(s0) & ((1n << 160n) - 1n); return sq > 0n ? sq : null; } catch { return null; }
}
// USD-per-token from the V4 pool's live sqrtPriceX96 (StateView, extsload fallback).
export async function v4PriceOf(call: Call, poolId: string, usdcIsC0: boolean, decimals: number): Promise<number | null> {
  const sqrtP = await v4Slot0Sqrt(call, poolId);
  if (sqrtP == null || sqrtP <= 0n) return null;
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2; const dexp = 10 ** (decimals - 6);
  const price = (usdcIsC0 ? 1 / ratio : ratio) * dexp;
  return isFinite(price) && price > 0 ? price : null;
}

// Tracked deep pools (token → its USDC pool) — live-priced every refresh.
export const MAINNET_POOL: Record<string, string> = {
  '0x384c60f98ecd4c26345499345c03d677e40f115e': '0x507a494fde26960cb36d50912cab83c71ecc7ea7', // WARP (WarpV2)
  '0xece5ca8bf9220718e5727754026757512212cb3c': '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02', // ARGUS
  '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0': '0x0069cb6f70e2f848405f4483f232274c720ce6f9', // Architects
  '0xbc43ce8dec648ea298c4275559b81d6261c90b67': '0x162df51c504e7b8321e07387932f333d9be16a72', // TOLLY
  '0xf3715bf5c2de299f08b81180ffb739a8372a175f': '0x6d8db35396b5eb98dee495e32b8cca992682316d', // ARCANINE
  '0x07704b06981ea962b87296362a1281484d160000': '0xcf924acee7eb1f169a922bf19b0a732810971985', // ARCAT
  '0xeb64987643db71c76b2a2be7e723decc995e5b37': '0x40732e01ba7a829dea44f51a10e7c58cd9f37765', // COOL
  '0x0bffa97f774824e9da843699aedd2835cb1b8022': '0x7dbcec05f12b14e21a79a0dc15ea9859322a4ab2', // ARCASH
  '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97': '0x482a249eb473b7de0ca8357b5496ccb7c55dfb72', // ARCBAT
  // Found via Transfer-log scan (their pools hold few tokens so they never rank as top holders).
  '0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b': '0x2e8180fa3967caf9abf57bbaeab9ae9063bcd7ba', // CRCL (thin, high unit price)
  // ARCX10 omitted: its V3 pool is dead ($16); real liquidity is a hooked Uniswap-v4 pool we don't price.
  '0x2164bb17a2d38c1b5170e987b2c0416df1efc752': '0xda9f3d166497ddfddf37c93cacfd8aa39b71e493', // LONG (Uni V3, ~$113k)
  '0xd17014b731d33994e4e482c374ef375b68240087': '0x0f0333cf487a90ac7e56cba1541a1669e260cf22', // MMM (thin)
};

export async function deepPoolPrices(call: Call): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const balOf = (token: string, who: string) => call(token, '0x70a08231000000000000000000000000' + who.slice(2).toLowerCase());
  await runLimited(Object.entries(MAINNET_POOL).map(([token, pool]) => async () => {
    const [slot0, t0] = await Promise.all([call(pool, '0x3850c7bd'), call(pool, '0x0dfe1681')]); // slot0(), token0()
    if (!t0) return; // ⛔ unknown orientation = no price (a guessed `false` inverted ARC BAT to $6.97e27, 09-25)
    const usdcIsT0 = ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR.toLowerCase();
    let price: number | null = null;
    if (slot0 && slot0 !== '0x' && slot0.length >= 66) {
      try { const sqrtP = BigInt('0x' + slot0.slice(2, 66)); if (sqrtP > 0n) { const r = (Number(sqrtP) / 2 ** 96) ** 2; if (isFinite(r) && r > 0) price = (usdcIsT0 ? 1 / r : r) * 1e12; } } catch { /* skip */ }
    }
    if (price == null) { // V2 pool: reserve ratio
      const [uHex, bHex] = await Promise.all([balOf(NATIVE_USDC_ADDR, pool), balOf(token, pool)]);
      try { const u = Number(BigInt(uHex)) / 1e6, tk = Number(BigInt(bHex)) / 1e18; if (tk > 0) price = u / tk; } catch { /* skip */ }
    }
    if (price != null && isFinite(price) && price > 0) out[token] = price;
  }), 5);
  return out;
}

// Live price for a set of ON-CHAIN screener rows (V3 slot0 / V4 extsload), so the top rows aren't ~15 min
// stale between indexer bakes. Bounded to whatever list the caller passes (the visible top rows).
export async function onchainPrices(call: Call, rows: { address: string; pool?: string | null; poolId?: string | null; usdcIsC0?: boolean; decimals?: number }[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await runLimited(rows.map((t) => async () => {
    const dexp = 10 ** ((t.decimals ?? 18) - 6);
    let price: number | null = null;
    if (t.poolId) { const sq = await v4Slot0Sqrt(call, t.poolId); if (sq != null && sq > 0n) { const r = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / r : r) * dexp; } }
    else if (t.pool) { const s0 = await call(t.pool, '0x3850c7bd').catch(() => null); if (s0 && s0.length >= 66) { try { const sq = BigInt(s0.slice(0, 66)); if (sq > 0n) { const r = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / r : r) * dexp; } } catch { /* */ } } }
    if (price != null && isFinite(price) && price > 0 && price < 1e6) out[t.address.toLowerCase()] = price;
  }), 8);
  return out;
}

// Curated V4 launchpad tokens (GLITCH etc.) that no aggregator indexes — listed & priced on-chain.
export const CURATED_V4: { address: string; symbol: string; name: string; launchpad?: string; poolId: string; usdcIsC0: boolean }[] = [
  { address: '0x08adbf431569a1aacac2606d2adcd18f4ebf2a71', symbol: 'GLITCH', name: 'Glitch', launchpad: 'Argus pad',
    poolId: '0x278eab5f794ccbaa85dd7cd275e56bf563d8d26e35fd717800f39340f9730c3a', usdcIsC0: false },
];
export async function curatedV4Tokens(call: Call): Promise<Token[]> {
  const out: Token[] = [];
  await Promise.all(CURATED_V4.map(async (c) => {
    try {
      const dec = 18; // launchpad coins are 18-dec
      const [price, supHex] = await Promise.all([
        v4PriceOf(call, c.poolId, c.usdcIsC0, dec), // known pool — skip the discovery scan (fast+reliable)
        call(c.address, '0x18160ddd').catch(() => null), // totalSupply()
      ]);
      let supply: number | null = null; try { if (supHex && supHex !== '0x') supply = Number(BigInt(supHex)) / 10 ** dec; } catch { /* */ }
      const mcap = price != null && supply ? price * supply : null;
      out.push({ address: c.address.toLowerCase(), name: c.name, symbol: c.symbol, holders: null, totalSupply: null,
        type: 'ERC-20', iconUrl: null, launchpad: c.launchpad ?? null, isOurs: false, isEcosystem: false,
        price, liq: null, mcap: mcap && mcap <= 1e10 ? mcap : null, fdv: mcap && mcap <= 1e11 ? mcap : null,
        volume24h: null, change5m: null, change1h: null, change6h: null, change24h: null, txns24: null,
        // carry the pool so the token page primes the cache → no slow discovery scan
        poolId: c.poolId, usdcIsC0: c.usdcIsC0, decimals: dec,
        source: 'V4', spark: null, createdAt: null });
    } catch { /* */ }
  }));
  return out;
}

// ── The merges App.tsx did on every refresh (unchanged) ──────────────────────────────────────────────────────────
// Curated rows are only ADDED (never replace a snapshot row).
export const mergeCurated = (prev: Token[], extra: Token[]): Token[] => {
  if (!extra.length) return prev;
  const have = new Set(prev.map((t) => t.address.toLowerCase()));
  return [...prev, ...extra.filter((e) => !have.has(e.address.toLowerCase()))];
};
// The top ON-CHAIN rows by liquidity that get a live slot0 re-price between bakes.
export const topOnchainRows = (list: Token[], n = 60) => list.filter((t) => (t.source === 'V3' || t.source === 'V4') && (t.pool || t.poolId)).sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0)).slice(0, n);
export const applyOnchainPrices = (prev: Token[], px: Record<string, number>): Token[] =>
  !Object.keys(px).length ? prev : prev.map((t) => { const p = px[t.address.toLowerCase()]; return p != null ? sanitizeToken({ ...t, price: p }) : t; });
// LIVE FEED overlay: fresh RadarDEX price/change/volume/liq merged in place by address, then deep-pool slot0 prices.
export const applyLiveOverlay = (prev: Token[], live: Token[], deep: Record<string, number>): Token[] => {
  const m = new Map(live.map((t) => [t.address.toLowerCase(), t]));
  return prev.map((t) => {
    const a = t.address.toLowerCase();
    const l = m.get(a);
    // ⛔ ON-CHAIN IS PRIMARY (owner, 09-24): RadarDEX is a backup. For a row the snapshot priced from the chain
    // it may only fill a field that is still empty; it overwrites only rows that came from an indexer anyway.
    const chain = t.priceFrom === 'chain';
    const pick = <K extends keyof Token>(k: K) => (chain ? (t[k] ?? (l as any)?.[k]) : ((l as any)?.[k] ?? t[k]));
    let n = l ? { ...t, price: pick('price'), change24h: pick('change24h'), change1h: pick('change1h'), volume24h: pick('volume24h'), liq: pick('liq'), mcap: pick('mcap') } : t;
    if (deep[a] != null) n = { ...n, price: deep[a] }; // deep-pool live price wins (correct slot0)
    return sanitizeToken(n);
  });
};
