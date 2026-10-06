// ARCTIDE PROBE (10-05): quote + build + SIMULATE (eth_call, no tx sent) an Arctide buy and sell with the SAME functions the
// Swap page runs, from real wallets. Checks the quote is exact: minOut = quote passes, minOut = quote + 1% reverts.
//   node --experimental-strip-types scripts/regress/arctide-probe.ts [token] [buyer] [seller]
import * as S from '../../src/lib/swap.ts';
S.setSwapMainnet(true);
const U = S.NATIVE_USDC;
const TOKEN = process.argv[2] || '0x92395d0cd51bb504a39e53105cb6862948af1b8e'; // TIDE
const BUYER = process.argv[3] || '0xe1444067312d6a38780ca94b1adffdf6621f22fd';  // holds native USDC (a real TIDE buyer)
const SELLER = process.argv[4] || '0xd335674a2b7bededf803f8780256689420325ff2'; // holds TIDE + router allowance
const rt = await S.findArctidePair(TOKEN);
console.log('route', rt);
if (!rt) process.exit(1);
let bad = 0;
for (const [isBuy, from, amt] of [[true, BUYER, 1_000_000n], [false, SELLER, 10n ** 20n]] as const) {
  const q = await S.quoteArctide(isBuy ? U : TOKEN, isBuy ? TOKEN : U, amt, rt);
  if (!q) { console.log(isBuy ? 'BUY' : 'SELL', 'no quote'); bad++; continue; }
  const exact = await S.simulate(S.buildArctideSwapTx(rt, isBuy, amt, q.outRaw, from));
  const over = await S.simulate(S.buildArctideSwapTx(rt, isBuy, amt, q.outRaw + q.outRaw / 100n, from));
  const slip = await S.simulate(S.buildArctideSwapTx(rt, isBuy, amt, S.minOut(q.outRaw, 1), from));
  console.log(isBuy ? 'BUY ' : 'SELL', 'in', amt.toString(), 'out', q.outRaw.toString(), `fee ${q.feeBps}bps`,
    '| minOut=quote:', exact ?? 'OK', '| quote+1%:', over ?? 'OK (should revert!)', '| 1% slip:', slip ?? 'OK');
  if (exact || !over || slip) bad++;
}
console.log(bad ? `FAIL ${bad}` : 'PASS');
process.exit(bad ? 1 : 0);
