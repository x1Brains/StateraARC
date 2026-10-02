// Token-page trade table probe: rows per venue, buys/sells, time span (10-02 — the table read one pool, 40 rows).
//   node --experimental-strip-types scripts/regress/trades-probe.ts <token> [decimals] [v4PoolId] [v4UsdcIsC0]
import { primePool, fetchPoolTrades } from '../../src/lib/arc.ts';
const [tok, d, v4, c0] = process.argv.slice(2);
if (v4) primePool(tok, { v4PoolId: v4, v4UsdcIsC0: c0 === 'true' });
const t0 = Date.now();
const r = await fetchPoolTrades(tok, Number(d || 18), Number(process.env.WANT || 1000));
const by: Record<string, number> = {}; for (const x of r) by[x.venue || '?'] = (by[x.venue || '?'] || 0) + 1;
const span = r.length ? (r[0].time - r[r.length - 1].time) / 3600 : 0;
console.log(`${r.length} trades in ${((Date.now() - t0) / 1000).toFixed(1)}s · buys ${r.filter((x) => x.side === 'buy').length} sells ${r.filter((x) => x.side === 'sell').length} · span ${span.toFixed(1)}h · oldest ${r.length ? ((Date.now() / 1000 - r[r.length - 1].time) / 3600).toFixed(1) : '-'}h ago`);
console.log('by venue', JSON.stringify(by));
process.exit(0);
