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
//   /v2/lending                       Morpho Blue markets + Aave V4 Hub assets (supplied / borrowed), read on chain
//   /v2/where                         where USDC / EURC / cirBTC supply sits: lending, DEX pools, Gateway, contracts, wallets
//   /v2/list                          the whole live list (v1-compatible shape: { generatedAt, tokens })
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PINNED, sanitizeToken, type Token } from '../src/lib/rules.ts';
import * as Live from '../src/lib/live.ts';
import * as Board from '../src/lib/board.ts';
import { indexHolders, indexStats, indexBatch, batchStats, holderCountOf } from './holder-index.ts';
import { walletTransfers, walletStats, blockTimes } from './wallet-index.ts';
import { tokenDetail, prewarm, detailStats, tokenCandles, candleTfOk, warmNext, warmStats, saveCaches, loadCaches } from './token-detail.ts';
import { pollChain, chainSummary, chainStats, backfillStep, saveChain, loadChain } from './chain.ts';
import { refreshLending, lendingSummary, lendingStats } from './lending.ts';
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
// Order matters on this box: its IP is shared with the grid bot, holdings, sniper and the indexer, and on 09-28 arc.io,
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
// Its own node pool: the VPS IP also carries the grid bot, holdings, sniper and indexer, and tenderly rate-limits it (09-28),
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
let generatedAt: string | null = null, snapMtime = 0, asOf: number | null = null;
let view: View | null = null;
const stats = { loads: 0, loadFails: 0, onchainPriced: 0, liveRuns: 0, radarRows: 0, deepPriced: 0, lastLoad: 0, lastOnchain: 0, lastLive: 0, requests: 0 };

