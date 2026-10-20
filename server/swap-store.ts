// swap-store — the API's READ side of the swap store (server/swap-db.ts, filled by server/swap-indexer.ts).
// Serves the token chart (every timeframe, all history, paged backwards), the trade history, and a wallet's own trades.
// Read-only: if the DB is missing (indexer not deployed yet) every function returns null and the API keeps its old path.
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openSwapDb, SWAPS_DB, metaGet, txToBlob, blobToTx } from './swap-db.ts';

let db: DatabaseSync | null = null, triedAt = 0;
function conn(): DatabaseSync | null {
  if (db) return db;
  if (Date.now() - triedAt < 30_000) return null;
  triedAt = Date.now();
  try { if (!fs.existsSync(SWAPS_DB)) return null; db = openSwapDb(true); return db; } catch { db = null; return null; }
}

// Timeframes the chart offers (seconds per candle). 1W = weekly candles aligned to Monday 00:00 UTC.
export const RES: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const WEEK_OFFSET = 4 * 86400; // unix 0 was a Thursday → +4 days puts week buckets on Mondays
const bucketOf = (t: number, sec: number) => (sec === 604800 ? Math.floor((t - WEEK_OFFSET) / sec) * sec + WEEK_OFFSET : Math.floor(t / sec) * sec);

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
type PoolInfo = { pid: number; venue: string; kind: string; vol: number; first: number; last: number };

// Which pools of a token feed its chart. ⛔ Anyone can open a decoy pool for a pair (GLITCH had 11 V4 pools) and print
// any price on it with a few cents; a pool counts only when it carries ≥1% of the token's all-time USD volume (and $25).
const poolCache = new Map<string, { at: number; v: PoolInfo[] }>();
function poolsOf(token: string): PoolInfo[] {
  const d = conn(); if (!d) return [];
  const t = token.toLowerCase(), hit = poolCache.get(t);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const rows = d.prepare('SELECT pid, venue, kind FROM pools WHERE token=? AND ok=1').all(t) as { pid: number; venue: string; kind: string }[];
  const st = d.prepare('SELECT COALESCE(SUM(v),0) vol, MIN(t) first, MAX(t) last FROM c1m WHERE pid=?');
  const all = rows.map((r) => { const s = st.get(r.pid) as { vol: number; first: number | null; last: number | null }; return { ...r, vol: s.vol, first: s.first ?? 0, last: s.last ?? 0 }; }).filter((p) => p.last > 0);
  const total = all.reduce((s, p) => s + p.vol, 0);
  const v = all.filter((p) => p.vol >= Math.max(25, total * 0.01)).sort((a, b) => b.vol - a.vol);
  poolCache.set(t, { at: Date.now(), v });
  if (poolCache.size > 3000) poolCache.delete(poolCache.keys().next().value!);
  return v;
}

export function coverage() {
  const d = conn(); if (!d) return null;
  const n = (k: string) => { const v = metaGet(d, k); return v == null ? null : Number(v); };
  return { backTs: n('back_ts'), backBlock: n('back'), liveBlock: n('live'), liveAt: n('live_at'), backDone: n('back_done') != null };
}

// Candles for `token` at `res`, the newest `limit` buckets ending before `before` (unix s; default = now).
// Per bucket: OHLC from the pool that traded the most USD in it (pools are arbitraged together, and one pool's own path is
// a real price path — mixing the swaps of several pools would draw their tiny offsets as wicks); volume = every counted pool.
// Each candle opens at the previous close (no gaps between candles); a bucket without trades is a flat 0-volume candle.
// A token quiet for the whole window gets the window that ends at its last trade instead of an empty chart.
const barCache = new Map<string, { at: number; v: unknown }>();
export function candles(token: string, resKey: string, limit = 1000, before?: number) {
  const d = conn(); if (!d) return null;
  const sec = RES[resKey]; if (!sec) return null;
  const ck = `${token}:${resKey}:${limit}:${before ?? ''}`, hit = barCache.get(ck);
  if (hit && Date.now() - hit.at < (before ? 120_000 : 5_000)) return hit.v;
  const pools = poolsOf(token);
  const cov = coverage();
  if (!pools.length) return { res: resKey, candles: [], hasMore: false, first: null, pools: [], coverage: cov };
  const pids = pools.map((p) => p.pid), first = Math.min(...pools.map((p) => p.first)), lastTrade = Math.max(...pools.map((p) => p.last));
  const now = Math.floor(Date.now() / 1000);
  let end = bucketOf(Math.min(before ?? now, now), sec) + (before ? 0 : sec);
  if (!before && lastTrade < end - limit * sec) end = bucketOf(lastTrade, sec) + sec; // quiet token: end at its last trade
  const start = Math.max(bucketOf(first, sec), end - limit * sec);
  const q = `SELECT pid, t, o, h, l, c, v, n FROM c1m WHERE pid IN (${pids.map(() => '?').join(',')}) AND t >= ? AND t < ? ORDER BY t`;
  const rows = d.prepare(q).all(...pids, start, end) as { pid: number; t: number; o: number; h: number; l: number; c: number; v: number; n: number }[];
  // the close just before the window, so the first candle opens where the previous one closed
  const prevQ = `SELECT c FROM c1m WHERE pid IN (${pids.map(() => '?').join(',')}) AND t < ? ORDER BY t DESC LIMIT 1`;
  const prevRow = d.prepare(prevQ).get(...pids, start) as { c: number } | undefined;
  type Acc = { o: number; h: number; l: number; c: number; v: number; n: number };
  const buckets = new Map<number, { per: Map<number, Acc>; v: number; n: number }>();
  for (const r of rows) {
    const b = bucketOf(r.t, sec);
    let B = buckets.get(b); if (!B) { B = { per: new Map(), v: 0, n: 0 }; buckets.set(b, B); }
    B.v += r.v; B.n += r.n;
    const a = B.per.get(r.pid);
    if (!a) B.per.set(r.pid, { o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, n: r.n });
    else { if (r.h > a.h) a.h = r.h; if (r.l < a.l) a.l = r.l; a.c = r.c; a.v += r.v; a.n += r.n; }
  }
  const out: Bar[] = [];
  let prev: number | null = prevRow ? prevRow.c : null;
  for (let t = start; t < end; t = sec === 604800 ? t + sec : t + sec) {
    const B = buckets.get(t);
    if (B) {
      let best: Acc | null = null;
      for (const a of B.per.values()) if (!best || a.v > best.v || (a.v === best.v && a.n > best.n)) best = a;
      const open = prev ?? best!.o;
      out.push({ time: t, open, high: Math.max(best!.h, open), low: Math.min(best!.l, open), close: best!.c, volume: B.v, trades: B.n });
      prev = best!.c;
    } else if (prev != null) out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0, trades: 0 });
  }
  const v = { res: resKey, candles: out, hasMore: start > bucketOf(first, sec), first, lastTrade,
    pools: pools.map((p) => ({ venue: p.venue, kind: p.kind, vol: Math.round(p.vol) })), coverage: cov };
  barCache.set(ck, { at: Date.now(), v });
  if (barCache.size > 2000) barCache.delete(barCache.keys().next().value!);
  return v;
}

