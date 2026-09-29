import fs from 'node:fs';
import path from 'node:path';
// Token page data, computed on the VPS with the SAME functions the page ran in each visitor's browser (src/lib/arc.ts):
// pool stats, every pool, 24h stats + makers, burn, holders, trades (+ real wallets), transfers. One computation serves
// every visitor: fresh for 10 s, then served stale (up to 30 min) while a background refresh runs. v1 made each visitor's
// tab do all of this itself: ~450–650 RPC calls and up to 15 MB of logs per token page.
import type { Token } from '../src/lib/rules.ts';
import {
  primePool, fetchTokenDecimals, fetchOnchainPoolStats, fetchAllOnchainPools, fetchOnchainDayStats, fetchOnchainMakers24,
  fetchTokenBurn, fetchTokenHolders, fetchPoolTrades, resolveMakers, fetchTokenTransfers, fetchPoolCandles, pruneChainCaches,
} from '../src/lib/arc.ts';
import type { Candle } from '../src/lib/warp.ts';

export interface TokenDetail {
  address: string; at: number; ms: number; dec: number;
  ocPool: Awaited<ReturnType<typeof fetchOnchainPoolStats>> | null;
  ocPools: Awaited<ReturnType<typeof fetchAllOnchainPools>> | null;
  dayStats: (Awaited<ReturnType<typeof fetchOnchainDayStats>> & { makers24?: number; makersSample?: number; makersIsFloor?: boolean }) | null;
  burn: Awaited<ReturnType<typeof fetchTokenBurn>> | null;
  holders: { rank: number; address: string; amount: number; percent: number | null; isPool: boolean; isDeployer: boolean }[] | null;
  swaps: Awaited<ReturnType<typeof fetchPoolTrades>> | null;
  txs: Awaited<ReturnType<typeof fetchTokenTransfers>> | null;
}

// A copy up to 90 min old is served INSTANTLY while a fresh one is computed behind it (the page re-reads every 10 s and
// swaps it in). 09-29 (owner: "token pages load very slow"): with a 2 min window almost every visit to a less-busy token
// waited 5–10 s for a full compute; the background warmer below keeps every listed token inside this window.
const FRESH_MS = 10_000, STALE_MS = 90 * 60_000, MAX_CACHED = 400; // 90 min: the warmer's full pass over ~110 listed tokens takes ~an hour
const cache = new Map<string, TokenDetail>();
const inflight = new Map<string, Promise<TokenDetail>>();
let running = 0; const queue: (() => void)[] = [];
const MAX_PARALLEL = 2; // the public RPCs refuse ~30+ calls per burst — never compute many tokens at once
// A visitor's request goes to the FRONT of the queue; background pre-warm waits behind it (09-28: a cold visit right after
// a restart queued behind 8 pre-warm jobs, hit the page's 20 s deadline and fell back to scanning in the tab).
const slot = (urgent = true) => new Promise<void>((r) => { const go = () => { running++; r(); }; if (running < MAX_PARALLEL) go(); else if (urgent) queue.unshift(go); else queue.push(go); });
const release = () => { running--; const n = queue.shift(); if (n) n(); };
export const detailStats = { computed: 0, hits: 0, stale: 0, failed: 0, partial: 0, lastMs: 0 };

const settle = <T>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);

