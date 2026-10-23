// One-time (owner PC): credit every historical swap to the wallet that really bought / sold (server/swap-owners.ts) and record
// how holders got tokens without a swap — for every token that has a holder index. Reads a compact export of the VPS store
// (scripts/owners-backfill.ts --export, run there), scans each token's Transfer events from its deploy block to the export
// block on the archive RPCs, writes positions + acquisitions to an output DB that the VPS imports (--import).
//   VPS: SWAPS_DB=/root/statera-swaps/swaps.db node … scripts/owners-backfill.ts --export /root/statera-swaps/owners-src.db
//   PC:  node … scripts/owners-backfill.ts --run owners-src.db owners-out.db        (resumable: finished tokens are skipped)
//   VPS: SWAPS_DB=… node … scripts/owners-backfill.ts --import owners-out.db        (indexer stopped)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { attribute, addPos, xferOf, PM_V4, T_TRANSFER, type Pos, type Swap } from '../server/swap-owners.ts';

const [mode, A, B] = process.argv.slice(2);
const hexOf = (b: Uint8Array | null) => (b ? '0x' + Buffer.from(b).toString('hex') : null);

if (mode === '--export') {
  // tokens with a holder index (the ones whose cards use balances) and at least one swap; their swaps with the sender
  const SRC = process.env.SWAPS_DB!, HD = process.env.HOLDERS_DIR || '/root/statera-api-state/holders';
  const db = new DatabaseSync(SRC, { readOnly: true });
  if (fs.existsSync(A)) fs.unlinkSync(A);
  const out = new DatabaseSync(A);
  out.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE toks (token TEXT PRIMARY KEY, start INTEGER, pools TEXT, n INTEGER);
    CREATE TABLE s (token TEXT, blk INTEGER, li INTEGER, ts INTEGER, side INTEGER, usd REAL, amt REAL, tx BLOB, maker BLOB);`);
  const upto = Number((db.prepare("SELECT v FROM meta WHERE k = 'live'").get() as { v: string }).v);
  out.prepare("INSERT INTO meta VALUES ('upto', ?)").run(String(upto));
  const poolQ = db.prepare('SELECT pid, key FROM pools WHERE token = ? AND ok = 1');
  const swQ = db.prepare('SELECT s.blk, s.li, s.ts, s.side, s.usd, s.amt, s.tx, m.maker FROM swaps s LEFT JOIN makers m ON m.tx = s.tx WHERE s.pid = ? AND s.blk <= ?');
  const insT = out.prepare('INSERT INTO toks VALUES (?,?,?,?)'), insS = out.prepare('INSERT INTO s VALUES (?,?,?,?,?,?,?,?,?)');
  let nt = 0, ns = 0;
  out.exec('BEGIN');
  for (const f of fs.readdirSync(HD)) {
    if (!/^0x[0-9a-f]{40}\.json$/.test(f)) continue;
    const t = f.slice(0, -5);
    let start: number; try { start = Number(JSON.parse(fs.readFileSync(`${HD}/${f}`, 'utf8')).start); } catch { continue; }
    const pools = poolQ.all(t) as { pid: number; key: string }[]; if (!pools.length || !start) continue;
    let n = 0;
    for (const p of pools) for (const r of swQ.all(p.pid, upto) as any[]) { insS.run(t, r.blk, r.li, r.ts, r.side, r.usd, r.amt, r.tx, r.maker); n++; }
    if (!n) continue;
    insT.run(t, start, JSON.stringify(pools.map((p) => p.key.toLowerCase()).filter((k) => k.length === 42)), n); nt++; ns += n;
    if (nt % 500 === 0) { out.exec('COMMIT'); out.exec('BEGIN'); console.log('tokens', nt, 'swaps', ns); }
  }
  out.exec('COMMIT');
  out.exec('CREATE INDEX s_blk ON s(blk)');
  console.log('EXPORT DONE tokens', nt, 'swaps', ns, 'upto', upto); process.exit(0);
}

if (mode === '--import') {
  // trader_pos for these tokens replaced by owner-credited positions; the indexer's owner loop continues from `upto`
  const db = new DatabaseSync(process.env.SWAPS_DB!); db.exec('PRAGMA busy_timeout=15000');
  db.exec(`CREATE TABLE IF NOT EXISTS acq (token TEXT NOT NULL, wallet BLOB NOT NULL, flags INTEGER NOT NULL, PRIMARY KEY (token, wallet)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS owner_tokens (token TEXT PRIMARY KEY);`);
  db.exec(`ATTACH DATABASE '${A.replace(/'/g, "''")}' AS x`);
  const upto = (db.prepare("SELECT v FROM x.meta WHERE k = 'upto'").get() as { v: string }).v;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM trader_pos WHERE token IN (SELECT token FROM x.done)');
    const a = db.prepare('INSERT INTO trader_pos(token, maker, bought, sold, qb, qs, nb, ns, first, last) SELECT token, owner, bought, sold, qb, qs, nb, ns, first, last FROM x.pos').run();
    db.exec('DELETE FROM acq WHERE token IN (SELECT token FROM x.done)');
    const b = db.prepare('INSERT INTO acq SELECT token, wallet, flags FROM x.acq').run();
    const c = db.prepare('INSERT OR IGNORE INTO owner_tokens SELECT token FROM x.done').run();
    db.prepare("INSERT INTO meta(k, v) VALUES('owner_cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(upto);
    db.exec('COMMIT');
    console.log('imported positions', a.changes, 'acq', b.changes, 'tokens', c.changes, 'owner_cursor', upto);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  process.exit(0);
}

