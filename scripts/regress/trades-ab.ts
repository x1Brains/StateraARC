// A/B (10-02): the server's incrementally-kept trade list vs a fresh full 24h scan, same token, same moment.
//   node --experimental-strip-types scripts/regress/trades-ab.ts <token> <decimals> [v4PoolId v4UsdcIsC0]
import { primePool, fetchPoolTrades } from '../../src/lib/arc.ts';
const [tok, d, v4, c0] = process.argv.slice(2);
if (v4) primePool(tok, { v4PoolId: v4, v4UsdcIsC0: c0 === 'true' });
const B = `https://www.stateraarc.com/api/v2/token/${tok}`;
const get = async (u: string) => (await fetch(u, { signal: AbortSignal.timeout(90000) })).json();
const live: any[] = []; let p = 0, pages = 1;
const [full] = await Promise.all([fetchPoolTrades(tok, Number(d), 20000), (async () => { do { const j = await get(`${B}/trades?page=${p}&side=all`); live.push(...j.rows); pages = j.pages; p++; } while (p < pages); })()]);
const key = (x: any) => `${x.tx}:${x.side}:${Number(x.amount).toPrecision(9)}`;
const lo = Math.max(live[live.length - 1].time, full[full.length - 1].time) + 120, hi = Math.min(live[0].time, full[0].time) - 120; // the span both cover (2-min margins)
const L = new Set(live.filter((x) => x.time >= lo && x.time <= hi).map(key)), F = new Set(full.filter((x) => x.time >= lo && x.time <= hi).map(key));
const onlyL = [...L].filter((k) => !F.has(k)), onlyF = [...F].filter((k) => !L.has(k));
console.log(`live ${live.length} rows · full scan ${full.length} rows · compared span ${((hi - lo) / 3600).toFixed(1)}h: live ${L.size}, full ${F.size}, only-live ${onlyL.length}, only-full ${onlyF.length}`);
if (onlyL.length || onlyF.length) console.log('only-live', onlyL.slice(0, 5), 'only-full', onlyF.slice(0, 5));
process.exit(0);