async function compute(address: string, seed: Token | undefined, urgent = true): Promise<TokenDetail> {
  await slot(urgent);
  const t0 = Date.now();
  try {
    // Same order and inputs as PremainDetail: prime the pool from the screener row, decimals from the row or the contract.
    if (seed && (seed.pool || seed.poolId)) primePool(address, { pool: seed.pool, poolId: seed.poolId, usdcIsC0: seed.usdcIsC0 });
    const dec = seed?.decimals ?? (await fetchTokenDecimals(address)) ?? 18;
    // A visitor waiting → the trade scan stops going back after ~3.5 s; the full scan then runs in the background and
    // the page's 10 s re-read picks it up (09-29: cold pages took 5–20 s, one quiet token's empty 900k-block walk = 16 s).
    const tradeOpts: { deadline?: number; partial?: boolean } = urgent ? { deadline: t0 + 3500 } : {};
    // ⛔ makers24 must run AFTER the day stats: it samples the tx list fetchOnchainDayStats builds (dayTxList). 09-29 I ran
    // them in parallel to save ~2 s and makers came back empty on a first compute ("makers not loading on any" — GLITCH
    // dev). It now starts the moment the day stats land, still alongside the slower lookups.
    const dayP = settle(fetchOnchainDayStats(address, dec));
    const makersP = dayP.then((day) => (day ? settle(fetchOnchainMakers24(address)) : null));
    const [ocPool, ocPools, day, burn, holdersRaw, trades, txs, makers] = await Promise.all([
      settle(fetchOnchainPoolStats(address, dec)), settle(fetchAllOnchainPools(address, dec)), dayP,
      settle(fetchTokenBurn(address, dec)), settle(fetchTokenHolders(address, 100)), settle(fetchPoolTrades(address, dec, 40, tradeOpts)),
      settle(fetchTokenTransfers(address, 18, 40)), makersP,
    ]);
    let dayStats: TokenDetail['dayStats'] = day;
    if (day && makers) dayStats = { ...day, makers24: makers.makers, makersSample: makers.sample, makersIsFloor: makers.sample < makers.total };
    const swaps = trades && trades.length ? (await settle(resolveMakers(trades.map((x) => ({ ...x }))))) ?? trades.map((x) => ({ ...x, trader: '' })) : trades;
    const holders = holdersRaw && holdersRaw.length ? holdersRaw.map((x) => ({ rank: x.rank, address: x.address, amount: x.balance, percent: x.share, isPool: x.isContract, isDeployer: false })) : null;
    const d: TokenDetail = { address, at: Date.now(), ms: Date.now() - t0, dec, ocPool, ocPools, dayStats, burn, holders, swaps, txs };
    cache.set(address, d); detailStats.computed++; detailStats.lastMs = d.ms;
    if (tradeOpts.partial) { detailStats.partial++; setTimeout(() => refresh(address, seed, false).catch(() => {}), 0); }
    if (cache.size > MAX_CACHED) { const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) cache.delete(oldest[0]); }
    return d;
  } catch (e) { detailStats.failed++; throw e; }
  finally { release(); }
}

function refresh(address: string, seed: Token | undefined, urgent = true): Promise<TokenDetail> {
  let p = inflight.get(address);
  if (!p) { p = compute(address, seed, urgent).finally(() => inflight.delete(address)); inflight.set(address, p); }
  return p;
}

/** Fresh (≤20 s) or stale-while-revalidate (≤10 min) from cache; otherwise computed now (coalesced per token). */
export async function tokenDetail(address: string, seed: Token | undefined): Promise<TokenDetail> {
  const a = address.toLowerCase(), c = cache.get(a);
  if (c && Date.now() - c.at < FRESH_MS) { detailStats.hits++; return c; }
  if (c && Date.now() - c.at < STALE_MS) { detailStats.stale++; refresh(a, seed, false).catch(() => {}); return c; }
  return refresh(a, seed);
}
/** Keep the busiest token pages warm so their first visitor never waits. */
export function prewarm(rows: Token[]) {
  rows.forEach((t, i) => {
    refresh(t.address.toLowerCase(), t, false).catch(() => {});
    // ⛔ 09-28: pre-building ALL for 8 tokens OOM-killed the API (a ~12-day pool scan holds its raw logs in memory) — top 3
    // only; any other token's full history is built on first view and cached 5 min.
    if (i >= 3) return;
    // the heavy ALL view (the one that 502'd cold), so the busiest tokens' full-history charts open instantly
    buildCandles(t.address.toLowerCase(), t, 43200, 3650 * 86400, `${t.address.toLowerCase()}:43200:${3650 * 86400}`).catch(() => {});
  });
}

