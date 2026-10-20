// Fill `makers` (tx → sender) for the swap history, newest block first. Swap events only name the router; the trader is the
// transaction's sender, and the public nodes have pruned their tx-by-hash index for older txs — so whole blocks are read
// (eth_getBlockByNumber with full txs, 10 blocks per batch) and every tx that is in `swaps` gets its sender recorded.
// Run where the RPCs aren't shared with the money bots (the owner's PC), then ship the rows with --export / --import:
//   SWAPS_DB=… node --disable-warning=ExperimentalWarning scripts/makers-backfill.ts            (resumable; cursor mk_back)
//   SWAPS_DB=… node … scripts/makers-backfill.ts --export makers.db --since <unix ms>          (rows added since → a small db)
//   SWAPS_DB=/root/statera-swaps/swaps.db node … scripts/makers-backfill.ts --import makers.db  (on the VPS: merge)
import { DatabaseSync } from 'node:sqlite';
import { openSwapDb, metaGet, metaSet, txToBlob, addrToBlob, SWAPS_DB } from '../server/swap-db.ts';

const RPCS = (process.env.MAKER_RPCS || 'https://rpc.mainnet.arc.io,https://arc.drpc.org').split(',');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const db = openSwapDb(false);

if (args[0] === '--export') {
  const out = args[1], since = Number(args[3] || 0);
  const x = new DatabaseSync(out); x.exec('CREATE TABLE IF NOT EXISTS makers (tx BLOB PRIMARY KEY, maker BLOB NOT NULL) WITHOUT ROWID;'); x.close();
  db.exec(`ATTACH DATABASE '${out.replace(/'/g, "''")}' AS x`);
  // makers has no timestamp; --since filters by the swap's block time (rows resolved for swaps after it)
  const n = db.prepare(`INSERT OR IGNORE INTO x.makers SELECT m.tx, m.maker FROM makers m ${since ? 'JOIN swaps s ON s.tx = m.tx WHERE s.ts >= ?' : ''}`).run(...(since ? [Math.floor(since / 1000)] : []));
  console.log('exported', n.changes); process.exit(0);
}
if (args[0] === '--import') {
  db.exec(`ATTACH DATABASE '${args[1].replace(/'/g, "''")}' AS x`);
  const n = db.prepare('INSERT OR IGNORE INTO makers SELECT tx, maker FROM x.makers').run();
  console.log('imported', n.changes, 'into', SWAPS_DB); process.exit(0);
}

let rr = 0;
async function batch(blocks: number[]): Promise<any[] | null> {
  for (let i = 0; i < 6; i++) {
    const url = RPCS[(rr++) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(blocks.map((b, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] }))) });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; }
      const j: any = await r.json();
      if (!Array.isArray(j) || j.some((x) => !x.result?.transactions)) { await sleep(500 * (i + 1)); continue; }
      return j.sort((a, b) => a.id - b.id).map((x) => x.result);
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

const nextBlocks = db.prepare('SELECT DISTINCT blk FROM swaps WHERE blk < ? ORDER BY blk DESC LIMIT 30');
const txsIn = db.prepare('SELECT DISTINCT s.tx FROM swaps s LEFT JOIN makers m ON m.tx = s.tx WHERE s.blk = ? AND m.tx IS NULL');
const ins = db.prepare('INSERT OR IGNORE INTO makers(tx, maker) VALUES(?, ?)');
let cursor = Number(metaGet(db, 'mk_back') || Number(metaGet(db, 'live') || 0) + 1);
let done = 0, t0 = Date.now(), lastLog = 0;
const START = cursor;
for (;;) {
  const blocks = (nextBlocks.all(cursor) as { blk: number }[]).map((r) => r.blk);
  if (!blocks.length) { console.log('makers backfill COMPLETE'); metaSet(db, 'mk_done', Date.now()); break; }
  const parts = [blocks.slice(0, 10), blocks.slice(10, 20), blocks.slice(20, 30)].filter((p) => p.length);
  const got = await Promise.all(parts.map(batch));
  if (got.some((g) => !g)) { console.log('batch failed, retrying'); await sleep(5000); continue; }
  db.exec('BEGIN');
  try {
    got.flat().forEach((blk: any) => {
      const n = Number(BigInt(blk.number));
      const want = new Set((txsIn.all(n) as { tx: Uint8Array }[]).map((r) => Buffer.from(r.tx).toString('hex')));
      for (const t of blk.transactions) if (want.has(t.hash.slice(2).toLowerCase())) { ins.run(txToBlob(t.hash), addrToBlob(t.from)); done++; }
    });
    cursor = blocks[blocks.length - 1];
    metaSet(db, 'mk_back', cursor);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (Date.now() - lastLog > 30_000) {
    lastLog = Date.now();
    const rate = (START - cursor) / ((Date.now() - t0) / 1000);
    console.log(new Date().toISOString().slice(11, 19), 'makers at block', cursor, 'resolved', done, `${Math.round(rate)} blocks/s span`);
  }
}
