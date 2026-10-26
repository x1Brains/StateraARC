// statera-api — the v2 data service (VPS x1b-prod, :8790, Tailscale funnel path /v2, key-gated like holdings-svc).
// Does ONCE, for every visitor, what each browser tab did on its own in v1: load the indexer snapshot, re-price the top
// on-chain rows from their pools, overlay RadarDEX (gap-filler) + deep-pool prices, then compute the board. Uses the
// SAME code as the browser (src/lib/rules.ts, live.ts, board.ts) — Node 22 runs TypeScript by stripping types.
//   node server/statera-api.ts        (systemd: server/statera-api.service)
// Endpoints (all GET, JSON):
//   /v2/health                        freshness + counters
//   /v2/home                          market stats, dashboard tabs, legend, counts
//   /v2/board?filter&q&sort&dir&dups&inactive&page&per   one page of the screener + totals
//   /v2/search?q&limit                hero typeahead
//   /v2/token/<addr>                  one row (with pool keys for the token page)
//   /v2/token/<addr>/detail           the token page's chain data (stats, pools, 24h, trades, holders…), cached per token
//   /v2/token/<addr>/candles?sec&look the chart (the page's own timeframes only)
//   /v2/tokens?addrs=a,b,…            rows for a set of addresses (portfolio pricing)
//   /v2/swap-tokens                   the swap picker list
//   /v2/chain                         Arc network: block time, TPS, fees, validators (block producers), CCTP flows, supplies
//   /v2/activity                      what the chain is doing: block tape, USDC issued/burned/moved, active + new wallets, per-protocol activity
//   /v2/lending                       Morpho Blue markets + Aave V4 Hub assets (supplied / borrowed), read on chain
//   /v2/where                         where USDC / EURC / cirBTC supply sits: lending, DEX pools, Gateway, contracts, wallets
//   /v2/list                          the whole live list (v1-compatible shape: { generatedAt, tokens })
//   /v2/token/<addr>/bars?res&limit&before    chart candles from the swap store (1m…1w, all history, paged backwards)
//   /v2/token/<addr>/history?limit&before&side&min   the token's trades from the swap store, any age
//   /v2/wallet/<addr>/swaps?token     every swap in the wallet's own transactions (B/S markers, position, P&L)
//   /v2/token/<addr>/flow | traders?sort=pnl|volume|loss | profitability   money flow, top traders, holder profitability
import http from 'node:http';
import fs from 'node:fs';
import { encAggregate3, decAggregate3 } from '../scripts/lib/multicall.mjs';
import zlib from 'node:zlib';
import { PINNED, sanitizeToken, type Token } from '../src/lib/rules.ts';
import * as Live from '../src/lib/live.ts';
import * as Board from '../src/lib/board.ts';
import { indexHolders, indexStats, indexBatch, batchStats, holderCountOf } from './holder-index.ts';
import { walletTransfers, walletSaved, walletStats, relayStats, lastError as walletLastError, blockTimes, NATIVE_LOG } from './wallet-index.ts';
import { cacheStats, tokenDetail, tokenTrades, prewarm, detailStats, tokenCandles, candleTfOk, warmNext, warmStats, saveCaches, loadCaches } from './token-detail.ts';
import { pollChain, chainSummary, chainStats, backfillStep, flowsBackfillStep, saveChain, loadChain } from './chain.ts';
import { refreshLending, lendingSummary, lendingStats } from './lending.ts';
import * as Swaps from './swap-store.ts';
import { activitySummary, activityStats, saveActivity, loadActivity, activityBackfillStep } from './activity.ts';
import { swapCall, poolStats } from './swap-worker.ts';
import { refreshWhere, whereSummary, whereStats } from './where.ts';

const PORT = Number(process.env.PORT || 8790);
const SNAP = process.env.SNAPSHOT_FILE || '/root/statera-live/tokens-snapshot.json';
const KEY_FILE = process.env.KEY_FILE || '/root/holdings-svc/key';
const RADAR = process.env.RADAR_RELAY || 'http://127.0.0.1:8787';
const RADAR_KEY_FILE = process.env.RADAR_KEY_FILE || '/root/radar-relay/key';
const readKey = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const KEY = readKey(KEY_FILE), RADAR_KEY = readKey(RADAR_KEY_FILE);
// Same schedule the v1 browser ran: full reload + top-60 re-price every 60 s, RadarDEX + deep-pool overlay every 40 s.
const LOAD_MS = 60_000, LIVE_MS = 40_000;

// ── RPC: rotate the same three nodes the browser uses; retry on 429/5xx/JSON error ──────────────────────────────────
// Order matters on this box: its IP is shared with the holdings service, the indexer and other services, and on 09-28 arc.io,
// tenderly and quicknode were rate-limiting it while drpc + blockdaemon answered — those go first.
const RPCS = ['https://arc.drpc.org', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rr = 0;
async function rpc(method: string, params: unknown[], tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rr++) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(7000) });
      if (r.status === 429 || r.status >= 500) { await sleep(150 * (i + 1) + Math.random() * 200); continue; }
      const j: any = await r.json();
      if (j.error) { await sleep(120 * (i + 1)); continue; }
      return j.result;
    } catch { await sleep(150 * (i + 1)); }
  }
  return null;
}
const call: Live.Call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
// A JSON-RPC batch (the chain follower reads ≤ 40 blocks per call); rotates nodes, retries the whole batch.
// Its own node pool: the VPS IP also carries holdings, the indexer and other services, and tenderly rate-limits it (09-28),
// so the follower spreads over the four that accept batches from here.
const BATCH_RPCS = ['https://arc.drpc.org', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'];
let br = 0;
async function rpcBatch(calls: [string, unknown[]][], tries = 5): Promise<any[]> {
  for (let i = 0; i < tries; i++) {
    const url = BATCH_RPCS[(br++) % BATCH_RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))), signal: AbortSignal.timeout(10000) });
      if (r.status === 429 || r.status >= 500) { await sleep(300 * (i + 1)); continue; }
      const j: any = await r.json();
      if (!Array.isArray(j) || j.some((x) => x.error)) { await sleep(300 * (i + 1)); continue; }
      return j.sort((a: any, b: any) => a.id - b.id).map((x: any) => x.result);
    } catch { await sleep(300 * (i + 1)); }
  }
  throw new Error('rpc batch failed');
}

