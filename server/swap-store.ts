// swap-store — the API's READ side of the swap store (server/swap-db.ts, filled by server/swap-indexer.ts).
// Serves the token chart (every timeframe, all history, paged backwards), the trade history, and a wallet's own trades.
// Read-only: if the DB is missing (indexer not deployed yet) every function returns null and the API keeps its old path.
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openSwapDb, SWAPS_DB, metaGet, txToBlob, blobToTx, addrToBlob } from './swap-db.ts';

let db: DatabaseSync | null = null, triedAt = 0;
function conn(): DatabaseSync | null {
  if (db) return db;
  if (Date.now() - triedAt < 30_000) return null;
  triedAt = Date.now();
  try { if (!fs.existsSync(SWAPS_DB)) return null; db = openSwapDb(true); return db; } catch { db = null; return null; }
}
// `makers` arrives with a newer indexer — an older DB doesn't have it yet: wallet columns are then null / empty, never an error
let makersAt = 0, makersOk = false;
function hasMakers(d: DatabaseSync): boolean {
  if (Date.now() - makersAt > 60_000) { makersAt = Date.now(); makersOk = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='makers'").get(); }
  return makersOk;
}

// Timeframes the chart offers (seconds per candle). 1W = weekly candles aligned to Monday 00:00 UTC.
// 1M = calendar months (UTC), so its "seconds" value is only a nominal size; bucketOf / step handle it exactly.
export const RES: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2592000 };
const WEEK_OFFSET = 4 * 86400; // unix 0 was a Thursday → +4 days puts week buckets on Mondays
const MONTH = 2592000;
const bucketOf = (t: number, sec: number) => {
  if (sec === MONTH) { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  return sec === 604800 ? Math.floor((t - WEEK_OFFSET) / sec) * sec + WEEK_OFFSET : Math.floor(t / sec) * sec;
};
// the bucket `k` steps after (k < 0: before) bucket b
const step = (b: number, sec: number, k = 1) => { if (sec !== MONTH) return b + k * sec; const d = new Date(b * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1) / 1000; };

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
type PoolInfo = { pid: number; venue: string; kind: string; vol: number; n: number; first: number; last: number };

// Which pools of a token feed its chart. ⛔ Anyone can open a decoy pool for a pair (GLITCH had 11 V4 pools) and print
// any price on it with a few cents. ⛔ USD volume alone is fakeable too (a "cirBTC" copy showed $156M over 124 swaps —
// one wallet trading huge size against itself); every trade costs gas, so the trade COUNT is the harder signal.
// A pool counts when it has ≥3 trades and ≥1% of the token's trades or ≥1% of its USD volume (and ≥$25).
const poolCache = new Map<string, { at: number; v: PoolInfo[] }>();
function poolsOf(token: string): PoolInfo[] {
  const d = conn(); if (!d) return [];
  const t = token.toLowerCase(), hit = poolCache.get(t);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const rows = d.prepare('SELECT pid, venue, kind FROM pools WHERE token=? AND ok=1').all(t) as { pid: number; venue: string; kind: string }[];
  const st = d.prepare('SELECT COALESCE(SUM(v),0) vol, COALESCE(SUM(n),0) n, MIN(t) first, MAX(t) last FROM c1m WHERE pid=?');
  const all = rows.map((r) => { const s = st.get(r.pid) as { vol: number; n: number; first: number | null; last: number | null }; return { ...r, vol: s.vol, n: s.n, first: s.first ?? 0, last: s.last ?? 0 }; }).filter((p) => p.last > 0);
  const total = all.reduce((s, p) => s + p.vol, 0), totalN = all.reduce((s, p) => s + p.n, 0);
  const v = all.filter((p) => p.n >= 3 && (p.n >= totalN * 0.01 || p.vol >= Math.max(25, total * 0.01))).sort((a, b) => b.n - a.n);
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
// Per bucket: OHLC from the token's MAIN pool (see the loop below for the side-pool rule) (pools are arbitraged together, and one pool's own path is
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
  let end = before ? bucketOf(Math.min(before, now), sec) : step(bucketOf(now, sec), sec);
  if (!before && lastTrade < step(end, sec, -limit)) end = step(bucketOf(lastTrade, sec), sec); // quiet token: end at its last trade
  const start = Math.max(bucketOf(first, sec), step(end, sec, -limit));
  const q = `SELECT pid, t, o, h, l, c, v, n FROM c1m WHERE pid IN (${pids.map(() => '?').join(',')}) AND t >= ? AND t < ? ORDER BY t`;
  const rows = d.prepare(q).all(...pids, start, end) as { pid: number; t: number; o: number; h: number; l: number; c: number; v: number; n: number }[];
  // the close just before the window, so the first candle opens where the previous one closed
  const pq = d.prepare('SELECT t, c FROM c1m WHERE pid = ? AND t < ? ORDER BY t DESC LIMIT 1');
  const mainPid = pools.reduce((a, b) => (b.vol > a.vol ? b : a)).pid; // pools are eligible (decoys out) — the deepest by USD
  // the close before the window: the main pool's (a side pool's last print can be off-market), else the newest of any pool
  let prevRow = pq.get(mainPid, start) as { t: number; c: number } | undefined;
  if (!prevRow) for (const pid of pids) { const r = pq.get(pid, start) as { t: number; c: number } | undefined; if (r && (!prevRow || r.t > prevRow.t)) prevRow = r; }
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
  for (let t = start; t < end; t = step(t, sec)) {
    const B = buckets.get(t);
    if (B) {
      // ⛔ 10-21 owner ("this wick doesn't look real"): ARGUS printed $0.0132 vs $0.0075 — 3 trades, $12, in one of its 9 small
      // side pools while the main pools were quiet, and "most trades in the bucket" picked it. Now: the MAIN pool (most all-time
      // USD) whenever it traded in the bucket; otherwise the busiest side pool, but only if its close is within 12% of the
      // previous close — a thin pool's off-market print becomes a flat candle (its volume still counts).
      let best: Acc | null = B.per.get(mainPid) ?? null;
      if (!best) {
        for (const a of B.per.values()) if (!best || a.v > best.v || (a.v === best.v && a.n > best.n)) best = a;
        if (best && prev != null && Math.abs(best.c / prev - 1) > 0.12) best = null;
      }
      if (best) {
        const open = prev ?? best.o;
        out.push({ time: t, open, high: Math.max(best.h, open), low: Math.min(best.l, open), close: best.c, volume: B.v, trades: B.n });
        prev = best.c;
      } else if (prev != null) out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: B.v, trades: B.n });
    } else if (prev != null) out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0, trades: 0 });
  }
  const v = { res: resKey, candles: out, hasMore: start > bucketOf(first, sec), first, lastTrade,
    pools: pools.map((p) => ({ venue: p.venue, kind: p.kind, vol: Math.round(p.vol) })), coverage: cov };
  barCache.set(ck, { at: Date.now(), v });
  if (barCache.size > 2000) barCache.delete(barCache.keys().next().value!);
  return v;
}

