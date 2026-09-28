// Live check of the swap engine's venues against real Arc pools — runs the SAME src/lib/swap.ts the site runs.
// For each token: bestQuote (WarpV2 + Uniswap V2 routers), Uniswap V3, and the CL venues (Aerodrome, Archery), buying $10 of
// it with USDC; every venue's output must be within a few % of the others that have a pool (a wildly different number = a
// broken encoding, not a better price). Read-only (eth_call quotes only).
//   node scripts/regress/swap-venues-check.ts
import { setSwapMainnet, bestQuote, quoteV3, findV3Pool, findCLPools, quoteCL, NATIVE_USDC } from '../../src/lib/swap.ts';
setSwapMainnet(true);
const TOKENS: Record<string, [string, number]> = {
  WETH: ['0x128cc466b61f542da60c70e3aa11c10e19b84edb', 18],
  cirBTC: ['0x171a4217b86a807a64eb94757db6849fb4bdbaa0', 8],
  EURC: ['0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', 6],
  ARGUS: ['0xece5ca8bf9220718e5727754026757512212cb3c', 18],
};
const amt = 10_000_000n; // $10 of USDC (6-dec face)
let bad = 0;
for (const [sym, [addr, dec]] of Object.entries(TOKENS)) {
  const [v2, v3pool, cl] = await Promise.all([bestQuote(NATIVE_USDC, addr, amt).catch(() => null), findV3Pool(addr).catch(() => null), findCLPools(addr).catch(() => [])]);
  const v3 = v3pool ? await quoteV3(NATIVE_USDC, addr, amt, v3pool).catch(() => null) : null;
  const perCL = await Promise.all(cl.map(async (rt) => ({ rt, q: await quoteCL(NATIVE_USDC, addr, amt, [rt]).catch(() => null) })));
  const rows: [string, bigint | null][] = [[`${v2?.routerName ?? 'V2 routers'}`, v2?.amountOutRaw ?? null], ['Uniswap V3', v3?.outRaw ?? null],
    ...perCL.map((x) => [`${x.rt.venue.name} ts${x.rt.tickSpacing}`, x.q?.outRaw ?? null] as [string, bigint | null])];
  const got = rows.filter(([, v]) => v != null && v > 0n).map(([n, v]) => [n, Number(v) / 10 ** dec] as [string, number]);
  const med = got.length ? [...got].map(([, v]) => v).sort((a, b) => a - b)[Math.floor(got.length / 2)] : 0;
  console.log(`${sym}: ${got.length} venues quote $10 →`, got.map(([n, v]) => `${n} ${v.toPrecision(6)}${Math.abs(v / med - 1) > 0.05 ? ' ⚠ >5% off median' : ''}`).join(' | ') || 'no route');
  // Only a DEEP pool must agree; a thin pool legitimately gives less (price impact) — flag only a HIGHER-than-market outlier.
  if (got.some(([, v]) => v > med * 1.05)) bad++;
}
console.log(bad ? `FAIL: ${bad} token(s) with a venue quoting >5% ABOVE the others (likely an encoding bug)` : 'PASS: no venue quotes above the market');
process.exit(bad ? 1 : 0);
