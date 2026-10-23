// One-time: merge the PRE-LAUNCH swap history (blocks before 21,068,653 / Sep 16, built on the owner PC by server/swap-indexer.ts
// into its own DB with SWAPS_START=1900000) into the live store. Owner 10-23: tokens deployed before Sep 16 (ARGUS at 18.8M —
// 1,247 of them) showed holders whose buys we never saw. Pools are matched by key (pids differ between the two DBs).
// Run on the VPS with statera-swaps STOPPED:
//   SWAPS_DB=/root/statera-swaps/swaps.db node … scripts/merge-prelaunch.ts /root/statera-swaps/prelaunch.db
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.SWAPS_DB!); db.exec('PRAGMA busy_timeout=15000');
db.exec(`ATTACH DATABASE '${process.argv[2].replace(/'/g, "''")}' AS x`);
const xBack = Number((db.prepare("SELECT v FROM x.meta WHERE k = 'back'").get() as { v: string }).v);
const xBackTs = (db.prepare("SELECT v FROM x.meta WHERE k = 'back_ts'").get() as { v: string } | undefined)?.v;
const ourBack = Number((db.prepare("SELECT v FROM meta WHERE k = 'back'").get() as { v: string }).v);
const maxX = (db.prepare('SELECT MAX(blk) b FROM x.swaps').get() as { b: number }).b;
if (maxX >= ourBack) throw new Error(`pre-launch DB reaches block ${maxX}, the store starts at ${ourBack} — overlap`);
console.log('pre-launch DB back to', xBack, 'max block', maxX, '· store starts at', ourBack);

db.exec('BEGIN');
try {
  // pools: keep ours; add the ones only the pre-launch DB knows (verified the same way — same indexer code)
  const add = db.prepare(`INSERT INTO pools(key, kind, venue, token, usdc0, dec, ok, why, at)
    SELECT key, kind, venue, token, usdc0, dec, ok, why, at FROM x.pools WHERE key NOT IN (SELECT key FROM pools)`).run();
  db.exec(`CREATE TEMP TABLE pmap AS SELECT y.pid xp, p.pid np FROM x.pools y JOIN pools p ON p.key = y.key`);
  db.exec('CREATE INDEX temp.pmap_x ON pmap(xp)');
  const v4 = db.prepare('INSERT OR IGNORE INTO v4init(pool, c0, c1, fee, ts, hooks, blk, spacing) SELECT pool, c0, c1, fee, ts, hooks, blk, spacing FROM x.v4init').run();
  const sw = db.prepare('INSERT OR IGNORE INTO swaps(blk, li, pid, ts, side, price, usd, amt, tx) SELECT s.blk, s.li, m.np, s.ts, s.side, s.price, s.usd, s.amt, s.tx FROM x.swaps s JOIN pmap m ON m.xp = s.pid').run();
  // minute candles: the pre-launch side ends before ours begins; the one minute both can hold is rebuilt from its swaps
  const c1 = db.prepare('INSERT OR IGNORE INTO c1m(pid, t, o, h, l, c, v, n) SELECT m.np, c.t, c.o, c.h, c.l, c.c, c.v, c.n FROM x.c1m c JOIN pmap m ON m.xp = c.pid').run();
  const edge = db.prepare('SELECT MIN(ts) t FROM swaps WHERE blk >= ?').get(ourBack) as { t: number };
  const tEdge = Math.floor(edge.t / 60) * 60;
  const rows = db.prepare('SELECT DISTINCT pid FROM swaps WHERE ts >= ? AND ts < ?').all(tEdge, tEdge + 60) as { pid: number }[];
  const mrow = db.prepare('SELECT price, usd FROM swaps WHERE pid = ? AND ts >= ? AND ts < ? ORDER BY blk, li');
  const up = db.prepare('INSERT INTO c1m(pid,t,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(pid,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v,n=excluded.n');
  for (const { pid } of rows) {
    const r = mrow.all(pid, tEdge, tEdge + 60) as { price: number; usd: number }[];
    let h = -Infinity, l = Infinity, v = 0; for (const x of r) { h = Math.max(h, x.price); l = Math.min(l, x.price); v += x.usd; }
    up.run(pid, tEdge, r[0].price, h, l, r[r.length - 1].price, v, r.length);
  }
  db.prepare("UPDATE meta SET v = ? WHERE k = 'back'").run(String(xBack));
  if (xBackTs) db.prepare("INSERT INTO meta(k, v) VALUES('back_ts', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(xBackTs);
  db.prepare("INSERT INTO meta(k, v) VALUES('prelaunch_merged', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now()));
  db.exec('COMMIT');
  console.log('MERGED new pools', add.changes, 'v4init', v4.changes, 'swaps', sw.changes, 'candles', c1.changes, 'edge minute pools', rows.length, '· store now starts at', xBack);
} catch (e) { db.exec('ROLLBACK'); throw e; }
