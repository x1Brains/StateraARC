// One-time (re)build of trader_pos — every wallet's running buy/sell totals per token, from swaps ⨝ makers — so Top traders and
// Holder profitability read a few rows instead of joining the 12.3M-row maker history on every request (they hit the 60 s limit).
// Run on the VPS with statera-swaps STOPPED (the indexer adds to these totals as makers resolve — a build racing it double-counts):
//   systemctl stop statera-swaps; SWAPS_DB=/root/statera-swaps/swaps.db node … scripts/traders-build.ts; systemctl start statera-swaps
import { openSwapDb } from '../server/swap-db.ts';

const db = openSwapDb(false);
const toks = (db.prepare('SELECT DISTINCT token FROM pools WHERE ok = 1 AND token IS NOT NULL').all() as { token: string }[]).map((r) => r.token);
db.exec('DELETE FROM trader_pos');
const ins = db.prepare(`INSERT INTO trader_pos(token, maker, bought, sold, qb, qs, nb, ns, first, last)
  SELECT p.token, m.maker,
    SUM(CASE WHEN s.side > 0 THEN s.usd ELSE 0 END), SUM(CASE WHEN s.side < 0 THEN s.usd ELSE 0 END),
    SUM(CASE WHEN s.side > 0 THEN s.amt ELSE 0 END), SUM(CASE WHEN s.side < 0 THEN s.amt ELSE 0 END),
    SUM(s.side > 0), SUM(s.side < 0), MIN(s.ts), MAX(s.ts)
  FROM pools p JOIN swaps s ON s.pid = p.pid JOIN makers m ON m.tx = s.tx
  WHERE p.token = ? AND p.ok = 1 GROUP BY m.maker`);
const t0 = Date.now(); let rows = 0, i = 0;
db.exec('BEGIN');
for (const t of toks) {
  rows += Number(ins.run(t).changes);
  if (++i % 2000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); console.log(new Date().toISOString().slice(11, 19), 'tokens', i, '/', toks.length, 'positions', rows, Math.round((Date.now() - t0) / 1000) + 's'); }
}
db.exec('COMMIT');
console.log('COMPLETE tokens', toks.length, 'positions', rows, Math.round((Date.now() - t0) / 1000) + 's');