// Trade history of a token from the store, newest first, older pages by `before` (unix s) — any age. Each row carries its
// maker (the tx sender, from `makers`; null until resolved). Filters: side, min USD, one maker.
type Row = { blk: number; li: number; pid: number; ts: number; side: number; price: number; usd: number; amt: number; tx: Uint8Array; maker: Uint8Array | null };
const rowOut = (venue: Map<number, string>) => (r: Row) => ({ side: r.side > 0 ? 'buy' : 'sell', usd: r.usd, amount: r.amt, price: r.price,
  tx: blobToTx(r.tx), time: r.ts * 1000, block: r.blk, logIndex: r.li, venue: venue.get(r.pid), trader: r.maker ? blobToTx(r.maker) : null });
export function trades(token: string, limit = 100, before?: number, side?: 'buy' | 'sell', minUsd = 0, maker?: string) {
  const d = conn(); if (!d) return null;
  const pools = poolsOf(token); if (!pools.length) return { trades: [], hasMore: false };
  const venue = new Map(pools.map((p) => [p.pid, p.venue]));
  const pids = pools.map((p) => p.pid), ph = pids.map(() => '?').join(',');
  if (maker && !hasMakers(d)) return { trades: [], hasMore: false };
  const MJ = hasMakers(d) ? 'LEFT JOIN makers m ON m.tx = s.tx' : '', MC = hasMakers(d) ? 'm.maker' : 'NULL AS maker';
  // ⛔ 10-21: "WHERE pid IN (...) ORDER BY ts DESC, blk DESC, li DESC LIMIT n" made SQLite read and SORT every trade of the
  // token (cirBTC 677k rows: 15 s; even one-pool ARCOON 5 s — the extra sort keys defeat the index). The live feed asked every
  // 4 s and froze the whole API (10-21 outage). Now each pool's newest rows come straight off its (pid, ts) index (ORDER BY ts
  // only, LIMIT n+1 each) and are merged here; one wallet starts from its own txs (makers index).
  const f = `${side ? ' AND s.side = ?' : ''}${minUsd > 0 ? ' AND s.usd >= ?' : ''}`;
  const extra: number[] = []; if (side) extra.push(side === 'buy' ? 1 : -1); if (minUsd > 0) extra.push(minUsd);
  let rows: Row[] = [];
  if (maker) {
    rows = d.prepare(`SELECT s.blk, s.li, s.pid, s.ts, s.side, s.price, s.usd, s.amt, s.tx, m.maker FROM makers m JOIN swaps s ON s.tx = m.tx
      WHERE m.maker = ? AND s.pid IN (${ph}) AND s.ts < ?${f} LIMIT 5000`).all(addrToBlob(maker), ...pids, before ?? 4e9, ...extra) as Row[];
  } else {
    const one = d.prepare(`SELECT s.blk, s.li, s.pid, s.ts, s.side, s.price, s.usd, s.amt, s.tx, ${MC} FROM swaps s ${MJ}
      WHERE s.pid = ? AND s.ts < ?${f} ORDER BY s.ts DESC LIMIT ?`);
    for (const pid of pids) rows.push(...(one.all(pid, before ?? 4e9, ...extra, limit + 1) as Row[]));
  }
  rows.sort((a, b) => b.ts - a.ts || b.blk - a.blk || b.li - a.li);
  return { hasMore: rows.length > limit, trades: rows.slice(0, limit).map(rowOut(venue)) };
}

