// One-time (owner PC): tick spacing + tick profile + current reserves for every USDC pool with ≥ $100 of volume in 30 days, into a
// small export DB that the VPS imports (scripts/reserves-backfill.ts --import). The VPS can't read old Initialize logs (tenderly
// 429s it; blockdaemon is pruned), and the first full V4 profile pass is ~20k reads — so it runs here, like the swap history.
//   SWAPS_DB=~/bt/statera-swaps-data/swaps.db node … scripts/reserves-backfill.ts --out reserves-export.db
//   SWAPS_DB=/root/statera-swaps/swaps.db     node … scripts/reserves-backfill.ts --import reserves-export.db
import { DatabaseSync } from 'node:sqlite';
import { initReserveTables, refreshReserves } from '../server/swap-reserves.ts';
import { encAggregate3, decAggregate3 } from './lib/multicall.mjs';

const args = process.argv.slice(2), SRC = process.env.SWAPS_DB!;
if (args[0] === '--import') {
  const db = new DatabaseSync(SRC); db.exec('PRAGMA busy_timeout=15000');
  initReserveTables(db);
  db.exec(`ATTACH DATABASE '${args[1].replace(/'/g, "''")}' AS x`);
  const a = db.prepare('UPDATE v4init SET spacing = (SELECT spacing FROM x.v4init y WHERE y.pool = v4init.pool) WHERE spacing IS NULL AND pool IN (SELECT pool FROM x.v4init WHERE spacing IS NOT NULL)').run();
  const b = db.prepare('INSERT OR REPLACE INTO v4profile SELECT * FROM x.v4profile').run();
  const c = db.prepare('INSERT OR REPLACE INTO reserves SELECT * FROM x.reserves').run();
  const fromBlk = (db.prepare("SELECT v FROM x.meta WHERE k = 'from_block'").get() as { v: string } | undefined)?.v;
  if (fromBlk) db.prepare("INSERT INTO meta(k, v) VALUES('prof_from', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(fromBlk);
  console.log('imported spacing', a.changes, 'profiles', b.changes, 'reserves', c.changes, 'prof_from', fromBlk); process.exit(0);
}
const OUT = args[1] || 'reserves-export.db';
const src = new DatabaseSync(SRC, { readOnly: true });
const out = new DatabaseSync(OUT);
out.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS pools (pid INTEGER PRIMARY KEY, key TEXT, kind TEXT, venue TEXT, token TEXT, usdc0 INTEGER, dec INTEGER, ok INTEGER);
  CREATE TABLE IF NOT EXISTS v4init (pool TEXT PRIMARY KEY, c0 TEXT, c1 TEXT, fee INTEGER, ts INTEGER, hooks TEXT, blk INTEGER);
  CREATE TABLE IF NOT EXISTS swaps (pid INTEGER, ts INTEGER, price REAL);`);
initReserveTables(out);
const RPCS = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'], ARCH = ['https://arc.gateway.tenderly.co', 'https://rpc.mainnet.arc.io'];
let rr = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(urls: string[], m: string, p: unknown[]) {
  for (let i = 0; i < 10; i++) {
    try { const r = await fetch(urls[rr++ % urls.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(25000) });
      const j: any = await r.json(); if (!j.error && j.result != null) return j.result; } catch { /* */ }
    await sleep(400 * (i + 1));
  }
  throw new Error(m + ' failed');
}
const mc = async (calls: { target: string; data: string }[]) => { const o: string[] = []; for (let i = 0; i < calls.length; i += 150) o.push(...decAggregate3(await rpc(RPCS, 'eth_call', [{ to: '0xcA11bde05977b3631167028862bE2a173976CA11', data: encAggregate3(calls.slice(i, i + 150)) }, 'latest']))); return o; };
const deps = { mc, log: console.log, logsAt: async (f: Record<string, unknown>, b: number) => { const r = await rpc(ARCH, 'eth_getLogs', [{ ...f, fromBlock: '0x' + b.toString(16), toBlock: '0x' + b.toString(16) }]).catch(() => []); return Array.isArray(r) ? r : []; } };

const head = parseInt(await rpc(RPCS, 'eth_blockNumber', []), 16);
out.prepare("INSERT INTO meta(k, v) VALUES('from_block', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(head));
const t30 = Math.floor(Date.now() / 1000) - 30 * 86400;
const want = src.prepare('SELECT p.pid, p.key, p.kind, p.venue, p.token, p.usdc0, p.dec, p.ok FROM pools p JOIN (SELECT pid, SUM(v) v FROM c1m WHERE t >= ? GROUP BY pid) c ON c.pid = p.pid WHERE p.ok = 1 AND c.v >= 100').all(t30) as any[];
const insP = out.prepare('INSERT OR REPLACE INTO pools VALUES (?,?,?,?,?,?,?,?)'), insI = out.prepare('INSERT OR IGNORE INTO v4init(pool,c0,c1,fee,ts,hooks,blk) VALUES (?,?,?,?,?,?,?)');
const iniQ = src.prepare('SELECT * FROM v4init WHERE pool = ?');
out.exec('BEGIN');
for (const p of want) { insP.run(p.pid, p.key, p.kind, p.venue, p.token, p.usdc0, p.dec, p.ok); if (p.kind === 'V4') { const i = iniQ.get(p.key) as any; if (i) insI.run(i.pool, i.c0, i.c1, i.fee, i.ts, i.hooks, i.blk); } }
out.exec('COMMIT');
const done = new Set((out.prepare('SELECT pid FROM reserves').all() as { pid: number }[]).map((r) => r.pid));
const todo = want.map((p) => p.pid).filter((p) => !done.has(p));
console.log('pools', want.length, 'to do', todo.length, 'head', head);
let k = 0, n = 0; const t0 = Date.now();
await Promise.all([0, 1, 2].map(async (w) => {
  for (;;) {
    const i = k; k += 25; if (i >= todo.length) return;
    try { n += await refreshReserves(out, deps, todo.slice(i, i + 25), new Set()); } catch (e) { console.log('chunk', i, (e as Error).message); }
    if ((i / 25) % 8 === 0) console.log(new Date().toISOString().slice(11, 19), 'done', Math.min(todo.length, i + 25), '/', todo.length, 'measured', n, Math.round((Date.now() - t0) / 1000) + 's');
  }
}));
console.log('COMPLETE measured', n, 'of', todo.length);