// USD price of a token from the live on-chain list (USDC = 1). Defined up here: the HTTP server answers during startup.
const USDC_ADDR = '0x3600000000000000000000000000000000000000';
const priceOf = (t: string) => { const a = t.toLowerCase(); if (a === USDC_ADDR) return 1; const r = view?.byAddr.get(a); return r && r.price != null && isFinite(r.price) ? r.price : null; };
const slimRow = (t: Token) => t; // rows go out whole: the page renders every field it had in v1
function rebuild() {
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

http.createServer((req, res) => {
  try {
    stats.requests++;
    if (!KEY || req.headers['x-relay-key'] !== KEY) { res.writeHead(403).end('nope'); return; }
    const u = new URL(req.url || '/', 'http://x');
    const path = u.pathname.replace(/^\/v2/, '') || '/';
    if (path === '/health') {
      send(req, res, view ? 200 : 503, JSON.stringify({ ok: !!view, tokens: tokens.length, asOf, generatedAt, snapshotAgeS: snapMtime ? Math.round((Date.now() - snapMtime) / 1000) : null, ...stats, detail: { ...detailStats, ...warmStats }, holderIndex: indexStats, holderBatch: batchStats, wallets: walletStats, chain: chainStats, lending: lendingStats, where: whereStats }), undefined, 0); return;
    }
    if (!view) { send(req, res, 503, JSON.stringify({ error: 'warming up' }), undefined, 0); return; }
    const v = view;
    if (path === '/home') { send(req, res, 200, v.homeJson, v.homeGz); return; }
    if (path === '/where') { const w = whereSummary(); send(req, res, w ? 200 : 503, JSON.stringify(w ?? { error: 'warming up' }), undefined, w ? 60 : 0); return; }
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
      send(req, res, 200, JSON.stringify({ asOf, total: rows.length, page, pages, per, rows: rows.slice((page - 1) * per, page * per) })); return;
    }
    if (path === '/search') {
      const limit = intIn(u.searchParams.get('limit'), 7, 1, 50);
      send(req, res, 200, JSON.stringify({ rows: Board.heroMatches(v.tokens, v.ix, (u.searchParams.get('q') || '').slice(0, 80), limit) })); return;
    }
    const dm = path.match(/^\/token\/(0x[0-9a-fA-F]{40})\/detail$/);
    if (dm) {
      const a = dm[1].toLowerCase();
      tokenDetail(a, v.byAddr.get(a))
        .then((d) => send(req, res, 200, JSON.stringify(d), undefined, 15))
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
    const m = path.match(/^\/token\/(0x[0-9a-fA-F]{40})$/);
    if (m) { const t = v.byAddr.get(m[1].toLowerCase()); send(req, res, t ? 200 : 404, JSON.stringify(t ? { asOf, token: t } : { error: 'not listed' })); return; }
    // A wallet's token transfers from OUR chain read (server/wallet-index.ts) — Portfolio P&L, swap activity, holdings
    const wm = path.match(/^\/wallet\/(0x[0-9a-fA-F]{40})\/transfers$/);
    if (wm) {
      const limit = intIn(u.searchParams.get('limit'), 500, 1, 5000);
      const w = await Promise.race([walletTransfers(wm[1]), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
      if (!w) { send(req, res, 202, JSON.stringify({ building: true }), undefined, 0); return; } // first read still running
      const tokens = [...new Set(w.x.map((x) => x.t))];
      const list = w.x.slice(0, limit), first = w.x.length ? w.x[w.x.length - 1].b : null;
      const ts = await blockTimes(list.slice(0, 60).map((x) => x.b)); // exact times for the newest 60
      send(req, res, 200, JSON.stringify({ wallet: wm[1].toLowerCase(), last: w.last, at: w.at, count: w.x.length, firstBlock: first, tokens,
        transfers: list.map((x) => ({ ...x, ts: ts.get(x.b) || null })) }), undefined, 0); return;
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
  let did = false;
  try {
    const rows = listed(), now = Date.now();
    // freshness from the small counts list (holderCountOf) — never parse 100 token files per tick
    const next = rows.map((t) => ({ t, at: holderCountOf(t.address)?.at ?? 0 })).filter((x) => now - x.at > 10 * 60_000).sort((a, b) => a.at - b.at)[0];
    if (next) { await indexHolders(next.t.address); did = true; }
  } catch { /* next tick */ }
  setTimeout(indexLoop, did ? 2_000 : 20_000);
};
setTimeout(indexLoop, 30_000);
// Every LIQUID token (≥ $100 in pools, ~800) — the screener's holder counts, no longer from arc-scan (09-30). Batches of 40:
// never-indexed first, then any count older than 30 min. The listed tokens above also refresh every 10 min on their own.
const batchLoop = async () => {
  let did = false;
  try {
    if (view) {
      const now = Date.now();
      const all = view.tokens.filter((t) => (t.liq ?? 0) >= 100).map((t) => t.address.toLowerCase());
      let pick = all.filter((a) => !holderCountOf(a)).slice(0, 40);
      if (!pick.length) pick = all.map((a) => ({ a, at: holderCountOf(a)?.at ?? 0 })).filter((x) => now - x.at > 30 * 60_000).sort((x, y) => x.at - y.at).slice(0, 40).map((x) => x.a);
      if (pick.length) { await indexBatch(pick); did = true; }
    }
  } catch { /* next tick */ }
  setTimeout(batchLoop, did ? 3_000 : 60_000);
};
setTimeout(batchLoop, 90_000);
setInterval(saveCaches, 5 * 60_000);
// The Network page's chain follower: every block, one poll at a time, every 15 s.
let chaining = false;
const tickChain = async () => { if (chaining) return; chaining = true; try { await pollChain(rpc, rpcBatch); } catch (e) { chainStats.errors++; console.error('[chain]', (e as Error).message); } finally { chaining = false; } };
loadChain(); tickChain(); setInterval(tickChain, 15_000);
// History in the background, paced under the public RPC burst limit; state saved every minute (survives deploys).
const backfill = async () => { try { if (await backfillStep(rpcBatch)) { setTimeout(backfill, 2500); return; } } catch { chainStats.errors++; setTimeout(backfill, 10_000); return; } setTimeout(backfill, 30_000); };
setTimeout(backfill, 5_000);
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
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { saveChain(); saveCaches(); process.exit(0); });
setInterval(() => { try { if (fs.statSync(SNAP).mtimeMs !== snapMtime) tickLoad(); } catch { /* keep serving the last good list */ } }, 5000);