// the newest close across the pools — each pool's last row off its (pid, t) key, not a sort of all their rows
const lastPrice = (d: DatabaseSync, pids: number[]) => {
  const q = d.prepare('SELECT t, c FROM c1m WHERE pid = ? ORDER BY t DESC LIMIT 1');
  let best: { t: number; c: number } | null = null;
  for (const pid of pids) { const r = q.get(pid) as { t: number; c: number } | undefined; if (r && (!best || r.t > best.t)) best = r; }
  return best ? best.c : null;
};
const aggCache = new Map<string, { at: number; v: unknown }>();
function cached<T>(k: string, ms: number, f: () => T): T {
  const h = aggCache.get(k); if (h && Date.now() - h.at < ms) return h.v as T;
  const v = f(); aggCache.set(k, { at: Date.now(), v }); if (aggCache.size > 1500) aggCache.delete(aggCache.keys().next().value!);
  return v;
}

// Money flow: buy vs sell pressure over 1H / 24H / 7D — counts, USD, net, the biggest single buy/sell, distinct buyers/sellers
// and the wallet that bought (sold) the most net. Wallet numbers cover the trades whose maker is known (`makersKnown`).
export function flow(token: string) {
  const d = conn(); if (!d) return null;
  const pools = poolsOf(token); if (!pools.length) return { windows: [] };
  return cached('flow:' + token, 30_000, () => {
    const pids = pools.map((p) => p.pid), ph = pids.map(() => '?').join(','), now = Math.floor(Date.now() / 1000);
    const windows = [['1h', 3600], ['24h', 86400], ['7d', 604800]].map(([k, sec]) => {
      const from = now - (sec as number);
      const sides = d.prepare(`SELECT side, COUNT(*) n, COALESCE(SUM(usd),0) usd, COALESCE(MAX(usd),0) big FROM swaps WHERE pid IN (${ph}) AND ts >= ? GROUP BY side`).all(...pids, from) as { side: number; n: number; usd: number; big: number }[];
      const b = sides.find((x) => x.side > 0), s2 = sides.find((x) => x.side < 0);
      const w = !hasMakers(d) ? [] : d.prepare(`SELECT m.maker w, SUM(CASE WHEN s.side > 0 THEN s.usd ELSE -s.usd END) net, SUM(s.side > 0) nb, SUM(s.side < 0) ns, COUNT(*) n
        FROM swaps s JOIN makers m ON m.tx = s.tx WHERE s.pid IN (${ph}) AND s.ts >= ? GROUP BY m.maker`).all(...pids, from) as { w: Uint8Array; net: number; nb: number; ns: number; n: number }[];
      let top: typeof w[number] | null = null, bot: typeof w[number] | null = null, known = 0;
      for (const x of w) { known += x.n; if (!top || x.net > top.net) top = x; if (!bot || x.net < bot.net) bot = x; }
      const total = (b?.n ?? 0) + (s2?.n ?? 0);
      return { window: k, buys: b?.n ?? 0, sells: s2?.n ?? 0, buyUsd: b?.usd ?? 0, sellUsd: s2?.usd ?? 0, net: (b?.usd ?? 0) - (s2?.usd ?? 0),
        biggestBuy: b?.big ?? 0, biggestSell: s2?.big ?? 0, buyers: w.filter((x) => x.nb > 0).length, sellers: w.filter((x) => x.ns > 0).length,
        topBuyer: top && top.net > 0 ? { wallet: blobToTx(top.w), net: top.net } : null, topSeller: bot && bot.net < 0 ? { wallet: blobToTx(bot.w), net: bot.net } : null,
        makersKnown: total ? known / total : null };
    });
    return { windows };
  });
}

