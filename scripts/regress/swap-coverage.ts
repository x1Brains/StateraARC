// SWAP COVERAGE (09-29, owner: "make sure we can trade all of the indexed tokens … find the routes, it's all on chain").
// For every token the screener lists, run the SAME quote functions the Swap page runs (src/lib/swap.ts) — WarpV2/UniV2
// pairs, Uniswap V3, Uniswap V4 (screener PoolKey hint), Aerodrome/Archery CL, and the Warp curve — for a ~$1 buy (USDC ->
// token) and a ~$1 sell (token -> USDC). Prints which venue wins each way and every token with no route, with the venue
// the INDEXER priced it on (row.source) so a gap can be traced to a missing router or a missing multi-hop.
//   node --experimental-strip-types scripts/regress/swap-coverage.ts [https://www.stateraarc.com] [out.json]
import fs from 'node:fs';
import * as S from '../../src/lib/swap.ts';

const BASE = process.argv[2] || 'https://www.stateraarc.com', OUT = process.argv[3] || '';
const DUMMY = '0x000000000000000000000000000000000000dEaD'; // eth_call "from" for the curve quote (read-only)
const pow = (d: number) => 10n ** BigInt(d);
const raw = (x: number, d: number) => { const s = x.toFixed(Math.min(d, 18)); const [i, f = ''] = s.split('.'); return BigInt(i) * pow(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0'); };
S.setSwapMainnet(true);

const board: any = await (await fetch(`${BASE}/api/v2/board?per=500&page=1`)).json();
const rows: any[] = board.rows || [];
console.log(`${rows.length} listed tokens`);

async function quoteAll(tin: string, tout: string, amt: bigint, row: any, rt: { v3: string | null; v4: any; cl: any[] }) {
  const [q, r3, r4, rc] = await Promise.all([
    S.bestQuote(tin, tout, amt).catch(() => null),
    rt.v3 ? S.quoteV3(tin, tout, amt, rt.v3).catch(() => null) : null,
    rt.v4 ? S.quoteV4(tin, tout, amt, rt.v4).catch(() => null) : null,
    rt.cl.length ? S.quoteCL(tin, tout, amt, rt.cl).catch(() => null) : null,
  ]);
  const outs: [string, bigint][] = [['WarpV2/V2', (q as any)?.amountOutRaw ?? -1n], ['UniV3', r3?.outRaw ?? -1n], ['UniV4', r4?.outRaw ?? -1n], [rc ? String((rc as any).route?.venue?.name ?? (rc as any).route?.venue ?? 'CL') : 'CL', rc?.outRaw ?? -1n]];
  const best = outs.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0n ? { venue: best[0], out: best[1] } : null;
}

const res: any[] = [];
let i = 0;
async function one(row: any) {
  const a = row.address.toLowerCase(), dec = row.decimals ?? (await S.decimalsOf(a).catch(() => 18));
  const [v3, v4, cl] = await Promise.all([S.findV3Pool(a).catch(() => null), S.findV4Route(a, row).catch(() => null), S.findCLPools(a).catch(() => [])]);
  const rt = { v3, v4, cl };
  const buy = await quoteAll(S.NATIVE_USDC, a, raw(1, 6), row, rt);
  const sellAmt = row.price > 0 ? raw(Math.min(1 / row.price, 1e15), dec) : raw(1, dec);
  const sell = await quoteAll(a, S.NATIVE_USDC, sellAmt, row, rt);
  let curve: string | null = null;
  if (!buy) { // Warp bonding curve (non-graduated) — what the page tries after the pools
    try { const w: any = await (await fetch(`${BASE}/api/warp/tokens/${a}`)).json(); const c = w?.curveAddress || w?.token?.curveAddress;
      if (c && !(w?.migrated || w?.token?.migrated)) { const r = await S.quoteCurveBuy(c, 1, DUMMY); if (r) curve = 'curve'; } } catch { /* none */ }
  }
  const r = { sym: row.symbol, addr: a, source: row.source, liq: Math.round(row.liq || 0), vol: Math.round(row.volume24h || 0), launchpad: row.launchpad || null,
    found: { v3: !!v3, v4: !!v4, cl: cl.length }, buy: buy?.venue || curve, sell: sell?.venue || (curve ? 'curve' : null) };
  res.push(r);
  if (++i % 10 === 0) console.log(`  ${i}/${rows.length}`);
}
// 2 at a time — the public RPCs refuse bursts
for (let k = 0; k < rows.length; k += 2) await Promise.all(rows.slice(k, k + 2).map((r) => one(r).catch((e) => res.push({ sym: r.symbol, addr: r.address, source: r.source, err: String(e).slice(0, 80) }))));

const noBuy = res.filter((r) => !r.buy), noSell = res.filter((r) => !r.sell);
const by = (f: string) => res.reduce((m: any, r: any) => { const k = r[f] || 'NONE'; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log('\nBUY  venues:', JSON.stringify(by('buy')));
console.log('SELL venues:', JSON.stringify(by('sell')));
console.log(`\nNO BUY ROUTE (${noBuy.length}):`);
for (const r of noBuy.sort((a, b) => b.liq - a.liq)) console.log(`  ${String(r.sym).padEnd(14)} ${r.addr}  src=${r.source}  liq=$${r.liq}  vol=$${r.vol}  pad=${r.launchpad}  found=${JSON.stringify(r.found)}${r.err ? ' ERR ' + r.err : ''}`);
console.log(`\nbuy OK but NO SELL (${noSell.filter((r) => r.buy).length}):`);
for (const r of noSell.filter((r) => r.buy)) console.log(`  ${String(r.sym).padEnd(14)} ${r.addr} src=${r.source} buy=${r.buy}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
process.exit(0);