async function radarTokens(limit = 500): Promise<Token[]> {
  if (!RADAR_KEY) return [];
  try {
    const r = await fetch(`${RADAR}/tokens?limit=${limit}`, { headers: { 'x-relay-key': RADAR_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    if (!r.ok || !text || text.trimStart()[0] === '<') return [];
    const j = JSON.parse(text);
    const arr: any[] = j.tokens || j || [];
    return arr.map(Live.radarRow).filter((t) => /^0x[0-9a-f]{40}$/.test(t.address));
  } catch { return []; }
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface View { tokens: Token[]; ix: Board.BoardIndex; home: any; homeGz: Buffer; homeJson: string; list: string; listGz: Buffer; swap: string; swapGz: Buffer; byAddr: Map<string, Token> }
let tokens: Token[] = [];
// The snapshot's OWN price/change24h/mcap/liq/volume24h per token, before the live overlays (10-14). The share card
// (lib/livetoken.js) rescales change24h + mcap by live/list price — that math needs the price those numbers were built
// against; the overlays move price (and, on indexer rows, the rest) without rescaling. 5 numbers, not the raw rows:
// this service runs near its 700M cap.
let listNums = new Map<string, (number | null)[]>();
let generatedAt: string | null = null, snapMtime = 0, asOf: number | null = null;
let view: View | null = null;
const stats = { loads: 0, loadFails: 0, onchainPriced: 0, liveRuns: 0, radarRows: 0, deepPriced: 0, lastLoad: 0, lastOnchain: 0, lastLive: 0, requests: 0 };

// USD price of a token from the live on-chain list (USDC = 1). Defined up here: the HTTP server answers during startup.
const USDC_ADDR = '0x3600000000000000000000000000000000000000';
const priceOf = (t: string) => { const a = t.toLowerCase(); if (a === USDC_ADDR) return 1; const r = view?.byAddr.get(a); return r && r.price != null && isFinite(r.price) ? r.price : null; };
const slimRow = (t: Token) => t; // rows go out whole: the page renders every field it had in v1
function rebuild() {
  // A row with no holder count yet takes it from our own holder index (10-06, owner: "why can't you find TIDE?" — TIDE was
  // indexed at 235 holders, but its snapshot row said unknown until the next indexer pass, so the board's 50-holder rule hid it).
  // Only fills a missing number, never overrides one, and only when the index's count summed to the token's supply.
  for (const t of tokens) if (t.holders == null) { const h = holderCountOf(t.address); if (h && h.supplyOk && h.count > 0) t.holders = h.count; }
  // 10-20: 24h volume / trade count, 1h + 24h change and the 7-day sparkline from the swap store (every real trade on every
  // counted pool) — only for tokens that traded in the store's last 7 days; every other row keeps its snapshot numbers
  const st = Swaps.tokenStatsNow();
  if (st) for (const t of tokens) {
    const x = st.get(t.address.toLowerCase()); if (!x) continue;
    // liquidity = the token's pools' REAL reserves (swap-reserves.ts), never again the V4 "token side × price" estimate
    if (x.liq != null && isFinite(x.liq)) t.liq = x.liq;
    if (x.liqUsdc != null && isFinite(x.liqUsdc)) t.liqUsdc = x.liqUsdc;
    // market cap = the LIVE price × (total supply − burned), both read on chain by the indexer (supply every 10 min)
    if (x.supply != null && x.supply > 0 && t.price != null && isFinite(t.price)) {
      const circ = Math.max(0, x.supply - (x.burned ?? 0)), mc = t.price * circ;
      if (isFinite(mc) && mc > 0 && mc < 1e12) t.mcap = mc;
      const fdv = t.price * x.supply; if (isFinite(fdv) && fdv > 0 && fdv < 1e12) t.fdv = fdv; // fully diluted: every token incl. burned
    }
    t.risk = redFlags(t, x);
    if (x.volume24h == null) continue; // a token measured for liquidity only (no trades in 7 days)
    t.volume24h = x.volume24h; t.txns24 = x.txns24 ?? t.txns24;
    if (x.change1h != null && isFinite(x.change1h)) t.change1h = x.change1h;
    if (x.change24h != null && isFinite(x.change24h)) t.change24h = x.change24h;
    if (x.spark && x.spark.length >= 2) t.spark = x.spark;
  }
  // 10-26 ONE set of numbers per row (review: "the same mcap is worked out different ways"):
  // a row the swap store does NOT measure keeps the snapshot's mcap/FDV, but at the CURRENT price (the on-chain re-price
  // moved price only, so mcap and price disagreed) — always rescaled from the snapshot's own numbers, never compounded.
  for (const t of tokens) {
    const a = t.address.toLowerCase(); if (st?.has(a)) continue;
    const l = listNums.get(a), p0 = l?.[0], k = p0 && t.price != null && p0 > 0 ? t.price / p0 : null;
    if (!l || k == null || !isFinite(k) || k > 20 || k < 1 / 20) continue;
    if (t.mcap != null && l[2] != null) t.mcap = l[2] * k;
    if (t.fdv != null && l[5] != null) t.fdv = l[5] * k;
  }
  // …and the HARD RULES run again LAST: the store numbers above used to land after sanitizeToken, so liq > 1.5x mcap,
  // volume > 20x liquidity (wash) or mcap > $500M could reach the page. A flag on a store row is re-decided from the store's
  // own numbers (the snapshot's junk number is gone); every other flag stays. A/B 10-26 on the live 11,288 rows: 10 visible
  // rows lose wash volume, 0 visible rows hidden, 0 hidden rows shown.
  const RECOMP = new Set(['mcap', 'liq', 'vol', 'liq>mcap']);
  tokens = tokens.map((t) => {
    const b = (t as any).bad;
    return sanitizeToken(b && RECOMP.has(b) && st?.has(t.address.toLowerCase()) ? { ...t, bad: undefined } : t);
  });
  const ix = Board.buildIndex(tokens, PINNED);
  const home = {
    asOf, generatedAt, tracked: tokens.length,
    stats: Board.dashStats(tokens, ix),
    counts: { eco: Board.ecoCount(tokens), launchpad: Board.launchpadCount(tokens, ix), dup: Board.dupCount(tokens, ix) },
    legend: Board.launchpadLegend(tokens, ix),
    trending: Board.trending(tokens, ix).map(slimRow), launches: Board.launches(tokens, ix).map(slimRow), movers: Board.movers(tokens, ix).map(slimRow),
  };
  const homeJson = JSON.stringify(home);
  const list = JSON.stringify({ generatedAt, asOf, tokens });
  const swap = JSON.stringify({ asOf, tokens: Board.swapTokens(tokens, ix) });
  view = { tokens, ix, home, homeJson, homeGz: zlib.gzipSync(homeJson), list, listGz: zlib.gzipSync(list), swap, swapGz: zlib.gzipSync(swap),
    byAddr: new Map(tokens.map((t) => [t.address.toLowerCase(), t])) };
}

// v1 load(): the snapshot list, sanitized; curated V4 rows added; the top 60 on-chain rows re-priced from their pools.
async function load() {
  try {
    const st = fs.statSync(SNAP);
    const raw = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    if (!raw || !Array.isArray(raw.tokens) || raw.tokens.length < 200) throw new Error('degraded snapshot');
    snapMtime = st.mtimeMs; generatedAt = raw.generatedAt ?? null;
    const a = raw.generatedAt ? Date.parse(raw.generatedAt) : NaN; asOf = Number.isFinite(a) ? a : null;
    const n = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    listNums = new Map(raw.tokens.map((x: any) => [String(x.address || '').toLowerCase(), [n(x.price), n(x.change24h), n(x.mcap), n(x.liq), n(x.volume24h), n(x.fdv)]]));
    let list: Token[] = raw.tokens.map(Live.snapshotRow).map(sanitizeToken);
    tokens = list; rebuild(); // serve the fresh list at once; live prices land a moment later
    const [extra, px] = await Promise.all([
      Live.curatedV4Tokens(call).catch(() => [] as Token[]),
      Live.onchainPrices(call, Live.topOnchainRows(list)).catch(() => ({} as Record<string, number>)),
    ]);
    list = Live.applyOnchainPrices(Live.mergeCurated(tokens, extra), px);
    tokens = list; stats.onchainPriced = Object.keys(px).length; stats.lastOnchain = Date.now();
    stats.loads++; stats.lastLoad = Date.now(); rebuild();
  } catch (e) { stats.loadFails++; console.error('[load]', (e as Error).message); }
}
// v1 refreshLive(): RadarDEX (backup, fills gaps) + deep-pool slot0 prices, merged in place.
async function live() {
  if (!tokens.length) return;
  const [rows, deep] = await Promise.all([radarTokens(500), Live.deepPoolPrices(call).catch(() => ({} as Record<string, number>))]);
  if (!rows.length && !Object.keys(deep).length) return;
  tokens = Live.applyLiveOverlay(tokens, rows, deep);
  stats.radarRows = rows.length; stats.deepPriced = Object.keys(deep).length; stats.liveRuns++; stats.lastLive = Date.now(); asOf = Date.now();
  rebuild();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const FILTERS = new Set(['all', 'new', 'eco']);
const SORTS = new Set(['liq', 'mcap', 'holders', 'price', 'name', 'volume', 'change24h', 'change1h', 'age']);
function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: string, gz?: Buffer, maxAge = 10) {
  const h: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=60`,
    vary: 'accept-encoding', 'x-statera-asof': String(asOf ?? ''), 'x-snapshot-age': String(snapMtime ? Math.round((Date.now() - snapMtime) / 1000) : '') };
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { h['content-encoding'] = 'gzip'; res.writeHead(status, h).end(gz ?? zlib.gzipSync(body)); }
  else res.writeHead(status, h).end(body);
}
const intIn = (v: string | null, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };

http.createServer(async (req, res) => { // async: the /wallet route awaits (09-30: a bare await here crashed the API on start)
  try {
    stats.requests++;
    if (!KEY || req.headers['x-relay-key'] !== KEY) { res.writeHead(403).end('nope'); return; }
    const u = new URL(req.url || '/', 'http://x');
    const path = u.pathname.replace(/^\/v2/, '') || '/';
    if (path === '/health') {
      send(req, res, view ? 200 : 503, JSON.stringify({ ok: !!view, tokens: tokens.length, asOf, generatedAt, snapshotAgeS: snapMtime ? Math.round((Date.now() - snapMtime) / 1000) : null, mem: (() => { const m = process.memoryUsage(); return { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576), extMb: Math.round((m.external + m.arrayBuffers) / 1048576) }; })(), caches: cacheStats(), ...stats, detail: { ...detailStats, ...warmStats }, holderIndex: indexStats, holderBatch: batchStats, wallets: { ...walletStats, relay: relayStats, lastError: walletLastError }, chain: chainStats, lending: lendingStats, where: whereStats, activity: activityStats, swaps: { ...Swaps.storeStats(), workers: poolStats } }), undefined, 0); return;
    }
    if (!view) { send(req, res, 503, JSON.stringify({ error: 'warming up' }), undefined, 0); return; }
    const v = view;
    if (path === '/home') { send(req, res, 200, v.homeJson, v.homeGz); return; }
    if (path === '/where') { const w = whereSummary(); send(req, res, w ? 200 : 503, JSON.stringify(w ?? { error: 'warming up' }), undefined, w ? 60 : 0); return; }
    if (path === '/activity') {
      const a = activitySummary() as Record<string, unknown> | null;
      send(req, res, a ? 200 : 503, JSON.stringify(a ? { ...a, launchpads: launchpadTrading(v.tokens) } : { error: 'warming up' }), undefined, a ? 5 : 0); return;
    }
    if (path === '/lending') { const l = lendingSummary(); send(req, res, l ? 200 : 503, JSON.stringify(l ?? { error: 'warming up' }), undefined, l ? 30 : 0); return; }
    if (path === '/chain') {
      const c = chainSummary();
      // Dollar value of each Circle asset (price from the on-chain token list; USDC = 1) so the page can say "$" not units.
      const ADDR: Record<string, string> = { USDC: USDC_ADDR, EURC: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', cirBTC: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', USYC: '0x8a5d989bbb96929f689b0200f435f53da42bf490' };
      const supplyUsd: Record<string, number | null> = {};
      if (c) for (const [k, v] of Object.entries(c.supplies)) { const px = ADDR[k] ? priceOf(ADDR[k]) : null; supplyUsd[k] = v != null && px != null ? v * px : null; }
      send(req, res, c ? 200 : 503, JSON.stringify(c ? { ...c, supplyUsd } : { error: 'warming up' }), undefined, c ? 10 : 0); return;
    }
    if (path === '/list') { send(req, res, 200, v.list, v.listGz); return; }
    if (path === '/swap-tokens') { send(req, res, 200, v.swap, v.swapGz, 30); return; }
    if (path === '/board') {
      const q = (u.searchParams.get('q') || '').slice(0, 80);
      const o: Board.BoardQuery = {
        filter: (FILTERS.has(u.searchParams.get('filter') || '') ? u.searchParams.get('filter') : 'all') as Board.Filter,
        q, sort: (SORTS.has(u.searchParams.get('sort') || '') ? u.searchParams.get('sort') : 'liq') as Board.SortKey,
        dir: u.searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
        hideDupes: u.searchParams.get('dups') !== '1', showInactive: u.searchParams.get('inactive') === '1',
      };
      const per = intIn(u.searchParams.get('per'), 100, 1, 500), rows = Board.boardRows(v.tokens, v.ix, o);
      const pages = Math.max(1, Math.ceil(rows.length / per)), page = intIn(u.searchParams.get('page'), 1, 1, pages);
      // a search with copies hidden says how many it hid, so the page can offer them (10-05)
      const hiddenDupes = q.trim() && o.hideDupes ? Board.boardRows(v.tokens, v.ix, { ...o, hideDupes: false }).length - rows.length : 0;
      send(req, res, 200, JSON.stringify({ asOf, total: rows.length, page, pages, per, hiddenDupes, rows: rows.slice((page - 1) * per, page * per) })); return;
    }
    if (path === '/search') {
      const limit = intIn(u.searchParams.get('limit'), 7, 1, 50);
      send(req, res, 200, JSON.stringify({ rows: Board.heroMatches(v.tokens, v.ix, (u.searchParams.get('q') || '').slice(0, 80), limit) })); return;
    }
    const tm = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/trades$/);
    if (tm) {
      const a = tm[1].toLowerCase(), sd = u.searchParams.get('side');
      tokenTrades(a, v.byAddr.get(a), intIn(u.searchParams.get('page'), 0, 0, 1000), sd === 'buy' || sd === 'sell' ? sd : 'all')
        .then((t) => send(req, res, 200, JSON.stringify(t), undefined, 10))
        .catch((e) => send(req, res, 502, JSON.stringify({ error: 'trades failed: ' + (e as Error).message }), undefined, 0));
      return;
    }
    const dm = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/detail$/);
    if (dm) {
      const a = dm[1].toLowerCase();
      tokenDetail(a, v.byAddr.get(a))
        // 10-21: pool liquidity from the swap store's REAL reserves (a V4 pool was valued by its token side only — a fresh launch
        // with $0 USDC read its whole market cap as liquidity); pools the card didn't know are added
        .then(async (d) => {
          const pr = await swapCall<{ key: string; kind: string; venue: string; usdc: number; tok: number; px: number | null; liq: number }[] | null>('poolReserves', a).catch(() => null);
          let pools = (d as any).ocPools as any[] | null;
          if (pr && pr.length && Array.isArray(pools)) {
            type PR = { key: string; kind: string; venue: string; usdc: number; tok: number; px: number | null; liq: number };
            const byKey = new Map<string, PR>(pr.map((r: PR) => [r.key.toLowerCase(), r] as [string, PR]));
            pools = pools.map((p) => { const r = byKey.get(String(p.pool).toLowerCase()); if (!r) return p; byKey.delete(String(p.pool).toLowerCase());
              return { ...p, liquidityUsdc: r.liq, usdcReserve: r.usdc, tokenReserve: r.tok }; });
            for (const r of byKey.values()) if (r.liq >= 100) pools.push({ pool: r.key, version: r.kind === 'V4' ? 'V4' : r.kind === 'V3' ? 'V3' : r.venue, feeTier: null, quote: 'USDC', liquidityUsdc: r.liq, price: r.px, tokenReserve: r.tok, usdcReserve: r.usdc });
            pools.sort((x, y) => (y.liquidityUsdc || 0) - (x.liquidityUsdc || 0));
          }
          const row = v.byAddr.get(a);
          send(req, res, 200, JSON.stringify({ ...d, ...(pools ? { ocPools: pools } : {}), lookalike: row ? Board.isDupTicker(v.ix, row) : null }), undefined, 15);
        })
        .catch((e) => send(req, res, 502, JSON.stringify({ error: 'detail failed: ' + (e as Error).message }), undefined, 0));
      return;
    }
    const cm = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/candles$/);
    if (cm) {
      const a = cm[1].toLowerCase(), sec = Number(u.searchParams.get('sec')), look = Number(u.searchParams.get('look'));
      if (!candleTfOk(sec, look)) { send(req, res, 400, JSON.stringify({ error: 'unsupported timeframe' }), undefined, 0); return; }
      tokenCandles(a, v.byAddr.get(a), sec, look)
        .then((c) => send(req, res, 200, JSON.stringify({ candles: c }), undefined, 20))
        .catch((e) => send(req, res, 502, JSON.stringify({ error: 'candles failed: ' + (e as Error).message }), undefined, 0));
      return;
    }
    // ── swap store (server/swap-store.ts ← statera-swaps.service): history for every timeframe, older trades, wallet swaps.
    // 503 while the store is missing, so the page keeps its old scan path.
    const bm = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/bars$/);
    if (bm) {
      const before = u.searchParams.get('before') ? intIn(u.searchParams.get('before'), 0, 0, 4e9) : undefined;
      const r = await swapCall('candles', bm[1].toLowerCase(), u.searchParams.get('res') || '5m', intIn(u.searchParams.get('limit'), 1000, 10, 2000), before).catch(() => null);
      send(req, res, r ? 200 : 503, JSON.stringify(r ?? { error: 'swap store unavailable' }), undefined, r ? (before ? 120 : 5) : 0); return;
    }
    const hsm = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/history$/);
    if (hsm) {
      const sd = u.searchParams.get('side'), before = u.searchParams.get('before') ? intIn(u.searchParams.get('before'), 0, 0, 4e9) : undefined;
      const mk = (u.searchParams.get('maker') || '').toLowerCase();
      const r = await swapCall('trades', hsm[1].toLowerCase(), intIn(u.searchParams.get('limit'), 100, 1, 500), before, sd === 'buy' || sd === 'sell' ? sd : undefined, Math.max(0, Number(u.searchParams.get('min')) || 0), /^0x[0-9a-f]{40}$/.test(mk) ? mk : undefined).catch(() => null);
      send(req, res, r ? 200 : 503, JSON.stringify(r ?? { error: 'swap store unavailable' }), undefined, r ? (before ? 60 : 5) : 0); return;
    }
    const am = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/(flow|traders|profitability)$/);
    if (am) {
      const a = am[1].toLowerCase(), so = u.searchParams.get('sort');
      const r = await (am[2] === 'flow' ? swapCall('flow', a) : am[2] === 'traders' ? swapCall('topTraders', a, so === 'volume' || so === 'loss' ? so : 'pnl', intIn(u.searchParams.get('limit'), 50, 1, 200)) : swapCall('profitability', a)).catch(() => null);
      send(req, res, r ? 200 : 503, JSON.stringify(r ?? { error: 'swap store unavailable' }), undefined, r ? 30 : 0); return;
    }
    const sm = path.match(/^\/wallet\/(0x[0-9a-fA-F]{40})\/swaps$/);
    if (sm) {
      const wallet = sm[1].toLowerCase(), tok = (u.searchParams.get('token') || '').toLowerCase();
      const saved = walletSaved(wallet);
      const w = await Promise.race([walletTransfers(wallet).then((x) => x ?? saved), new Promise<typeof saved>((r) => setTimeout(() => r(saved), saved ? 2_500 : 20_000))]);
      if (!w) { send(req, res, 200, JSON.stringify({ wallet, building: true, swaps: [] }), undefined, 0); return; }
      const r = await swapCall('swapsInTxs', [...new Set(w.x.map((x) => x.h))], /^0x[0-9a-f]{40}$/.test(tok) ? tok : undefined).catch(() => null);
      send(req, res, r ? 200 : 503, JSON.stringify(r ? { wallet, at: w.at, swaps: r } : { error: 'swap store unavailable' }), undefined, 0); return;
    }
    const m = path.match(/^\/token\/(0x[0-9a-fA-F]{40})$/);
    if (m) {
      const a = m[1].toLowerCase(), t = v.byAddr.get(a);
      // 10-26: the share card gets the row's OWN current numbers (same as the page / screener), not the 30-min-old snapshot
      // list — rebuild() now keeps mcap/FDV at the row's price, so the card's live/price rescale stays consistent.
      const list = t ? { price: t.price, change24h: t.change24h ?? null, mcap: t.mcap, liq: t.liq, volume24h: t.volume24h ?? null } : undefined;
      send(req, res, t ? 200 : 404, JSON.stringify(t ? { asOf, token: t, list } : { error: 'not listed' })); return;
    }
    // A wallet's CURRENT holdings from our own data: the tokens in its transfer history, balances re-read now with one
    // Multicall3 balanceOf, priced from our token list (09-30 — the Portfolio's quick view came from explorer/RadarDEX)
    const hm = path.match(/^\/wallet\/(0x[0-9a-fA-F]{40})\/holdings$/);
    if (hm) {
      const wallet = hm[1].toLowerCase();
      // ⛔ 10-15 (owner: "portfolio used to be instant"): a stored wallet waited on its history update (up to 20 s, then 202)
      // although this answer only needs the LIST of tokens it ever received — balances are re-read live just below. A stored
      // wallet now gets its saved copy after 2.5 s while the update carries on; a new wallet still waits for its first build.
      const saved = walletSaved(wallet);
      const w = await Promise.race([walletTransfers(wallet).then((x) => x ?? saved), new Promise<typeof saved>((r) => setTimeout(() => r(saved), saved ? 2_500 : 20_000))]);
      if (!w) { send(req, res, 202, JSON.stringify({ building: true }), undefined, 0); return; }
      const toks = [...new Set(w.x.map((x) => x.t))].filter((t) => t !== NATIVE_LOG).slice(0, 300); // the native-USDC log is not a token
      const pad = wallet.slice(2).padStart(64, '0');
      const calls = toks.flatMap((t) => [{ target: t, data: '0x70a08231' + pad }, { target: t, data: '0x313ce567' }, { target: t, data: '0x95d89b41' }]);
      let out: (string | null)[] = [];
      try { const r = await rpc('eth_call', [{ to: '0xca11bde05977b3631167028862be2a173976ca11', data: encAggregate3(calls) }, 'latest']); out = r && r.length > 2 ? decAggregate3(r) : []; } catch { /* */ }
      const str = (h: string | null) => { if (!h || h.length < 130) return null; try { const n = Number(BigInt('0x' + h.slice(66, 130))); return Buffer.from(h.slice(130, 130 + n * 2), 'hex').toString('utf8').replace(/\0+$/, ''); } catch { return null; } };
      const holdings = toks.map((t, i) => {
        const bh = out[i * 3], dh = out[i * 3 + 1];
        if (!bh || bh.length < 66) return null;
        const row = v.byAddr.get(t) as any;
        const decimals = row?.decimals ?? (dh && dh.length >= 66 ? Number(BigInt(dh.slice(0, 66))) : null);
        if (decimals == null) return null;
        const amount = Number(BigInt(bh.slice(0, 66))) / 10 ** decimals;
        if (!(amount > 0)) return null;
        const price = t === '0x3600000000000000000000000000000000000000' ? 1 : (row?.price ?? null);
        return { address: t, symbol: row?.symbol || str(out[i * 3 + 2]) || '?', name: row?.name || row?.symbol || str(out[i * 3 + 2]) || '?', decimals,
          icon: row?.iconUrl ?? null, price, amount, usd: price != null ? amount * price : null };
      }).filter(Boolean);
      send(req, res, 200, JSON.stringify({ wallet, at: w.at, holdings }), undefined, 0); return;
    }
    // A wallet's token transfers from OUR chain read (server/wallet-index.ts) — Portfolio P&L, swap activity, holdings
    const wm = path.match(/^\/wallet\/(0x[0-9a-fA-F]{40})\/transfers$/);
    if (wm) {
      const limit = intIn(u.searchParams.get('limit'), 500, 1, 5000);
      const w = await Promise.race([walletTransfers(wm[1]), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
      if (!w) { send(req, res, 202, JSON.stringify({ building: true }), undefined, 0); return; } // first read still running
      const tokens = [...new Set(w.x.map((x) => x.t))].filter((t) => t !== NATIVE_LOG);
      const list = w.x.slice(0, limit), first = w.x.length ? w.x[w.x.length - 1].b : null;
      const ts = await blockTimes(list.slice(0, 60).map((x) => x.b)); // exact times for the newest 60
      send(req, res, 200, JSON.stringify({ wallet: wm[1].toLowerCase(), last: w.last, at: w.at, count: w.x.length, firstBlock: first, tokens,
        transfers: list.map((x) => ({ ...x, ts: ts.get(x.b) || null })) }), undefined, 0); return;
    }
    // Our own visit counter (09-30 — was a third-party counter service). ?hit=1 counts one visit; saved to disk.
    if (path === '/visits') {
      if (u.searchParams.get('hit') === '1') { visits.n++; visitsDirty = true; }
      send(req, res, 200, JSON.stringify({ value: visits.n }), undefined, 0); return;
    }
    if (path === '/tokens') {
      const addrs = (u.searchParams.get('addrs') || '').toLowerCase().split(',').filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, 300);
      send(req, res, 200, JSON.stringify({ asOf, tokens: addrs.map((a) => v.byAddr.get(a)).filter(Boolean) })); return;
    }
    send(req, res, 404, JSON.stringify({ error: 'unknown path' }));
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message })); }
}).listen(PORT, '127.0.0.1', () => console.log(`statera-api on 127.0.0.1:${PORT} (snapshot ${SNAP})`));

// Reload when the file changes or every LOAD_MS (the v1 browser reloaded every 60 s); live overlay every LIVE_MS.
let loading = false, living = false;
const tickLoad = async () => { if (loading) return; loading = true; try { await load(); } finally { loading = false; } };
const tickLive = async () => { if (living) return; living = true; try { await live(); } catch (e) { console.error('[live]', (e as Error).message); } finally { living = false; } };
await tickLoad(); tickLive();
setInterval(tickLoad, LOAD_MS);
setInterval(tickLive, LIVE_MS);
// Keep the 8 busiest token pages warm (by 24h volume, real tokens only) — their first visitor never waits for a scan.
const warm = () => { if (view) prewarm(Board.boardRows(view.tokens, view.ix, { filter: 'all', q: '', sort: 'volume', dir: 'desc', hideDupes: true, showInactive: false }).slice(0, 8)); };
setTimeout(warm, 20_000); setInterval(warm, 180_000);
// Every listed token (not just the top 8) kept warm in the background, one at a time; caches survive restarts.
loadCaches();
const listed = () => (view ? Board.boardRows(view.tokens, view.ix, { filter: 'all', q: '', sort: 'volume', dir: 'desc', hideDupes: true, showInactive: false }).slice(0, 200) : []);
// back to back: the next token 4 s after the last one finished (a fixed 12 s tick warmed ~1 token a minute)
const warmLoop = async () => { try { await warmNext(listed()); } catch { /* next */ } setTimeout(warmLoop, 4_000); };
setTimeout(warmLoop, 15_000);
// Our own holder index (server/holder-index.ts): every listed token, never-indexed first, then any older than 10 min —
// one at a time, on the wide-range RPCs (not the ones visitors' pages use).
const indexLoop = async () => {
  let did = false, ok = false;
  try {
    const rows = listed(), now = Date.now();
    // freshness from the small counts list (holderCountOf) — never parse 100 token files per tick
    const next = rows.map((t) => ({ t, at: holderCountOf(t.address)?.at ?? 0 })).filter((x) => now - x.at > 10 * 60_000).sort((a, b) => a.at - b.at)[0];
    if (next) { did = true; ok = await indexHolders(next.t.address); }
  } catch { /* next tick */ }
  // ⛔ 10-15: a FAILED index counted as work done and retried in 2 s — 981 failures in a day (Blockdaemon pruned its old logs,
  // Tenderly then 429'd this box), and that hammering kept the box rate-limited, so wallet history updates failed too
  // (owner's portfolio). A failure now waits 60 s.
  setTimeout(indexLoop, !did ? 20_000 : ok ? 2_000 : 60_000);
};
setTimeout(indexLoop, 30_000);
// Every LIQUID token (≥ $100 in pools, ~800) — the screener's holder counts, no longer from arc-scan (09-30). Batches of 40:
// never-indexed first, then any count older than 30 min. The listed tokens above also refresh every 10 min on their own.
const batchLoop = async () => {
  let did = false, ok = false;
  try {
    if (view) {
      const now = Date.now();
      const all = view.tokens.filter((t) => (t.liq ?? 0) >= 100).map((t) => t.address.toLowerCase());
      let pick = all.filter((a) => !holderCountOf(a)).slice(0, 40);
      if (!pick.length) pick = all.map((a) => ({ a, at: holderCountOf(a)?.at ?? 0 })).filter((x) => now - x.at > 30 * 60_000).sort((x, y) => x.at - y.at).slice(0, 40).map((x) => x.a);
      if (pick.length) { did = true; ok = (await indexBatch(pick)) > 0; }
    }
  } catch { /* next tick */ }
  setTimeout(batchLoop, !did ? 60_000 : ok ? 3_000 : 90_000); // a failed batch waits (see indexLoop)
};
setTimeout(batchLoop, 90_000);
setInterval(saveCaches, 5 * 60_000);
// visit counter state (continues from the old counter's 1,885 on 09-30)
const VISITS_FILE = '/root/statera-api-state/visits.json';
const visits: { n: number } = (() => { try { return JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')); } catch { return { n: 1885 }; } })();
let visitsDirty = false;
setInterval(() => { if (!visitsDirty) return; visitsDirty = false; try { fs.writeFileSync(VISITS_FILE + '.tmp', JSON.stringify(visits)); fs.renameSync(VISITS_FILE + '.tmp', VISITS_FILE); } catch { /* */ } }, 10_000);
// The Network page's chain follower: every block, one poll at a time, every 15 s.
let chaining = false;
const tickChain = async () => { if (chaining) return; chaining = true; try { await pollChain(rpc, rpcBatch); } catch (e) { chainStats.errors++; console.error('[chain]', (e as Error).message); } finally { chaining = false; } };
loadActivity(); setInterval(saveActivity, 15_000);
// the Network page's 24 h of protocol + USDC activity before the live counter started — one step (≤ 3 calls) every 1.5 s
let actBf = false;
setInterval(async () => {
  if (actBf) return; actBf = true;
  try { await activityBackfillStep(rpc, 0, 0.505); } catch { /* next tick */ } finally { actBf = false; } // Arc's measured block time (chain.ts)
}, 1500);
loadChain(); tickChain(); setInterval(tickChain, 15_000);
// History in the background, paced under the public RPC burst limit; state saved every minute (survives deploys).
const backfill = async () => { try { if (await backfillStep(rpcBatch)) { setTimeout(backfill, 2500); return; } } catch { chainStats.errors++; setTimeout(backfill, 10_000); return; } setTimeout(backfill, 30_000); };
setTimeout(backfill, 5_000);
// Bridge flows back to 24 h (Network page 1H / 12H / 24H) — 9,000 blocks per step, paced, behind the block backfill.
const flowsBackfill = async () => { let more = false; try { more = await flowsBackfillStep(rpc); } catch { chainStats.errors++; } setTimeout(flowsBackfill, more ? 3_000 : 60_000); };
setTimeout(flowsBackfill, 20_000);
setInterval(saveChain, 60_000);
// Lending (Network page): every 5 min. getLogs over ~95k blocks needs the nodes that allow it (address-filtered, few results).
const BIG_RPCS = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://arc.gateway.tenderly.co'];
let bg = 0;
async function getLogsBig(params: any): Promise<any[] | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BIG_RPCS[(bg++) % BIG_RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [params] }), signal: AbortSignal.timeout(12000) });
      const j: any = await r.json(); if (Array.isArray(j.result)) return j.result;
    } catch { /* next node */ }
    await sleep(500 * (i + 1));
  }
  return null;
}
const symbolOf = (t: string) => { const a = t.toLowerCase(); if (a === USDC_ADDR) return 'USDC'; return view?.byAddr.get(a)?.symbol ?? null; };
let lending = false;
const tickLending = async () => { if (lending) return; lending = true; try { await refreshLending(rpc, call, getLogsBig, priceOf, symbolOf); } catch (e) { lendingStats.errors++; console.error('[lending]', (e as Error).message); } finally { lending = false; } };
// Every minute until Morpho's one-time market count is complete, then every 5 min.
setTimeout(tickLending, 5_000);
setInterval(() => { const l = lendingSummary(); if (!l || !l.morpho?.complete || Date.now() - l.at > 5 * 60_000) tickLending(); }, 60_000);
// Where each Circle asset sits (Network page): every 10 min. Pools = every pool address the live token list knows.
let whereBusy = false;
const tickWhere = async () => { if (whereBusy || !view) return; whereBusy = true;
  try { await refreshWhere(rpc, view.tokens.map((t) => t.pool).filter((p): p is string => !!p), priceOf); }
  catch (e) { whereStats.errors++; console.error('[where]', (e as Error).message); } finally { whereBusy = false; } };
setTimeout(tickWhere, 45_000); setInterval(tickWhere, 10 * 60_000);
// one shutdown handler — the chain state and the token-page caches both saved before exit
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { saveChain(); saveCaches(); saveActivity(); process.exit(0); });
setInterval(() => { try { if (fs.statSync(SNAP).mtimeMs !== snapMtime) tickLoad(); } catch { /* keep serving the last good list */ } }, 5000);

// 10-20: the swap store's screener numbers (see rebuild(); built by the indexer into table tstats) — the board picks them up every 2 min
// Launchpad TRADING, 24 h (the Network page's activity card): every listed token a launchpad created — its trades + USD volume in
// its pools over the last 24 h (the swap store's numbers, already on each board row: txns24 / volume24h), split by launchpad.
// ⛔ owner 10-21: "there's not one launchpad that's called Launchpad" — only launchpads identified by name from evidence (the
// snapshot's PAD_NAMES: Argus pad, Warp, faze.fun, Arctide, ubi.fun) are listed; the generic "Launchpad" tag (an unnamed
// factory that made ≥ 3 tokens) is left out of this card.
let lpCache: { at: number; v: unknown } | null = null;
function launchpadTrading(rows: Token[]) {
  if (lpCache && Date.now() - lpCache.at < 30_000) return lpCache.v;
  const by = new Map<string, { pad: string; tokens: number; traded: number; trades: number; volume: number }>();
  for (const t of rows) {
    if (!t.launchpad || t.launchpad === 'Launchpad') continue;
    const g = by.get(t.launchpad) || { pad: t.launchpad, tokens: 0, traded: 0, trades: 0, volume: 0 };
    g.tokens++; const n = t.txns24 ?? 0, vol = t.volume24h ?? 0;
    if (n > 0) { g.traded++; g.trades += n; g.volume += vol; }
    by.set(t.launchpad, g);
  }
  const pads = [...by.values()].sort((a, b) => b.volume - a.volume); // by 24h volume (owner 10-24)
  // red-flagged tokens (redFlags 'high') never headline the card; their trades still count in the totals above
  // TOP BY MARKET CAP like argus.world's own list (owner 10-21) — a pump-and-dump has volume, never a real market cap with
  // liquidity behind it; red-flagged and sub-$1K-liquidity tokens are left out
  const top = rows.filter((t) => t.launchpad && t.launchpad !== 'Launchpad' && t.mcap != null && t.risk?.level !== 'high' && (t.liq ?? 0) >= 1000 && (t.liq ?? 0) >= t.mcap * 0.02)
    .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0)).slice(0, 5)
    .map((t) => ({ address: t.address, symbol: t.symbol, pad: t.launchpad, trades: t.txns24, volume: t.volume24h, mcap: t.mcap, liq: t.liq, change24h: t.change24h }));
  const v = { trades: pads.reduce((s, p) => s + p.trades, 0), volume: pads.reduce((s, p) => s + p.volume, 0), traded: pads.reduce((s, p) => s + p.traded, 0), pads, top };
  lpCache = { at: Date.now(), v };
  return v;
}
// ── RED FLAGS (owner 10-21, SHARC: "7 holders … went up like that … liquidity is low … they're scams — Statera has to have code
// that detects this and red-flags them"). Three on-chain signals, each a plain fact the page can state:
//   pump & dump      — price ≤ 25% of its 7-day high (closes of the main pool, not wicks)
//   liquidity pulled — under $1,000 of REAL USDC in its pools (swap-reserves.ts) while 24h volume is over $5,000
//   tiny holder base — under 25 holders while it traded over $10,000 in 24 h
//   thin market cap  — over $100K market cap on less than 1/50 of it in liquidity
// 2+ = 'high' (kept out of the top lists, red banner on its page), 1 = 'warn'. Volume still counts in every total.
function redFlags(t: Token, x: Swaps.StoreTokenStats): Token['risk'] {
  const f: string[] = [], px = t.price ?? x.price ?? null, vol = x.volume24h ?? t.volume24h ?? 0;
  if (px != null && x.hi7 != null && x.hi7 > 0 && px <= x.hi7 * 0.25) f.push(`Down ${Math.round((1 - px / x.hi7) * 100)}% from its 7-day high`);
  if (x.liqUsdc != null && x.liqUsdc < 1000 && vol > 5000) f.push(`Only $${Math.round(x.liqUsdc).toLocaleString('en-US')} of USDC left in its pools after $${Math.round(vol).toLocaleString('en-US')} traded today`);
  if (t.holders != null && t.holders < 25 && vol > 10000) f.push(`Only ${t.holders} holders while trading $${Math.round(vol).toLocaleString('en-US')} a day`);
  // a market cap nobody could sell into: FAZE read $2.5M with $1,770 of liquidity (argus.world's real tokens run ~10–20×)
  const liq = x.liq ?? t.liq ?? null;
  if (t.mcap != null && t.mcap > 100_000 && liq != null && t.mcap > liq * 50) f.push(`$${Math.round(t.mcap).toLocaleString('en-US')} market cap on only $${Math.round(liq).toLocaleString('en-US')} of liquidity`);
  return f.length >= 2 ? { level: 'high', flags: f } : f.length === 1 ? { level: 'warn', flags: f } : null;
}
let swapStatsBusy = false;
const tickSwapStats = async () => {
  if (swapStatsBusy) return; swapStatsBusy = true;
  try { if (Swaps.tokenStatsNow() && tokens.length) rebuild(); } catch (e) { console.error('[swap-stats]', (e as Error).message); } finally { swapStatsBusy = false; }
};
setTimeout(tickSwapStats, 30_000); setInterval(tickSwapStats, 120_000);