// Every wallet that traded the token (maker known), with average-cost P&L: realized = sold USD − avg buy × qty sold (only up
// to what it bought — tokens that came in by transfer have no known cost), open = what it still holds from its own trades
// marked to the last price. Shared by Top traders and Holder profitability. Cached 5 min (a busy token is ~1 s to build).
type Trader = { wallet: string; bought: number; sold: number; qtyBought: number; qtySold: number; buys: number; sells: number; first: number; last: number;
  avgBuy: number | null; held: number; realized: number; unrealized: number; pnl: number; roi: number | null };
function tradersOf(token: string): { list: Trader[]; price: number | null; coverage: number | null } | null {
  const d = conn(); if (!d) return null;
  const pools = poolsOf(token); if (!pools.length) return { list: [], price: null, coverage: null };
  return cached('traders:' + token, 5 * 60_000, () => {
    const pids = pools.map((p) => p.pid), ph = pids.map(() => '?').join(',');
    // running totals per wallet (trader_pos — built once by scripts/traders-build.ts, kept current by the indexer); the old
    // GROUP BY over swaps ⨝ makers took > 60 s on a busy token once the 12.3M-row maker history was in
    const pos = (() => { try { return d.prepare('SELECT maker, bought, sold, qb, qs, nb, ns, first, last FROM trader_pos WHERE token = ?').all(token.toLowerCase()) as
      { maker: Uint8Array; bought: number; sold: number; qb: number; qs: number; nb: number; ns: number; first: number; last: number }[]; } catch { return []; } })();
    const all = (d.prepare(`SELECT COALESCE(SUM(n), 0) n FROM c1m WHERE pid IN (${ph})`).get(...pids) as { n: number }).n;
    const price = lastPrice(d, pids);
    const by = new Map<string, Trader>();
    let known = 0;
    for (const r of pos) {
      known += r.nb + r.ns;
      const k = blobToTx(r.maker);
      by.set(k, { wallet: k, bought: r.bought, sold: r.sold, qtyBought: r.qb, qtySold: r.qs, buys: r.nb, sells: r.ns, first: r.first, last: r.last, avgBuy: null, held: 0, realized: 0, unrealized: 0, pnl: 0, roi: null });
    }
    for (const t of by.values()) {
      t.avgBuy = t.qtyBought > 0 ? t.bought / t.qtyBought : null;
      const matched = Math.min(t.qtySold, t.qtyBought);
      t.realized = t.avgBuy != null && t.qtySold > 0 ? t.sold * (matched / t.qtySold) - t.avgBuy * matched : 0;
      t.held = Math.max(0, t.qtyBought - t.qtySold);
      t.unrealized = t.avgBuy != null && price != null ? t.held * (price - t.avgBuy) : 0;
      t.pnl = t.realized + t.unrealized;
      t.roi = t.bought >= 1 ? (t.pnl / t.bought) * 100 : null;
    }
    return { list: [...by.values()], price, coverage: all ? known / all : null };
  });
}
export function topTraders(token: string, sort: 'pnl' | 'volume' | 'loss' = 'pnl', limit = 50) {
  const r = tradersOf(token); if (!r) return null;
  const list = [...r.list].filter((t) => t.avgBuy != null);
  list.sort(sort === 'volume' ? (a, b) => (b.bought + b.sold) - (a.bought + a.sold) : sort === 'loss' ? (a, b) => a.pnl - b.pnl : (a, b) => b.pnl - a.pnl);
  return { price: r.price, coverage: r.coverage, traders: list.length, rows: list.slice(0, limit) };
}
// Holder profitability: wallets that still hold from their own buys — how many (and how much of what they hold) are above
// their average entry, the median entry, and how entries spread around today's price.
export function profitability(token: string) {
  const r = tradersOf(token); if (!r) return null;
  const holders = r.list.filter((t) => t.held > 0 && t.avgBuy != null && t.avgBuy > 0);
  if (!holders.length || r.price == null) return { price: r.price, coverage: r.coverage, holders: 0 };
  const px = r.price;
  const inProfit = holders.filter((t) => px > t.avgBuy!);
  const heldAll = holders.reduce((s, t) => s + t.held, 0), heldUp = inProfit.reduce((s, t) => s + t.held, 0);
  const entries = holders.map((t) => t.avgBuy!).sort((a, b) => a - b);
  const median = entries[Math.floor(entries.length / 2)];
  // entry spread: share of holders by entry vs today's price
  const bands = [[0, 0.5, '≤ −50%'], [0.5, 0.8, '−50…−20%'], [0.8, 1, '−20…0%'], [1, 1.25, '0…+25%'], [1.25, 2, '+25…+100%'], [2, Infinity, '> +100%']] as const;
  const dist = bands.map(([lo, hi, label]) => {
    // a holder's position vs now: price / entry. ≥ 1 = in profit
    const n = holders.filter((t) => { const x = px / t.avgBuy!; return x >= lo && x < hi; }).length;
    return { label, holders: n, pct: (n / holders.length) * 100 };
  });
  return { price: px, coverage: r.coverage, holders: holders.length, inProfit: inProfit.length, pctHolders: (inProfit.length / holders.length) * 100,
    pctSupply: heldAll > 0 ? (heldUp / heldAll) * 100 : null, medianEntry: median, avgEntry: holders.reduce((s, t) => s + t.avgBuy! * t.held, 0) / heldAll, dist };
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

// Real reserves of a token's pools (server/swap-reserves.ts) — the token page's pools card and its Liquidity stat
export function poolReserves(token: string) {
  const d = conn(); if (!d) return null;
  try {
    return (d.prepare(`SELECT p.key, p.kind, p.venue, r.usdc, r.tok, r.px, r.at FROM pools p JOIN reserves r ON r.pid = p.pid WHERE p.token = ? AND p.ok = 1`).all(token.toLowerCase()) as
      { key: string; kind: string; venue: string; usdc: number; tok: number; px: number | null; at: number }[]).map((r) => {
        const side = Math.max(0, r.tok) * (r.px && isFinite(r.px) ? r.px : 0), u = Math.max(0, r.usdc);
        return { ...r, liq: u + Math.min(side, u * 3) };
      });
  } catch { return null; } // no reserves table yet
}

export function storeStats() {
  const d = conn(); if (!d) return { ok: false };
  try {
    const n = d.prepare('SELECT COUNT(*) n FROM pools WHERE ok=1').get() as { n: number };
    const day = new Date().toISOString().slice(0, 10), today = metaGet(d, 'day:' + day);
    return { ok: true, pools: n.n, ...coverage(), today: today ? { day, ...JSON.parse(today) } : null, tstatsAt: Number(metaGet(d, 'tstats_at') || 0) || null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ── Screener numbers from the store: computed by the indexer (server/swap-stats.ts → table tstats, every ~2 min, so the
// 2-second scan never blocks this API) and read here in one quick query.
export interface StoreTokenStats { volume24h?: number; txns24?: number; change1h?: number | null; change24h?: number | null; spark?: number[]; price?: number | null; liq?: number; liqUsdc?: number; liqPools?: number; hi7?: number | null; supply?: number; burned?: number }
let tsCache: { at: number; built: number; map: Map<string, StoreTokenStats> } | null = null;
export function tokenStatsNow(): Map<string, StoreTokenStats> | null {
  const d = conn(); if (!d) return null;
  if (tsCache && Date.now() - tsCache.at < 60_000) return Date.now() - tsCache.built < 10 * 60_000 ? tsCache.map : null;
  try {
    const built = Number(metaGet(d, 'tstats_at') || 0);
    if (!tsCache || tsCache.built !== built) {
      const rows = d.prepare('SELECT token, j FROM tstats').all() as { token: string; j: string }[];
      tsCache = { at: Date.now(), built, map: new Map(rows.map((r) => [r.token, JSON.parse(r.j)])) };
    } else tsCache.at = Date.now();
  } catch { return null; } // table not there yet (older indexer)
  return Date.now() - tsCache.built < 10 * 60_000 ? tsCache.map : null;
}
