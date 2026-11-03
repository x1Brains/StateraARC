// ALIVE TOKENS (11-03) — which quiet tokens are still real, judged by WALLETS, not one day's volume.
// Owner: "volume can be slow, doesn't mean the liquidity is gone". The default board used to need $50 of 24h volume, which hid
// tokens like EXIT ($55K real USDC, 63 wallets in 30 days). This job reads the swap store once (one grouped query over 30 days,
// ~70 s at nice 19, run by statera-alive.timer) and writes /root/statera-live/alive.json. The API copies the numbers onto each
// row and src/lib/board.ts `isAlive` decides. Read-only on swaps.db. A token is listed here only with 10+ wallets in 30 days.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const SWAPS = process.env.SWAPS_DB || '/root/statera-swaps/swaps.db';
const OUT = process.env.ALIVE_FILE || '/root/statera-live/alive.json';
const DAYS = 30, MIN_W = 10;
const db = new DatabaseSync(SWAPS, { readOnly: true }); db.exec('PRAGMA busy_timeout=10000');
const now = Math.floor(Date.now() / 1000), t0 = Date.now();
// makers.maker is a BLOB: COUNT(DISTINCT) compares the bytes, so it counts wallets correctly without hexing
const rows = db.prepare(`SELECT p.token t, COUNT(DISTINCT m.maker) w, COUNT(*) n, SUM(CASE WHEN s.side > 0 THEN s.usd ELSE 0 END) b,
  SUM(CASE WHEN s.side < 0 THEN s.usd ELSE 0 END) se, MAX(s.ts) last
  FROM swaps s JOIN pools p ON p.pid = s.pid JOIN makers m ON m.tx = s.tx WHERE p.ok = 1 AND s.ts >= ? GROUP BY p.token`).all(now - DAYS * 86400);
const tokens = {};
for (const r of rows) {
  if (r.w < MIN_W) continue;
  const tot = (r.b || 0) + (r.se || 0);
  // gap = |buys - sells| / total: under 0.02 over a month is the wash fingerprint (a bot buying and selling the same amount)
  tokens[String(r.t).toLowerCase()] = { w: r.w, n: r.n, gap: tot > 0 ? +(Math.abs((r.b || 0) - (r.se || 0)) / tot).toFixed(4) : null, last: r.last * 1000 };
}
const tmp = OUT + '.tmp';
fs.writeFileSync(tmp, JSON.stringify({ asOf: Date.now(), days: DAYS, tokens }));
fs.renameSync(tmp, OUT);
console.log(`[alive] ${rows.length} pools' tokens read, ${Object.keys(tokens).length} with ${MIN_W}+ wallets in ${DAYS}d, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
