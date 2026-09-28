// A/B: the v1 board logic (generated verbatim from the v1-baseline tag's App.tsx) vs src/lib/board.ts, on the same token
// list, across every filter × sort × direction × toggle and a set of searches. Any difference = not identical = do not ship.
//   node scripts/regress/board-ab.ts <snapshot.json> [more.json…]
import fs from 'node:fs';
import { PINNED, sanitizeToken, type Token } from '../../src/lib/rules.ts';
import * as B from '../../src/lib/board.ts';
import { v1Board } from './board-v1.gen.ts';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/regress/board-ab.ts <snapshot.json>…'); process.exit(2); }
const key = (ts: Token[]) => ts.map((t) => t.address).join(',');
let checks = 0, fails = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  checks++;
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) { fails++; if (fails <= 15) console.log(`  DIFF ${label}\n    v1: ${x.slice(0, 240)}\n    v2: ${y.slice(0, 240)}`); }
};
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const tokens: Token[] = (raw.tokens ?? raw).map((t: Token) => sanitizeToken(t));
  const now = Date.now();
  const RealNow = Date.now; Date.now = () => now; // both sides see the same clock
  const ix = B.buildIndex(tokens, PINNED);
  const st0 = { filter: 'all', q: '', sort: 'liq', dir: 'desc', hideDupes: true, showInactive: false, heroQ: '' };
  const base = v1Board(tokens, PINNED, st0);
  eq('dashStats', base.dashStats, B.dashStats(tokens, ix, now));
  eq('dupCount', base.dupCount, B.dupCount(tokens, ix));
  eq('ecoCount', base.ecoCount, B.ecoCount(tokens));
  eq('launchpadCount', base.launchpadCount, B.launchpadCount(tokens, ix));
  eq('launchpadLegend', base.launchpadLegend, B.launchpadLegend(tokens, ix));
  eq('swapTokens', key(base.swapTokens), key(B.swapTokens(tokens, ix)));
  eq('trending', key(base.trending), key(B.trending(tokens, ix)));
  eq('launches', key(base.launches), key(B.launches(tokens, ix)));
  eq('movers', key(base.movers), key(B.movers(tokens, ix)));
  for (const filter of ['all', 'new', 'eco'] as const)
    for (const sort of ['liq', 'mcap', 'holders', 'price', 'name', 'volume', 'change24h', 'change1h', 'age'] as const)
      for (const dir of ['desc', 'asc'] as const)
        for (const hideDupes of [true, false])
          for (const showInactive of [false, true]) {
            const st = { ...st0, filter, sort, dir, hideDupes, showInactive };
            eq(`rows ${JSON.stringify(st)}`, key(v1Board(tokens, PINNED, st).rows), key(B.boardRows(tokens, ix, st)));
          }
  for (const q of ['arg', 'ARGUS', 'usdc', 'cir', 'tolly', '0xece5', '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', 'a', 'zz', ' eurc ']) {
    eq(`search ${q}`, key(v1Board(tokens, PINNED, { ...st0, q }).rows), key(B.boardRows(tokens, ix, { ...st0, q } as B.BoardQuery)));
    eq(`hero ${q}`, key(v1Board(tokens, PINNED, { ...st0, heroQ: q }).heroMatches), key(B.heroMatches(tokens, ix, q)));
  }
  Date.now = RealNow;
  console.log(`${f}: ${tokens.length} tokens, board rows (default) ${B.boardRows(tokens, ix, st0 as B.BoardQuery).length}`);
}
console.log(`\n${checks} checks, ${fails} differences → ${fails ? 'NOT IDENTICAL' : 'IDENTICAL'}`);
process.exit(fails ? 1 : 0);