// Trade history of a token from the store, newest first, older pages by `before` (unix s) — past the server's 24h list.
export function trades(token: string, limit = 100, before?: number, side?: 'buy' | 'sell', minUsd = 0) {
  const d = conn(); if (!d) return null;
  const pools = poolsOf(token); if (!pools.length) return { trades: [], hasMore: false };
  const venue = new Map(pools.map((p) => [p.pid, p.venue]));
  const pids = pools.map((p) => p.pid);
  const q = `SELECT blk, li, pid, ts, side, price, usd, amt, tx FROM swaps WHERE pid IN (${pids.map(() => '?').join(',')}) AND ts < ?${side ? ' AND side = ?' : ''}${minUsd > 0 ? ' AND usd >= ?' : ''} ORDER BY ts DESC, blk DESC, li DESC LIMIT ?`;
  const args: (number | string)[] = [...pids, before ?? 4e9];
  if (side) args.push(side === 'buy' ? 1 : -1);
  if (minUsd > 0) args.push(minUsd);
  args.push(limit + 1);
  const rows = d.prepare(q).all(...args) as { blk: number; li: number; pid: number; ts: number; side: number; price: number; usd: number; amt: number; tx: Uint8Array }[];
  return { hasMore: rows.length > limit, trades: rows.slice(0, limit).map((r) => ({ side: r.side > 0 ? 'buy' : 'sell', usd: r.usd, amount: r.amt, price: r.price,
    tx: blobToTx(r.tx), time: r.ts * 1000, block: r.blk, logIndex: r.li, venue: venue.get(r.pid) })) };
}

// Every swap inside the given transactions (a wallet's own tx list from server/wallet-index.ts) — for the chart's B/S markers,
// the position strip and the Portfolio P&L. `token` narrows it to one token. Only pools with ok=1 (verified USDC pools).
export function swapsInTxs(txs: string[], token?: string) {
  const d = conn(); if (!d) return null;
  const want = [...new Set(txs.filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h)).map((h) => h.toLowerCase()))];
  const out: { token: string; side: 'buy' | 'sell'; usd: number; amount: number; price: number; tx: string; ts: number; block: number; logIndex: number; venue: string }[] = [];
  const tok = token?.toLowerCase();
  for (let i = 0; i < want.length; i += 400) {
    const part = want.slice(i, i + 400);
    const q = `SELECT s.blk, s.li, s.ts, s.side, s.price, s.usd, s.amt, s.tx, p.token, p.venue FROM swaps s JOIN pools p ON p.pid = s.pid
      WHERE s.tx IN (${part.map(() => '?').join(',')})${tok ? ' AND p.token = ?' : ''}`;
    const rows = d.prepare(q).all(...part.map(txToBlob), ...(tok ? [tok] : [])) as any[];
    for (const r of rows) out.push({ token: r.token, side: r.side > 0 ? 'buy' : 'sell', usd: r.usd, amount: r.amt, price: r.price, tx: blobToTx(r.tx), ts: r.ts, block: r.blk, logIndex: r.li, venue: r.venue });
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return out;
}

export function storeStats() {
  const d = conn(); if (!d) return { ok: false };
  try {
    const n = d.prepare('SELECT COUNT(*) n FROM pools WHERE ok=1').get() as { n: number };
    return { ok: true, pools: n.n, ...coverage() };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
