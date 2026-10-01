// Pools card probe: what fetchAllOnchainPools returns for a token primed exactly like the token page primes it.
//   node --experimental-strip-types scripts/regress/pools-probe.ts <token> [v4PoolId] [v4UsdcIsC0]
const [tok, v4, c0] = process.argv.slice(2);
if (v4) primePool(tok, { v4PoolId: v4, v4UsdcIsC0: c0 === 'true' });
import { primePool, fetchAllOnchainPools } from "../../src/lib/arc.ts";
const ps = await fetchAllOnchainPools(tok, Number(process.env.DEC || 18));
for (const p of ps) console.log(p.version.padEnd(7), String(p.feeTier ?? '').padEnd(6), p.pool.slice(0, 12), '$' + Math.round(p.liquidityUsdc ?? 0).toLocaleString());
console.log('total $' + Math.round(ps.reduce((s, p) => s + (p.liquidityUsdc || 0), 0)).toLocaleString());
process.exit(0);