if (mode !== '--run') { console.log('usage: --export OUT | --run SRC OUT | --import OUT'); process.exit(1); }
// ── --run (PC) ──
const src = new DatabaseSync(A, { readOnly: true });
const out = new DatabaseSync(B);
out.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS pos (token TEXT, owner BLOB, bought REAL, sold REAL, qb REAL, qs REAL, nb INTEGER, ns INTEGER, first INTEGER, last INTEGER);
  CREATE TABLE IF NOT EXISTS acq (token TEXT, wallet BLOB, flags INTEGER);
  CREATE TABLE IF NOT EXISTS done (token TEXT PRIMARY KEY);`);
const upto = Number((src.prepare("SELECT v FROM meta WHERE k = 'upto'").get() as { v: string }).v);
out.prepare("INSERT OR REPLACE INTO meta VALUES ('upto', ?)").run(String(upto));
const done = new Set((out.prepare('SELECT token FROM done').all() as { token: string }[]).map((r) => r.token));
const toks = (src.prepare('SELECT token, start, pools, n FROM toks ORDER BY start').all() as { token: string; start: number; pools: string; n: number }[]).filter((t) => !done.has(t.token));
console.log('tokens to do', toks.length, 'upto', upto);

// archive logs: tenderly takes 95k-block ranges (until it 429s us), arc.io 10k; every node caps a reply at 20k logs
const TEN = 'https://arc.gateway.tenderly.co', ARC = 'https://rpc.mainnet.arc.io';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tenBlockedUntil = 0, calls = 0;
class Big extends Error {}
async function getLogs(addrs: string[], lo: number, hi: number): Promise<any[]> {
  let last = '';
  for (let i = 0; i < 30; i++) {
    const useTen = Date.now() > tenBlockedUntil, url = useTen ? TEN : ARC;
    if (!useTen && hi - lo + 1 > 10_000) throw new Big();
    try {
      calls++;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(40_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: addrs, topics: [T_TRANSFER], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }] }) });
      if (r.status === 429) { last = url + ' 429'; if (useTen) tenBlockedUntil = Date.now() + 10 * 60_000; await sleep(2000 * Math.min(i + 1, 8)); continue; }
      const j: any = await r.json();
      if (j.result) return j.result;
      const m = String(j.error?.message || '');
      last = url + ' ' + m.slice(0, 80);
      if (/rate/i.test(m)) { if (useTen) tenBlockedUntil = Date.now() + 10 * 60_000; await sleep(2000 * Math.min(i + 1, 8)); continue; }
      if (/range|results|too many|exceed/i.test(m)) throw new Big();
    } catch (e) { if (e instanceof Big) throw e; last = url + ' ' + String((e as Error).message).slice(0, 80); }
    await sleep(1000 * Math.min(i + 1, 8));
  }
  throw new Error('getLogs failed ' + lo + '-' + hi + ': ' + last);
}
const swQ = src.prepare('SELECT token, blk, li, ts, side, usd, amt, tx, maker FROM s WHERE blk BETWEEN ? AND ?');
const insP = out.prepare('INSERT INTO pos VALUES (?,?,?,?,?,?,?,?,?,?)'), insA = out.prepare('INSERT INTO acq VALUES (?,?,?)'), insD = out.prepare('INSERT OR IGNORE INTO done VALUES (?)');
const blob = (a: string) => Buffer.from(a.slice(2), 'hex');

// batches: tokens in deploy order, up to 300 addresses / 400k swaps each (the busiest tokens end up nearly alone)
const batches: (typeof toks)[] = [];
for (let i = 0, cur: typeof toks = [], n = 0; i < toks.length; i++) {
  cur.push(toks[i]); n += toks[i].n;
  if (cur.length >= 300 || n >= 400_000 || i === toks.length - 1) { batches.push(cur); cur = []; n = 0; }
}
const t0 = Date.now(); let swapsDone = 0, bi = 0;
for (const batch of batches) {
  bi++;
  const set = new Map(batch.map((t) => [t.token, t])), addrs = batch.map((t) => t.token);
  const pools = new Map(batch.map((t) => [t.token, new Set<string>([PM_V4, ...JSON.parse(t.pools)])]));
  const pos = new Map(batch.map((t) => [t.token, new Map<string, Pos>()])), acq = new Map(batch.map((t) => [t.token, new Map<string, number>()]));
  let lo = Math.min(...batch.map((t) => t.start)), span = 95_000;
  while (lo <= upto) {
    const hi = Math.min(upto, lo + span - 1);
    let logs: any[];
    try { logs = await getLogs(addrs, lo, hi); }
    catch (e) { if (e instanceof Big && span > 1) { span = Math.max(1, Math.floor(span / 2)); continue; } throw e; }
    // whole blocks only, so every tx's transfers are together
    const xs = new Map<string, ReturnType<typeof xferOf>[]>(), sw = new Map<string, Swap[]>();
    for (const l of logs) { const t = l.address.toLowerCase(); if (!set.has(t)) continue; const x = xferOf(l); if (!x) continue; (xs.get(t) ?? xs.set(t, []).get(t)!).push(x); }
    for (const r of swQ.all(lo, hi) as any[]) { if (!set.has(r.token)) continue; (sw.get(r.token) ?? sw.set(r.token, []).get(r.token)!).push({ tx: hexOf(r.tx)!, side: r.side, usd: r.usd, amt: r.amt, ts: r.ts, maker: hexOf(r.maker) }); }
    for (const t of new Set([...xs.keys(), ...sw.keys()])) {
      const P = pos.get(t)!, Q = acq.get(t)!;
      attribute(sw.get(t) || [], (xs.get(t) || []) as any, pools.get(t)!, (o, s) => { addPos(P, o, s); swapsDone++; }, (w, f) => Q.set(w, (Q.get(w) || 0) | f));
    }
    lo = hi + 1;
    span = logs.length > 12_000 ? Math.max(1, Math.floor(span / 2)) : logs.length < 4_000 ? Math.min(Date.now() > tenBlockedUntil ? 95_000 : 10_000, Math.floor(span * 1.6) + 1) : span;
  }
  out.exec('BEGIN');
  for (const t of batch) {
    for (const [o, p] of pos.get(t.token)!) insP.run(t.token, blob(o), p.bought, p.sold, p.qb, p.qs, p.nb, p.ns, p.first, p.last);
    for (const [w, f] of acq.get(t.token)!) insA.run(t.token, blob(w), f);
    insD.run(t.token);
  }
  out.exec('COMMIT');
  const el = (Date.now() - t0) / 1000;
  console.log(new Date().toISOString().slice(11, 19), `batch ${bi}/${batches.length} tokens ${batch.length} swaps credited ${swapsDone} calls ${calls} ${Math.round(el)}s${Date.now() < tenBlockedUntil ? ' (tenderly paused)' : ''}`);
}
console.log('COMPLETE swaps credited', swapsDone, 'calls', calls);
