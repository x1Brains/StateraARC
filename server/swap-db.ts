// swap-db — the permanent swap store (SQLite, node:sqlite). Written ONLY by server/swap-indexer.ts (its own unit,
// statera-swaps.service); statera-api opens it read-only for the chart / trades / wallet-trade endpoints.
// One row per on-chain Swap of a USDC-paired pool (Uniswap V3 / V2 forks / V4 singleton / Aerodrome + Archery CL),
// with the REAL block timestamp (Arc logs carry blockTimestamp) — candles no longer drift like the old estimate did.
//   pools  — every pool/poolId the indexer has seen; ok=1 only for a verified factory pool (or a V4 pool) paired with USDC
//   swaps  — the raw trades (price = USDC per token after the swap, usd = the USDC leg, amt = token amount, side 1 buy / -1 sell)
//   c1m    — 1-minute OHLCV per pool, rebuilt from `swaps` whenever a minute gets a new swap; every timeframe is derived from it
//   v4init — V4 Initialize events (poolId → currencies), so a V4 swap can be priced and attributed
//   meta   — cursors (back = lowest block indexed, live = highest) + counters
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SWAPS_DB = process.env.SWAPS_DB || '/root/statera-swaps/swaps.db';
export const USDC = '0x3600000000000000000000000000000000000000';
// First block with a Uniswap deployment on Arc mainnet (V3 swaps start at 1,948,019, V4 at 1,948,056).
export const START_BLOCK = Number(process.env.SWAPS_START || 1_948_000);

export function openSwapDb(readonly = false): DatabaseSync {
  if (!readonly) fs.mkdirSync(path.dirname(SWAPS_DB), { recursive: true });
  const db = new DatabaseSync(SWAPS_DB, readonly ? { readOnly: true } : {});
  if (readonly) { db.exec('PRAGMA query_only=1; PRAGMA cache_size=-32000;'); return db; }
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32000;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS pools (pid INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, kind TEXT, venue TEXT,
      token TEXT, usdc0 INTEGER, dec INTEGER, ok INTEGER NOT NULL DEFAULT 0, why TEXT, at INTEGER);
    CREATE INDEX IF NOT EXISTS pools_token ON pools(token);
    CREATE TABLE IF NOT EXISTS v4init (pool TEXT PRIMARY KEY, c0 TEXT, c1 TEXT, fee INTEGER, ts INTEGER, hooks TEXT, blk INTEGER);
    CREATE TABLE IF NOT EXISTS swaps (blk INTEGER NOT NULL, li INTEGER NOT NULL, pid INTEGER NOT NULL, ts INTEGER NOT NULL,
      side INTEGER NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, amt REAL NOT NULL, tx BLOB NOT NULL,
      PRIMARY KEY (blk, li)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS swaps_pid_ts ON swaps(pid, ts);
    CREATE INDEX IF NOT EXISTS swaps_tx ON swaps(tx);
    CREATE TABLE IF NOT EXISTS c1m (pid INTEGER NOT NULL, t INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, n INTEGER,
      PRIMARY KEY (pid, t)) WITHOUT ROWID;
  `);
  return db;
}

export const txToBlob = (h: string) => Buffer.from(h.slice(2), 'hex');
export const blobToTx = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
export function metaGet(db: DatabaseSync, k: string): string | null {
  const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k) as { v: string } | undefined;
  return r ? r.v : null;
}
export function metaSet(db: DatabaseSync, k: string, v: string | number) {
  db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}
