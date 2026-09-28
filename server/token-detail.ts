// Token page data, computed on the VPS with the SAME functions the page ran in each visitor's browser (src/lib/arc.ts):
// pool stats, every pool, 24h stats + makers, burn, holders, trades (+ real wallets), transfers. One computation serves
// every visitor: fresh for 10 s, then served stale (up to 2 min) while a background refresh runs. v1 made each visitor's
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

// Stale copies are served for at most 2 min (the page re-asks ~7 s later and gets the refreshed one); older = compute now.
const FRESH_MS = 10_000, STALE_MS = 2 * 60_000, MAX_CACHED = 300;
const cache = new Map<string, TokenDetail>();
const inflight = new Map<string, Promise<TokenDetail>>();
let running = 0; const queue: (() => void)[] = [];
const MAX_PARALLEL = 2; // the public RPCs refuse ~30+ calls per burst — never compute many tokens at once
// A visitor's request goes to the FRONT of the queue; background pre-warm waits behind it (09-28: a cold visit right after
// a restart queued behind 8 pre-warm jobs, hit the page's 20 s deadline and fell back to scanning in the tab).
const slot = (urgent = true) => new Promise<void>((r) => { const go = () => { running++; r(); }; if (running < MAX_PARALLEL) go(); else if (urgent) queue.unshift(go); else queue.push(go); });
const release = () => { running--; const n = queue.shift(); if (n) n(); };
export const detailStats = { computed: 0, hits: 0, stale: 0, failed: 0, lastMs: 0 };

const settle = <T>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);

async function compute(address: string, seed: Token | undefined, urgent = true): Promise<TokenDetail> {
  await slot(urgent);
  const t0 = Date.now();
  try {
    // Same order and inputs as PremainDetail: prime the pool from the screener row, decimals from the row or the contract.
    if (seed && (seed.pool || seed.poolId)) primePool(address, { pool: seed.pool, poolId: seed.poolId, usdcIsC0: seed.usdcIsC0 });
    const dec = seed?.decimals ?? (await fetchTokenDecimals(address)) ?? 18;
    const [ocPool, ocPools, day, burn, holdersRaw, trades, txs] = await Promise.all([
      settle(fetchOnchainPoolStats(address, dec)), settle(fetchAllOnchainPools(address, dec)), settle(fetchOnchainDayStats(address, dec)),
      settle(fetchTokenBurn(address, dec)), settle(fetchTokenHolders(address, 100)), settle(fetchPoolTrades(address, dec, 40)),
      settle(fetchTokenTransfers(address, 18, 40)),
    ]);
    let dayStats: TokenDetail['dayStats'] = day;
    if (day) { const m = await settle(fetchOnchainMakers24(address)); if (m) dayStats = { ...day, makers24: m.makers, makersSample: m.sample, makersIsFloor: m.sample < m.total }; }
    const swaps = trades && trades.length ? (await settle(resolveMakers(trades.map((x) => ({ ...x }))))) ?? trades.map((x) => ({ ...x, trader: '' })) : trades;
    const holders = holdersRaw && holdersRaw.length ? holdersRaw.map((x) => ({ rank: x.rank, address: x.address, amount: x.balance, percent: x.share, isPool: x.isContract, isDeployer: false })) : null;
    const d: TokenDetail = { address, at: Date.now(), ms: Date.now() - t0, dec, ocPool, ocPools, dayStats, burn, holders, swaps, txs };
    cache.set(address, d); detailStats.computed++; detailStats.lastMs = d.ms;
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
export function prewarm(rows: Token[]) { for (const t of rows) refresh(t.address.toLowerCase(), t, false).catch(() => {}); }

// ── Chart candles: the page's own fetchPoolCandles, run here. The chart's timeframes only (sec → max lookback), so a
// request can't ask for an arbitrary scan. The wide views share one cached swap scan inside arc.ts (60 s).
const TF_LOOK: Record<number, number> = { 60: 6 * 3600, 300: 24 * 3600, 900: 3 * 86400, 3600: 3 * 86400, 14400: 12 * 86400, 86400: 60 * 86400, 21600: 9 * 86400, 43200: 3650 * 86400 };
export const candleTfOk = (sec: number, look: number) => TF_LOOK[sec] != null && look === TF_LOOK[sec];
const candleInflight = new Map<string, Promise<Candle[]>>();
export async function tokenCandles(address: string, seed: Token | undefined, sec: number, look: number): Promise<Candle[]> {
  const a = address.toLowerCase(), k = `${a}:${sec}:${look}`;
  let p = candleInflight.get(k);
  if (!p) {
    p = (async () => {
      await slot();
      try {
        const dec = seed?.decimals ?? cache.get(a)?.dec ?? (await fetchTokenDecimals(a)) ?? 18;
        if (seed && (seed.pool || seed.poolId)) primePool(a, { pool: seed.pool, poolId: seed.poolId, usdcIsC0: seed.usdcIsC0 });
        return await fetchPoolCandles(a, dec, sec, look);
      } finally { release(); }
    })().finally(() => candleInflight.delete(k));
    candleInflight.set(k, p);
  }
  return p;
}
setInterval(() => pruneChainCaches(), 60_000).unref();