// ── Chart candles: the page's own fetchPoolCandles, run here. The chart's timeframes only (sec → max lookback), so a
// request can't ask for an arbitrary scan. The wide views share one cached swap scan inside arc.ts (60 s).
const TF_LOOK: Record<number, number> = { 60: 6 * 3600, 300: 24 * 3600, 900: 3 * 86400, 3600: 3 * 86400, 14400: 12 * 86400, 86400: 60 * 86400, 21600: 9 * 86400, 43200: 3650 * 86400 };
export const candleTfOk = (sec: number, look: number) => TF_LOOK[sec] != null && look === TF_LOOK[sec];
const candleInflight = new Map<string, Promise<Candle[]>>();
// Wide views (4H and up: 12k–900k-block scans) are cached here for 5 min and served stale while they refresh — the 09-28
// audit caught the ALL view 502ing on a cold scan (the page then re-scanned in the visitor's tab). Fine views: 20 s.
const candleCache = new Map<string, { at: number; c: Candle[] }>();
export async function tokenCandles(address: string, seed: Token | undefined, sec: number, look: number): Promise<Candle[]> {
  const a = address.toLowerCase(), k = `${a}:${sec}:${look}`;
  const ttl = sec >= 14400 ? 5 * 60_000 : 20_000, hit = candleCache.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.c;
  // stale-while-revalidate: up to 30 min for every timeframe (the page re-reads and gets the refreshed candles)
  if (hit && Date.now() - hit.at < Math.max(ttl * 6, STALE_MS)) { buildCandles(a, seed, sec, look, k).catch(() => {}); return hit.c; }
  return buildCandles(a, seed, sec, look, k);
}
function buildCandles(a: string, seed: Token | undefined, sec: number, look: number, k: string): Promise<Candle[]> {
  let p = candleInflight.get(k);
  if (!p) {
    p = (async () => {
      await slot();
      try {
        const dec = seed?.decimals ?? cache.get(a)?.dec ?? (await fetchTokenDecimals(a)) ?? 18;
        if (seed && (seed.pool || seed.poolId)) primePool(a, { pool: seed.pool, poolId: seed.poolId, usdcIsC0: seed.usdcIsC0 });
        const c = await fetchPoolCandles(a, dec, sec, look);
        if (c.length) { candleCache.set(k, { at: Date.now(), c }); if (candleCache.size > 600) candleCache.delete(candleCache.keys().next().value!); }
        return c;
      } finally { release(); }
    })().finally(() => candleInflight.delete(k));
    candleInflight.set(k, p);
  }
  return p;
}
setInterval(() => pruneChainCaches(), 60_000).unref();

// ── Background warmer (09-29) ── every listed token's page (detail + the default 5m/24h chart) is kept inside the 30 min
// stale window, one token at a time and only while no visitor is waiting — the public RPC's burst limit is shared.
const DEFAULT_TF: [number, number] = [300, 86400];
let warming = false;
export async function warmNext(rows: Token[]) {
  // a free slot and nobody queued (09-29: waiting for running === 0 never happened — the top tokens' ALL-chart scans hold a
  // slot for minutes — so it warmed 1 token in 10 min). A warm token is served from memory and needs no slot at all.
  if (warming || running >= MAX_PARALLEL || queue.length) return;
  const now = Date.now();
  let pick: Token | null = null, oldest = Infinity;
  for (const t of rows) {
    const a = t.address.toLowerCase(), at = cache.get(a)?.at ?? 0;
    if (inflight.has(a) || now - at < 10 * 60_000) continue;
    if (at < oldest) { oldest = at; pick = t; }
  }
  if (!pick) return;
  warming = true;
  const a = pick.address.toLowerCase();
  try {
    await refresh(a, pick, false);
    const [sec, look] = DEFAULT_TF, k = `${a}:${sec}:${look}`, c = candleCache.get(k);
    if (!c || now - c.at > 10 * 60_000) await buildCandles(a, pick, sec, look, k).catch(() => {});
    warmStats.warmed++;
  } catch { /* next tick */ } finally { warming = false; }
}
export const warmStats = { warmed: 0, restored: 0 };

// Survive restarts/deploys: the caches are written every 5 min and read back at start (a deploy used to make every page cold).
const CACHE_FILE = process.env.DETAIL_STATE || '/root/statera-api-state/detail-cache.json';
export function saveCaches() {
  try {
    const small = [...candleCache.entries()].filter(([k]) => k.endsWith(`:${DEFAULT_TF[0]}:${DEFAULT_TF[1]}`));
    const body = JSON.stringify({ v: 1, detail: [...cache.entries()], candles: small });
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE + '.tmp', body); fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch { /* next time */ }
}
export function loadCaches() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j?.v !== 1) return;
    const cutoff = Date.now() - STALE_MS;
    for (const [k, v] of j.detail || []) if (v?.at > cutoff) { cache.set(k, v); warmStats.restored++; }
    for (const [k, v] of j.candles || []) if (v?.at > cutoff) candleCache.set(k, v);
  } catch { /* first run */ }
}
