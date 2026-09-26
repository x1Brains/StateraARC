// On-chain token discovery for the StateraArc screener — reads the WHOLE market straight from the chain
// (V3 + V4 pools), independent of any third-party screener. Finds every token that has a real USDC pool,
// prices it, and writes onchain-tokens.json which the snapshot builder merges into the screener list.
//
// WHY it's cheap enough to run beside the 30-min snapshot on the existing VPS (no upgrade):
//  - Discovery uses each DEX's pool-CREATION events (V3 PoolCreated on the factory, V4 Initialize on the
//    PoolManager) — one address each, so a full sweep is ~10 getLogs per source, and it's INCREMENTAL
//    (a persisted block cursor means later runs scan only new blocks).
//  - ~40k pools exist but ~98% are empty decoys, so we filter by real liquidity (V3 liquidity() batched
//    through Multicall3; V4 by live swap activity) — only NEW pools get checked each run.
//  - State (cursor + known tokens) lives OUTSIDE the git repo so the snapshot push's hard-reset can't wipe it.
import fs from 'fs';
import { keccak_256 } from '@noble/hashes/sha3';

const RPCS_BIG = ['https://arc.gateway.tenderly.co', 'https://rpc.blockdaemon.mainnet.arc.io']; // accept 95k ranges
const RPCS = ['https://rpc.mainnet.arc.io', 'https://arc.gateway.tenderly.co', 'https://rpc.blockdaemon.mainnet.arc.io'];
const USDC = '0x3600000000000000000000000000000000000000';
const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
const ZERO = '0x0000000000000000000000000000000000000000';
const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const T_V3_CREATE = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'; // PoolCreated(token0,token1,fee,tickSpacing,pool)
const T_V4_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const T_V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const VOL_FLOOR = Number(process.env.ONCHAIN_MIN_LIQ || 100); // only scan 24h vol/change for tokens we'll keep (>= the $100 floor) — the vol scan is the bottleneck, so this is the real speedup
// Major-asset tickers that DON'T legitimately exist as launchpad mints on Arc — any on-chain token using
// them is an impersonator (fake "Wrapped Ether" $267M etc.), and its faked high price inflates the
// liquidity estimate so it ranks #1. Drop them from discovery. (Real ecosystem tokens come via RadarDEX.)
const IMPERSONATOR = new Set(['WETH', 'ETH', 'WBTC', 'BTC', 'CBBTC', 'USDT', 'USDC', 'DAI', 'XRP', 'SOL', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI', 'MATIC', 'SHIB', 'PEPE', 'TRX', 'LTC', 'DOT', 'GOLD', 'XAU', 'XAUM', 'SILVER', 'EURC', 'EUROC', 'USD', 'WBNB', 'STETH', 'TON', 'NVDA', 'AAPL', 'TSLA']);
// ⛔ The IMPERSONATOR set drops a MAJOR ticker regardless of address — but some of those tickers DO have a
// real, Circle-issued token on Arc (the canonical WETH/EURC/USYC). Allowlist their VERIFIED addresses
// (arc-scan + docs.arc.io/arc/references/contract-addresses) so we stop hiding the real ones while still
// killing the fakes (a $267M "Wrapped Ether" at a different address).
const IMPERSONATOR_ALLOW = new Set([
  '0x128cc466b61f542da60c70e3aa11c10e19b84edb', // WETH (Wrapped Ether) — canonical
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', // EURC (Circle euro)
  '0x8a5d989bbb96929f689b0200f435f53da42bf490', // USYC (Circle yield)
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', // cirBTC (already whitelisted by symbol, kept for clarity)
]);

const STATE_FILE = process.env.ONCHAIN_STATE || './onchain-state.json';
const OUT_FILE = process.env.ONCHAIN_OUT || './onchain-tokens.json';

// Uniswap V4 Arc subgraph (community, PaulieB14) — a COMPLETE, head-synced V4 pool index. Our getLogs
// discovery has range caps and keys off RECENT swap activity, so it misses V4 pools (measured: 94 real
// USDC-paired tokens we lacked — DUKE $263k, ARCMAN $203k…). We use the subgraph ONLY to DISCOVER pools
// (poolId + token + orientation + creation block); every price/liquidity/volume number still comes from our
// own on-chain reads, so a subgraph outage or a bogus USD figure can NEVER corrupt our data. Free Subgraph
// Studio endpoint, one query/run, wrapped so a failure is non-fatal. Verified bit-accurate vs StateView.
const SUBGRAPH_V4 = process.env.SUBGRAPH_V4 || 'https://api.studio.thegraph.com/query/111767/uniswap-v4---arc/version/latest';
async function fetchSubgraphV4Cands() {
  try {
    const query = '{ pools(first:500, orderBy: totalValueLockedUSD, orderDirection: desc){ id token0{id symbol} token1{id symbol} totalValueLockedUSD createdAtBlockNumber hooks } }';
    const r = await fetch(SUBGRAPH_V4, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) });
    const pools = (await r.json())?.data?.pools;
    if (!Array.isArray(pools)) return [];
    // Group USDC-paired pools by the non-USDC token; keep the HIGHEST-TVL pool (a decoy has low TVL). getLogs
    // refines the pool choice later by swap count, so this is just a discovery seed.
    const byToken = new Map();
    for (const p of pools) {
      const t0 = (p.token0?.id || '').toLowerCase(), t1 = (p.token1?.id || '').toLowerCase();
      let token, sym, usdcIsC0;
      if (t0 === USDC) { token = t1; sym = (p.token1?.symbol || '').toUpperCase(); usdcIsC0 = true; }
      else if (t1 === USDC) { token = t0; sym = (p.token0?.symbol || '').toUpperCase(); usdcIsC0 = false; }
      else continue;
      if (!token || token === USDC) continue;
      if (IMPERSONATOR.has(sym) && !IMPERSONATOR_ALLOW.has(token)) continue; // don't seed known fakes
      const tvl = Number(p.totalValueLockedUSD) || 0;
      const prev = byToken.get(token);
      if (!prev || tvl > prev.tvl) byToken.set(token, { token, poolId: p.id, usdcIsC0,
        created: p.createdAtBlockNumber ? parseInt(p.createdAtBlockNumber, 10) : null,
        hooks: (p.hooks && !/^0x0+$/i.test(p.hooks)) ? p.hooks.toLowerCase() : null, tvl });
    }
    return [...byToken.values()];
  } catch (e) { console.log('[disc] subgraph V4 fetch failed (non-fatal):', e.message); return []; }
}
const CH = 95000n;                       // getLogs range for the big-range RPCs
const INITIAL_LOOKBACK = BigInt(process.env.ONCHAIN_LOOKBACK || 1_200_000); // first run: how far back to sweep
const MAX_NEW_PER_RUN = Number(process.env.ONCHAIN_MAX_NEW || 3000); // V3 candidates to liquidity-check per run; the rest carry over in a backlog so a run never hangs on 19k checks
const V4_ACTIVE_WINDOW = BigInt(process.env.V4_ACTIVE_WINDOW || 40000); // blocks of recent V4 swaps to catch active launchpad pools
const MIN_USDC = Number(process.env.ONCHAIN_MIN_USDC || 60); // a V3 pool must hold >= this much USDC to be tracked (≈ $120 both-sides value)
const MIN_LIQ = Number(process.env.ONCHAIN_MIN_LIQ || 100);  // only OUTPUT tokens whose total pool value clears this — cuts nanocap noise + keeps the indexer lean/fast
// First block with code at the V4 PoolManager (binary search on eth_getCode, 09-25). The registry backfills from here.
const V4_START = BigInt(process.env.V4_START || 1948056);
// First block with code at the V3 factory (binary search, 09-25). The indexer's first sweep only looked back 1.2M blocks, so
// every V3 USDC pool created before that was never discovered — Builders (0xa37c…, 564 holders, $21K pool) was one.
const V3_START = BigInt(process.env.V3_START || 1948019);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const padU = (n) => BigInt(n).toString(16).padStart(64, '0');
const hexToU8 = (h) => { h = h.replace(/^0x/, ''); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const v4StateSlot = (poolId) => '0x' + Buffer.from(keccak_256(hexToU8(poolId.replace(/^0x/, '').padStart(64, '0') + (6).toString(16).padStart(64, '0')))).toString('hex');
const num = (hex, dec) => { try { return Number(BigInt(hex)) / 10 ** dec; } catch { return 0; } };

let _ri = 0;
async function rpc(method, params, big = false) {
  const pool = big ? RPCS_BIG : RPCS;
  for (let i = 0; i < 4; i++) {
    const url = pool[(_ri++) % pool.length];
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal }).finally(() => clearTimeout(to));
      const j = await r.json();
      if (j.error) { await sleep(150 * (i + 1)); continue; }
      return j.result;
    } catch { await sleep(150 * (i + 1)); }
  }
  return null;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
async function runLimited(tasks, limit) { const out = new Array(tasks.length); let i = 0; await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => { while (i < tasks.length) { const idx = i++; out[idx] = await tasks[idx](); } })); return out; }

// Scan a topic on an address across [from,head] in `chunk`-block windows (big-range RPCs), bounded.
async function scanLogs(address, topics, from, head, chunk = CH) {
  const ranges = []; for (let f = from; f < head; f += chunk) ranges.push([f, f + chunk > head ? head : f + chunk]);
  const res = await runLimited(ranges.map(([f, t]) => () => rpc('eth_getLogs', [{ address, topics, fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }], true)), 8);
  // ⛔ A failed chunk (RPC error / the endpoints' 20k-results cap) returns null and would be SILENTLY dropped
  // → missing logs → undercounted discovery/volume. Count + warn so partial scans are never invisible.
  const out = []; let failed = 0;
  for (const r of res) { if (Array.isArray(r)) out.push(...r); else failed++; }
  if (failed) console.log(`[scan] WARN ${failed}/${ranges.length} log chunks failed (RPC cap/error) at chunk=${chunk} — results are PARTIAL`);
  return out;
}

// ── V4 pool REGISTRY (every USDC-paired Initialize since the PoolManager was deployed) ────────────────────────
// ⛔ Before 09-25 the Initialize map was re-scanned only from state.cursor (the last run, ~15 min), so a V4 pool
// created earlier that STARTED trading later was never matched to its token by the activity scan (only the
// subgraph's top-500 could catch it), and a decoy could never be swapped for an older real pool. Now every
// USDC-paired pool is kept in state.v4reg (poolId -> [c0, c1, createdBlock, hooks, fee, tickSpacing]): backfilled
// once from V4_START, then only new blocks. A range that fails is remembered in `gaps` and retried next run, so a
// flaky RPC can never silently leave a hole.
function addInit(reg, logs) {
  let n = 0;
  for (const l of logs) {
    const c0 = ('0x' + l.topics[2].slice(26)).toLowerCase(), c1 = ('0x' + l.topics[3].slice(26)).toLowerCase();
    if (c0 !== USDC && c1 !== USDC) continue;
    const d = l.data.slice(2);
    const fee = parseInt(d.slice(0, 64), 16);
    let ts = BigInt('0x' + d.slice(64, 128)); if (ts >= (1n << 255n)) ts -= (1n << 256n);   // int24, sign-extended
    const hooks = ('0x' + d.slice(2 * 64 + 24, 3 * 64)).toLowerCase();
    if (!reg.pools[l.topics[1]]) n++;
    reg.pools[l.topics[1]] = [c0, c1, parseInt(l.blockNumber, 16), hooks, fee, Number(ts)];
  }
  return n;
}
async function scanInitRanges(reg, ranges) {
  const res = await runLimited(ranges.map(([f, t]) => () => rpc('eth_getLogs', [{ address: PM_V4, topics: [T_V4_INIT], fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }], true)), 8);
  const failed = []; let added = 0;
  // A range that fails again is usually one with MORE Initialize logs than the RPC returns in one call (the same 4
  // ranges failed on every retry, 09-25) — so it comes back as two halves next run, until the pieces fit.
  res.forEach((r, i) => {
    if (Array.isArray(r)) { added += addInit(reg, r); return; }
    const [f, t] = ranges[i];
    if (t - f > 2000n) { const m = f + (t - f) / 2n; failed.push([f.toString(), m.toString()], [m.toString(), t.toString()]); }
    else failed.push([f.toString(), t.toString()]);
  });
  return { failed, added };
}
async function updateV4Registry(state, head) {
  const reg = state.v4reg || (state.v4reg = { to: null, gaps: [], pools: {} });
  const ranges = [];
  for (const [f, t] of reg.gaps || []) ranges.push([BigInt(f), BigInt(t)]);   // retry earlier failures first
  const start = reg.to != null ? BigInt(reg.to) : V4_START;
  for (let f = start; f < head; f += CH) ranges.push([f, f + CH > head ? head : f + CH]);
  const { failed, added } = await scanInitRanges(reg, ranges);
  reg.gaps = failed; reg.to = head.toString();
  console.log(`[disc] V4 registry: ${Object.keys(reg.pools).length} USDC pools (+${added} new), scanned ${ranges.length} ranges${failed.length ? `, ${failed.length} FAILED (retry next run)` : ''}`);
  return reg;
}

// Batched parallel eth_call (reliable — no hand-rolled ABI encoding). Returns results aligned to `calls`.
async function batchCall(calls, limit = 12) {
  return runLimited(calls.map((c) => async () => { const r = await call(c.target, c.data); return { data: r || '0x' }; }), limit);
}
// Decode a solidity `string`/`bytes32` return into text.
const decStr = (hex) => {
  try {
    const b = (hex || '').replace(/^0x/, ''); if (!b || /^0+$/.test(b)) return '';
    if (b.length === 64) { let s = ''; for (let i = 0; i < 64; i += 2) { const c = parseInt(b.substr(i, 2), 16); if (c >= 32 && c < 127) s += String.fromCharCode(c); } return s; } // bytes32
    if (b.length < 128) return '';
    const len = parseInt(b.slice(64, 128), 16); if (!Number.isFinite(len) || len > 200) return '';
    // ⛔ 09-25 audit: decoded byte-by-byte with fromCharCode, so every multi-byte UTF-8 name came out as mojibake
    // ("Circle Internet Group â¢ Arc Token", "StÃ©phane"). Decode the bytes as UTF-8; drop NULs/control characters.
    return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f\u007f\ufffd]/g, '').trim();
  } catch { return ''; }
};

async function main() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { cursor: 0, tokens: {} };
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  const from = state.cursor ? BigInt(state.cursor) : BigInt(head) - INITIAL_LOOKBACK;
  console.log(`[disc] head ${head} scan from ${from} (${state.cursor ? 'incremental' : 'initial sweep'}) — known ${Object.keys(state.tokens).length}`);

  // ── 1) NEW V3 USDC pools from PoolCreated ─────────────────────────────────────────────────────────
  const v3logs = await scanLogs(V3_FACTORY, [T_V3_CREATE], from, BigInt(head));
  const v3cand = [];
  for (const l of v3logs) {
    const t0 = ('0x' + l.topics[1].slice(26)).toLowerCase(), t1 = ('0x' + l.topics[2].slice(26)).toLowerCase();
    const usdc = t0 === USDC || t1 === USDC; if (!usdc) continue;
    const token = t0 === USDC ? t1 : t0;
    const pool = ('0x' + l.data.slice(-40)).toLowerCase();
    if (!state.tokens[token]) v3cand.push({ token, pool, usdcIsToken0: t0 === USDC, created: parseInt(l.blockNumber, 16) });
  }
  console.log(`[disc] V3 new USDC pools: ${v3cand.length}`);

  // ── 1b) ONE-TIME: every V3 USDC pool from the factory's deploy up to where the first sweep began ────────────────
  // Queued into the same backlog the liquidity check drains (MAX_NEW_PER_RUN per run), so a run never hangs on it.
  // Marked done only when every range answered — a failed range means the whole backfill runs again next time.
  if (!state.v3histDone) {
    const histTo = BigInt(state.v3histTo || (state.cursor ? Math.max(0, head - Number(INITIAL_LOOKBACK)) : head));
    // First run: the whole range. Later runs: only the ranges that failed, each split in half (a range that fails
    // again is usually one with more logs than the RPC returns per call — same fix as the V4 registry's gaps).
    const ranges = state.v3histGaps ? state.v3histGaps.map(([f, t]) => [BigInt(f), BigInt(t)]) : [];
    if (!state.v3histGaps) for (let f = V3_START; f < histTo; f += CH) ranges.push([f, f + CH > histTo ? histTo : f + CH]);
    const res = await runLimited(ranges.map(([f, t]) => () => rpc('eth_getLogs', [{ address: V3_FACTORY, topics: [T_V3_CREATE], fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }], true)), 8);
    const gaps = [];
    res.forEach((r, i) => { if (Array.isArray(r)) return; const [f, t] = ranges[i];
      if (t - f > 2000n) { const m = f + (t - f) / 2n; gaps.push([f.toString(), m.toString()], [m.toString(), t.toString()]); } else gaps.push([f.toString(), t.toString()]); });
    let failed = 0, queued = 0;
    const inQueue = new Set([...(state.v3backlog || []), ...v3cand].map((c) => c.pool));
    for (const r of res) {
      if (!Array.isArray(r)) { failed++; continue; }
      for (const l of r) {
        const t0 = ('0x' + l.topics[1].slice(26)).toLowerCase(), t1 = ('0x' + l.topics[2].slice(26)).toLowerCase();
        if (t0 !== USDC && t1 !== USDC) continue;
        const token = t0 === USDC ? t1 : t0, pool = ('0x' + l.data.slice(-40)).toLowerCase();
        if (state.tokens[token] || inQueue.has(pool)) continue;
        inQueue.add(pool); queued++;
        (state.v3backlog || (state.v3backlog = [])).push({ token, pool, usdcIsToken0: t0 === USDC, created: parseInt(l.blockNumber, 16) });
      }
    }
    state.v3histTo = histTo.toString();
    state.v3histGaps = gaps;
    if (!gaps.length) { state.v3histDone = true; delete state.v3histGaps; }
    console.log(`[disc] V3 history sweep ${V3_START}..${histTo}: ${ranges.length} ranges, queued ${queued} USDC pools${failed ? `, ${failed} ranges FAILED — retried (halved) next run` : ' — done'}`);
  }

  // ── 2) ACTIVE V4 pools from recent Swap events (activity = the real-vs-decoy signal) ──────────────
  // Recent swaps are dense (~7k logs / 2k blocks), so scan a SHORT window in SMALL chunks. Then resolve
  // each active poolId's currencies from ONE bulk Initialize map (scanned once, not per pool).
  const v4swaps = await scanLogs(PM_V4, [T_V4_SWAP], BigInt(head) - V4_ACTIVE_WINDOW, BigInt(head), 2000n);
  const v4active = new Map(); for (const l of v4swaps) v4active.set(l.topics[1], (v4active.get(l.topics[1]) || 0) + 1);
  const activeIds = [...v4active].filter(([, c]) => c >= 3);
  const v4cand = [];
  const reg = await updateV4Registry(state, BigInt(head));
  const regGet = (poolId) => { const r = reg.pools[poolId]; return r ? { c0: r[0], c1: r[1], created: r[2], hooks: r[3], fee: r[4], tickSpacing: r[5] } : null; };
  if (activeIds.length) {
    const idMap = { get: regGet }; // every USDC pool ever initialized, not just the last run's
    // ⛔ A token can have MANY active pools — real + WASH-TRADED DECOYS (GLITCH's real pool had 5736 swaps,
    // a decoy 38). Group by token and keep the poolId with the MOST swaps, so price/vol come from the real one.
    const byToken = new Map();
    for (const [poolId, cnt] of activeIds) {
      const cc = idMap.get(poolId); if (!cc) continue;
      if (cc.c0 !== USDC && cc.c1 !== USDC) continue;
      const token = cc.c0 === USDC ? cc.c1 : cc.c0;
      const prev = byToken.get(token);
      if (!prev || cnt > prev.cnt) byToken.set(token, { poolId, cnt, usdcIsC0: cc.c0 === USDC, created: cc.created, hooks: cc.hooks, fee: cc.fee, tickSpacing: cc.tickSpacing });
    }
    for (const [token, info] of byToken) {
      const known = state.tokens[token];
      if (known && known.poolId === info.poolId) continue; // already have the best pool
      if (known && known.cnt != null && known.cnt >= info.cnt) continue; // keep the better existing choice
      // new token, OR upgrade an existing token whose stored pool was a weaker (decoy) one
      if (known) { known.poolId = info.poolId; known.usdcIsC0 = info.usdcIsC0; known.cnt = info.cnt; known.hooks = info.hooks; continue; }
      v4cand.push({ token, poolId: info.poolId, usdcIsC0: info.usdcIsC0, created: info.created, cnt: info.cnt, hooks: info.hooks });
    }
  }
  console.log(`[disc] V4 active pools: ${v4active.size}, new USDC tokens: ${v4cand.length}`);

  // Supplement V4 discovery with the subgraph's complete pool list — catches real USDC pools our
  // activity-based getLogs scan missed. ADD-ONLY: only tokens we don't already know and haven't queued;
  // they then flow through the SAME metadata + on-chain price/liquidity + impersonator + MIN_LIQ pipeline as
  // every other token, so nothing here is trusted beyond "this poolId exists for this token".
  const sgV4ByToken = new Map(); // token -> its top V4 pool (subgraph); lets a V3-primary token aggregate its V4-pool VOLUME
  {
    const sgCands = await fetchSubgraphV4Cands();
    for (const c of sgCands) sgV4ByToken.set(c.token.toLowerCase(), c);
    const inCand = new Set(v4cand.map((c) => c.token));
    let added = 0;
    for (const c of sgCands) {
      if (state.tokens[c.token] || inCand.has(c.token)) continue;
      v4cand.push({ token: c.token, poolId: c.poolId, usdcIsC0: c.usdcIsC0, created: c.created, cnt: null, hooks: c.hooks });
      inCand.add(c.token); added++;
    }
    console.log(`[disc] subgraph V4 supplement: +${added} new tokens (from ${sgCands.length} subgraph pools)`);
  }

  // ── 3) Filter V3 candidates by REAL USDC liquidity (parallel eth_getBalance) ───────────────────────
  // Only MAX_NEW_PER_RUN are checked per run; the rest carry over in a backlog (so a run never hangs on
  // the ~19k historical candidates). New pools jump the queue via the fresh scan above.
  const v3all = [...(state.v3backlog || []), ...v3cand];
  const v3slice = v3all.slice(0, MAX_NEW_PER_RUN);
  state.v3backlog = v3all.slice(MAX_NEW_PER_RUN);
  const bals = await runLimited(v3slice.map((c) => async () => { const b = await rpc('eth_getBalance', [c.pool, 'latest']); return b ? Number(BigInt(b)) / 1e18 : 0; }), 12);
  const v3keep = v3slice.map((c, i) => ({ ...c, usdc: bals[i] })).filter((c) => c.usdc >= MIN_USDC);
  console.log(`[disc] V3 checked ${v3slice.length}/${v3all.length} (backlog ${state.v3backlog.length}), real: ${v3keep.length}`);

  // ── 4) Metadata for all NEW real tokens (symbol/name/decimals/totalSupply via Multicall) ──────────
  const newTokens = [...v3keep.map((x) => ({ ...x, kind: 'v3' })), ...v4cand.map((x) => ({ ...x, kind: 'v4' }))];
  if (newTokens.length) {
    const calls = [];
    // symbol, name, decimals, totalSupply, image-URI (0xfb7f21eb, launchpad token logo)
    for (const t of newTokens) { calls.push({ target: t.token, data: '0x95d89b41' }, { target: t.token, data: '0x06fdde03' }, { target: t.token, data: '0x313ce567' }, { target: t.token, data: '0x18160ddd' }, { target: t.token, data: '0xfb7f21eb' }); }
    const mr = await batchCall(calls);
    newTokens.forEach((t, i) => {
      const sym = decStr(mr[i * 5]?.data) || '?';
      const nm = decStr(mr[i * 5 + 1]?.data) || sym;
      const decHex = mr[i * 5 + 2]?.data; const dec = decHex && decHex !== '0x' ? parseInt(decHex.slice(0, 66), 16) : 18;
      const supHex = mr[i * 5 + 3]?.data;
      let icon = decStr(mr[i * 5 + 4]?.data) || null; if (icon && !/^(https?:|ipfs:|ar:)/i.test(icon)) icon = null; // only keep a real URI (client resolves ipfs)
      state.tokens[t.token] = { symbol: sym, name: nm, decimals: Number.isFinite(dec) && dec <= 36 ? dec : 18,
        kind: t.kind, pool: t.pool || null, poolId: t.poolId || null, usdcIsC0: t.usdcIsC0 ?? t.usdcIsToken0 ?? false,
        supplyRaw: supHex && supHex !== '0x' ? supHex : null, created: t.created || null, cnt: t.cnt ?? null, hooks: t.hooks || null, iconUrl: icon, firstSeen: Date.now() };
    });
    // ⛔ Age from (head-created)*blockTime is inaccurate over millions of blocks (block time isn't constant
    // → some V3 pools showed 66-103d on a days-old chain). Read the creation block's REAL timestamp ONCE.
    const withBlk = newTokens.filter((t) => t.created);
    const tss = await runLimited(withBlk.map((t) => async () => { const b = await rpc('eth_getBlockByNumber', ['0x' + t.created.toString(16), false]); return b && b.timestamp ? Number(BigInt(b.timestamp)) * 1000 : null; }), 8);
    withBlk.forEach((t, i) => { if (tss[i] && state.tokens[t.token]) state.tokens[t.token].createdAt = tss[i]; });
  }
  console.log(`[disc] added ${newTokens.length} new tokens`);

  // Every token with a V4 pool gets its full PoolKey (fee, tickSpacing, hooks) from the registry, so the site can
  // quote + route a swap through that pool without scanning for its Initialize event itself.
  for (const t of Object.values(state.tokens)) {
    if (!t.poolId) continue;
    const k = regGet(t.poolId);
    if (k) { t.v4fee = k.fee; t.v4tick = k.tickSpacing; t.hooks = k.hooks; }
  }

  // ── 4b) V2 pairs: WarpV2 (Warp's own exchange — graduated Warp tokens, e.g. WARP's real $25.9K market) and the other
  // UniV2 factory. 09-26: neither was read, so WARP showed $1.77K from a side V4 pool. Both factories are small (54 pairs
  // total), so every pair is enumerated each run. A V2-only token becomes kind 'v2'; a token that also has a V2 pair gets
  // its liquidity + volume added below, and its price from the V2 pair when that pair is its deepest pool.
  const V2_FACTORIES = { '0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10': 'V2', '0x32330c2400a6e0830d56661169ebb6c147e3577a': 'WarpV2' };
  state.v2pairs = state.v2pairs || {};
  for (const [fac, label] of Object.entries(V2_FACTORIES)) {
    const n = Number(BigInt((await call(fac, '0x574f2ba3')) || '0x0')); // allPairsLength()
    const idx = []; for (let i = 0; i < n; i++) idx.push(i);
    const known = new Set(Object.values(state.v2pairs).filter((p) => p.fac === fac).map((p) => p.i));
    const need = idx.filter((i) => !known.has(i));
    const addrs = await batchCall(need.map((i) => ({ target: fac, data: '0x1e3dd18b' + padU(i) }))); // allPairs(i)
    const pairs = addrs.map((r) => (r.data && r.data.length >= 66 ? ('0x' + r.data.slice(-40)).toLowerCase() : null));
    const t01 = await batchCall(pairs.flatMap((p) => (p ? [{ target: p, data: '0x0dfe1681' }, { target: p, data: '0xd21220a7' }] : [])));
    let k = 0;
    need.forEach((i, j) => { const p = pairs[j]; if (!p) return; const t0 = ('0x' + (t01[k++]?.data || '').slice(-40)).toLowerCase(), t1 = ('0x' + (t01[k++]?.data || '').slice(-40)).toLowerCase(); state.v2pairs[p] = { fac, label, i, t0, t1 }; });
  }
  const v2ByToken = new Map(); // token -> [{pair, usdcIsC0, label}]
  for (const [pair, p] of Object.entries(state.v2pairs)) {
    if (p.t0 !== USDC && p.t1 !== USDC) continue;
    const tok = p.t0 === USDC ? p.t1 : p.t0;
    (v2ByToken.get(tok) || v2ByToken.set(tok, []).get(tok)).push({ pair, usdcIsC0: p.t0 === USDC, label: p.label });
  }
  // V2-only tokens we don't know yet → new kind 'v2' entries (metadata read like any other new token)
  const v2new = [...v2ByToken.entries()].filter(([tok]) => !state.tokens[tok]);
  if (v2new.length) {
    const md = await batchCall(v2new.flatMap(([tok]) => [{ target: tok, data: '0x95d89b41' }, { target: tok, data: '0x06fdde03' }, { target: tok, data: '0x313ce567' }, { target: tok, data: '0x18160ddd' }]));
    v2new.forEach(([tok, ps], i) => {
      const sym = decStr(md[i * 4]?.data) || '?', nm = decStr(md[i * 4 + 1]?.data) || sym, dh = md[i * 4 + 2]?.data, dec = dh && dh !== '0x' ? parseInt(dh.slice(0, 66), 16) : 18;
      state.tokens[tok] = { symbol: sym, name: nm, decimals: Number.isFinite(dec) && dec <= 36 ? dec : 18, kind: 'v2', pool: ps[0].pair, poolId: null, usdcIsC0: ps[0].usdcIsC0, supplyRaw: md[i * 4 + 3]?.data || null, created: null, cnt: null, hooks: null, iconUrl: null, firstSeen: Date.now(), dex: ps[0].label };
    });
  }
  console.log(`[disc] V2 pairs: ${Object.keys(state.v2pairs).length} known, ${[...v2ByToken.values()].flat().length} USDC pairs, ${v2new.length} new V2-only tokens`);

  // ── 5) Re-price EVERY known token on-chain (they move) ────────────────────────────────────────────
  const entries = Object.entries(state.tokens);
  const priceCalls = [];
  for (const [addr, t] of entries) {
    if (t.kind === 'v3') priceCalls.push({ target: t.pool, data: '0x3850c7bd', _a: addr, _k: 'slot0' });
    else if (t.kind === 'v2') priceCalls.push({ target: t.pool, data: '0x0902f1ac', _a: addr, _k: 'reserves' }); // getReserves()
    else priceCalls.push({ target: PM_V4, data: '0x1e2eaeaf' + v4StateSlot(t.poolId).slice(2), _a: addr, _k: 'v4state' });
  }
  const pr = await batchCall(priceCalls);
  // block time + head timestamp (for age + the 24h swap window)
  const hb = await rpc('eth_getBlockByNumber', ['0x' + head.toString(16), false]);
  const ob = await rpc('eth_getBlockByNumber', ['0x' + (head - 20000).toString(16), false]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const blocks24 = Math.min(400000, Math.ceil(86400 / blockTime));
  // Retry the creation-block timestamp for any known token that still lacks a real one (a failed fetch at
  // discovery left it on the inaccurate block-extrapolation → the ~1% of "103d" ages). Self-heals each run.
  const needTs = entries.filter(([, t]) => t.created && !t.createdAt).slice(0, 60);
  if (needTs.length) {
    const got = await runLimited(needTs.map(([, t]) => async () => { const b = await rpc('eth_getBlockByNumber', ['0x' + t.created.toString(16), false]); return b && b.timestamp ? Number(BigInt(b.timestamp)) * 1000 : null; }), 8);
    needTs.forEach(([addr], i) => { if (got[i]) state.tokens[addr].createdAt = got[i]; });
  }

  // decode prices, and read each pool's live USDC liquidity (V3 = pool native balance; V4 = token side × price)
  const rows = entries.map(([addr, t], i) => { const r = pr[i], dec = t.decimals; let price = null;
    try {
      if (t.kind === 'v3' && r?.data && r.data.length >= 66) { const sq = BigInt(r.data.slice(0, 66)); if (sq > 0n) { const ra = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ra : ra) * 10 ** (dec - 6); } }
      else if (t.kind === 'v2' && r?.data && r.data.length >= 130) { const r0 = Number(BigInt('0x' + r.data.slice(2, 66))), r1 = Number(BigInt('0x' + r.data.slice(66, 130))); const u = t.usdcIsC0 ? r0 : r1, k = t.usdcIsC0 ? r1 : r0; if (u > 0 && k > 0) price = (u / 1e6) / (k / 10 ** dec); }
      else if (t.kind === 'v4' && r?.data && r.data !== '0x') { const sq = BigInt(r.data) & ((1n << 160n) - 1n); if (sq > 0n) { const ra = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ra : ra) * 10 ** (dec - 6); } }
    } catch { /* */ }
    if ((price == null || !isFinite(price) || price <= 0 || price >= 1e6) && t.lastPrice) price = t.lastPrice; // keep last-good on a transient RPC miss so tokens don't flicker out
    return { addr, t, price };
  }).filter((x) => x.price != null && isFinite(x.price) && x.price > 0 && x.price < 1e6);

  // ⛔ 09-25: V3 pools were valued by their USDC side ONLY — cirBTC's main pool holds $6.06M USDC AND 64.5 cirBTC ($5.44M),
  // so the screener said $6.2M where the chain (and the token page) say $11.6M. Liquidity = BOTH sides now. The token
  // side counts for at most 3x the pool's USDC: real two-sided pools run ~0.9-2x (cirBTC 0.9, CRCL 1.3, ARCADE ~2), while
  // a pile of tokens valued at spot next to a few $K of USDC is not liquidity (FIAT: $2.4K USDC read as $247K at 100x).
  // Same cap on the token page's pools card (arc.ts fetchAllOnchainPools), so both pages agree.
  const V3_TOKEN_SIDE_MAX = 3;
  const v3Side = (tokUsd, usdc) => (isFinite(tokUsd) && tokUsd > 0 ? Math.min(tokUsd, usdc * V3_TOKEN_SIDE_MAX) : 0);
  const liqs = await runLimited(rows.map((x) => async () => {
    if (x.t.kind === 'v3') {
      // A V3-primary token can ALSO have a V4 pool (ARGUS = $744K V3 + ~$355K V4). Read BOTH: the V3 pool's
      // native USDC AND the token side the V4 singleton holds (priced), so the aggregate is the TRUE total
      // locked across the token's pools, not just its biggest one. (V4-primary tokens already count this via
      // their own balanceOf(PM) read below.) balanceOf(PM_V4)==0 for a V3-only token, so this adds nothing.
      const [b, vb, pb] = await Promise.all([
        rpc('eth_getBalance', [x.t.pool, 'latest']),
        call(x.addr, '0x70a08231' + pad(PM_V4)).catch(() => null),
        call(x.addr, '0x70a08231' + pad(x.t.pool)).catch(() => null), // the V3 pool's TOKEN side
      ]);
      if (b == null || vb == null || pb == null) return null; // a FAILED read is not $0 (see below)
      const v3usdc = Number(BigInt(b)) / 1e18;
      const v3tok = pb !== '0x' ? Number(BigInt(pb)) / 10 ** x.t.decimals : 0;
      const v4tok = vb !== '0x' ? Number(BigInt(vb)) / 10 ** x.t.decimals : 0;
      return v3usdc + v3Side(v3tok * x.price, v3usdc) + v4tok * x.price;
    }
    if (x.t.kind === 'v2') { const b = await rpc('eth_getBalance', [x.t.pool, 'latest']); if (b == null) return null; return 2 * Number(BigInt(b)) / 1e18; } // constant product: both sides equal
    const b = await call(x.addr, '0x70a08231' + pad(PM_V4)); if (b == null) return null;
    const tok = b !== '0x' ? Number(BigInt(b)) / 10 ** x.t.decimals : 0; return tok * x.price; // V4: token side value (all its V4 pools)
  }), 12);
  // ⛔ A rate-limited read used to count as $0 liquidity → under the $100 floor → the token vanished from the
  // screener for a cycle (09-25 A/B: 91 tokens incl. the real ARGUS dropped on a busy run). Same rule as price:
  // a failed read keeps the last good value.
  rows.forEach((x, i) => { x.liq = liqs[i] != null ? liqs[i] : (x.t.lastLiq ?? 0); });
  // V2 / WarpV2 pairs of tokens whose primary pool is elsewhere: add their depth (2 × USDC reserve); when a V2 pair is the
  // DEEPEST market, it also sets the price (WARP: WarpV2 $25.9K vs a $1.8K side V4 pool).
  {
    const extra = rows.filter((x) => x.t.kind !== 'v2' && v2ByToken.has(x.addr));
    for (const x of extra) {
      let add = 0, bestU = 0, bestPx = null;
      for (const p of v2ByToken.get(x.addr)) {
        const r = await call(p.pair, '0x0902f1ac'); if (!r || r.length < 130) continue;
        const r0 = Number(BigInt('0x' + r.slice(2, 66))), r1 = Number(BigInt('0x' + r.slice(66, 130)));
        const u = (p.usdcIsC0 ? r0 : r1) / 1e6, k = (p.usdcIsC0 ? r1 : r0) / 10 ** x.t.decimals;
        if (u < MIN_USDC || !(k > 0)) continue;
        add += 2 * u; if (u > bestU) { bestU = u; bestPx = u / k; }
      }
      if (add > 0) { if (bestU * 2 > x.liq && bestPx > 0 && bestPx < 1e6) x.price = bestPx; x.liq += add; x.v2 = true; }
    }
  }

  // HOLDERS from arc-scan for EVERY token we'll output (not just the old top-300-by-liq) — else a real
  // token whose count we never fetched shows holders:null and is wrongly hidden by the screener's default
  // 50-holder filter. arc-scan (api.arc-scan.org) is fast, unblocked from the VPS, and has counts across the
  // whole liq spectrum (measured: 30/30 incl. low-liq tokens). ⛔ Blockscout/explorer.arc.io is Cloudflare-
  // challenge-blocked even with a browser UA, so it is NOT usable as a source. Cached ~6h in state; capped
  // per run (highest-liquidity first) so the cache fills over a couple runs without hammering arc-scan.
  const HOLDERS_TTL = 6 * 3600 * 1000, HOLDERS_MAX_PER_RUN = Number(process.env.ONCHAIN_HOLDERS_MAX || 800);
  const needH = rows.filter((x) => x.liq >= MIN_LIQ).sort((a, b) => b.liq - a.liq)
    .filter((x) => { const st = state.tokens[x.addr]; return !st.holders || (Date.now() - (st.holdersAt || 0) > HOLDERS_TTL); })
    .slice(0, HOLDERS_MAX_PER_RUN);
  if (needH.length) {
    const hr = await runLimited(needH.map((x) => async () => {
      try { const r = await fetch(`https://api.arc-scan.org/v1/tokens/${x.addr}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); return j.holders != null ? Number(j.holders) : null; } catch { return null; }
    }), 8);
    needH.forEach((x, i) => { if (hr[i] != null && isFinite(hr[i])) { state.tokens[x.addr].holders = hr[i]; state.tokens[x.addr].holdersAt = Date.now(); } });
    console.log(`[disc] holders fetched for ${needH.length} tokens (arc-scan, full-coverage)`);
  }

  // ── Supply + names, re-read ─────────────────────────────────────────────────────────────────────────────────────────────
  // ⛔ 09-25 audit: market cap used the totalSupply captured ONCE at discovery. Tokens that mint or burn drift — cirBTC showed
  // $43M where live supply × price is ~$398M (supply grew ~9x), WETH 7x low. Re-read it every run for every token we output.
  // Names stored before the UTF-8 fix are repaired once (any Latin-1 mojibake character).
  {
    const outRows = rows.filter((x) => x.liq >= MIN_LIQ);
    const sup = await batchCall(outRows.map((x) => ({ target: x.addr, data: '0x18160ddd' })));
    outRows.forEach((x, i) => { const h = sup[i]?.data; if (h && h !== '0x' && h.length >= 66) state.tokens[x.addr].supplyRaw = h.slice(0, 66); });
    const moji = outRows.filter((x) => /[\u0080-\u00ff]/.test((x.t.name || '') + (x.t.symbol || '')) && !x.t.nameFixed);
    if (moji.length) {
      const r = await batchCall(moji.flatMap((x) => [{ target: x.addr, data: '0x95d89b41' }, { target: x.addr, data: '0x06fdde03' }]));
      moji.forEach((x, i) => { const sy = decStr(r[i * 2]?.data), nm = decStr(r[i * 2 + 1]?.data); const st = state.tokens[x.addr]; if (sy) st.symbol = sy; if (nm) st.name = nm; st.nameFixed = true; });
    }
    console.log(`[disc] supply refreshed for ${outRows.length} tokens; ${moji.length} mojibake names re-read`);
  }

  // 24h volume + change from each LIQUID pool's own swaps. Scanning every one floods the RPCs (→ zeros),
  // so scan the most-liquid TOP_VOL tokens (covers everything with real volume; sub-floor nanocaps have
  // ~$0 volume anyway). Verified: GLITCH scans to $18.7k/24h.
  const TOP_VOL = Number(process.env.ONCHAIN_TOP_VOL || 150);
  const withLiq = rows.filter((x) => x.liq >= VOL_FLOOR);
  const byLiq = [...withLiq].sort((a, b) => b.liq - a.liq).slice(0, TOP_VOL);
  const active = withLiq.filter((x) => (x.t.cnt || 0) >= 50); // active launchpad coins (GLITCH cnt 880) even if liq-rank is lower
  const withV2 = withLiq.filter((x) => x.v2 || x.t.kind === 'v2'); // V2/WarpV2 markets (54 pairs total — always scanned)
  const liquid = [...new Map([...byLiq, ...active, ...withV2].map((x) => [x.addr, x])).values()];
  const ranges = []; for (let f = BigInt(head) - BigInt(blocks24); f < BigInt(head); f += CH) ranges.push([f, f + CH > BigInt(head) ? BigInt(head) : f + CH]);
  // AGGREGATE a token's 24h volume across ALL its USDC pools (V3 fee tiers + its V4 pool), not just the
  // deepest — a token split across pools was undercounting. (V2 is absent on Arc.) Both V3 & V4 Swaps put
  // sqrtPriceX96 in data word 2, so one decoder handles both. Change % comes from the deepest (primary) pool.
  async function poolsOf(x) {
    const pools = []; let extraUsdc = 0;
    if (x.t.pool) pools.push({ kind: x.t.kind === 'v2' ? 'v2' : 'v3', address: x.t.pool, usdcIsC0: x.t.usdcIsC0, primary: true });
    if (x.t.poolId) pools.push({ kind: 'v4', poolId: x.t.poolId, usdcIsC0: x.t.usdcIsC0, primary: true });
    // A V3-primary token (has a V3 pool, no stored poolId) can ALSO trade on a V4 pool the subgraph knows.
    // Add it so 24h VOLUME sums across V3 + V4, not just the primary. (Liquidity already aggregates V4 via
    // the balanceOf read; this pool is volume-only here and never touches extraUsdc, so no double count.)
    else if (x.t.pool) { const sg = sgV4ByToken.get(x.addr.toLowerCase()); if (sg?.poolId) pools.push({ kind: 'v4', poolId: sg.poolId, usdcIsC0: sg.usdcIsC0, primary: false }); }
    // Every OTHER active V4 USDC pool of this token counts toward its volume too (09-25 audit: MURMUR trades on two real V4
    // pools, $213K + $115K, and only the primary was counted). Active = 20+ swaps in the recent window; the per-swap 20x
    // price filter below still drops junk pools.
    for (const pid of v4ByToken.get(x.addr) || []) {
      if (pid === x.t.poolId || pools.some((p) => p.poolId === pid) || (v4active.get(pid) || 0) < 20) continue;
      const r = reg.pools[pid]; pools.push({ kind: 'v4', poolId: pid, usdcIsC0: r[0] === USDC, primary: false });
    }
    for (const p of v2ByToken.get(x.addr) || []) if (!pools.some((q) => q.address === p.pair)) pools.push({ kind: 'v2', address: p.pair, usdcIsC0: p.usdcIsC0, primary: x.t.kind === 'v2' && x.t.pool === p.pair });
    const seen = new Set(pools.filter((p) => p.address).map((p) => p.address));
    const cand = await Promise.all([100, 500, 3000, 10000].map((fee) => call(V3_FACTORY, '0x1698ee82' + pad(x.addr) + pad(USDC) + fee.toString(16).padStart(64, '0')).catch(() => null)));
    for (const r of cand) {
      const p = r && r.length >= 42 ? ('0x' + r.slice(-40)).toLowerCase() : null;
      if (!p || p === ZERO || seen.has(p)) continue; seen.add(p);
      const [bal, t0, tb] = await Promise.all([rpc('eth_getBalance', [p, 'latest']).catch(() => null), call(p, '0x0dfe1681').catch(() => null), call(x.addr, '0x70a08231' + pad(p)).catch(() => null)]);
      const usdc = bal ? Number(BigInt(bal)) / 1e18 : 0;
      if (usdc < MIN_USDC) continue; // only real pools
      const tok = tb && tb !== '0x' ? Number(BigInt(tb)) / 10 ** x.t.decimals : 0;
      extraUsdc += usdc + v3Side(tok * x.price, usdc); // aggregate liquidity (both sides) across the token's other USDC pools
      pools.push({ kind: 'v3', address: p, usdcIsC0: t0 ? ('0x' + t0.slice(-40)).toLowerCase() === USDC : false, primary: false });
    }
    return { pools, extraUsdc };
  }
  const v4ByToken = new Map(); // token -> every USDC V4 poolId it has (from the registry)
  for (const [pid, r] of Object.entries(reg.pools)) { const tok = r[0] === USDC ? r[1] : r[0]; (v4ByToken.get(tok) || v4ByToken.set(tok, []).get(tok)).push(pid); }
  const blocks1h = Math.ceil(3600 / blockTime), cut1h = head - blocks1h;
  const dayMap = new Map();
  for (const x of liquid) {
    try {
      const { pools, extraUsdc } = await poolsOf(x);
      let vol = 0; let primaryPts = [];
      for (const pool of pools) {
        const spec = pool.kind === 'v4' ? { address: PM_V4, topics: [T_V4_SWAP, pool.poolId] } : pool.kind === 'v2' ? { address: pool.address, topics: [[T_V2_SWAP]] } : { address: pool.address, topics: [[T_V3_SWAP]] };
        const res = await Promise.all(ranges.map(([f, to]) => rpc('eth_getLogs', [{ ...spec, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }], true)));
        const pts = [];
        for (const logs of res) if (Array.isArray(logs)) for (const l of logs) {
          const d = l.data.slice(2);
          if (pool.kind === 'v2') { // amount0In, amount1In, amount0Out, amount1Out
            const w = (i) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
            const u = Number(pool.usdcIsC0 ? w(0) + w(2) : w(1) + w(3)) / 1e6, k = Number(pool.usdcIsC0 ? w(1) + w(3) : w(0) + w(2)) / 10 ** x.t.decimals;
            const price = k > 0 ? u / k : 0;
            if (!(price > 0) || (x.price > 0 && (price < x.price / 20 || price > x.price * 20))) continue;
            pts.push({ bn: Number(BigInt(l.blockNumber)), price, usd: u }); continue;
          }
          const sq = BigInt('0x' + d.slice(128, 192)); if (sq <= 0n) continue;
          const ra = (Number(sq) / 2 ** 96) ** 2; const price = (pool.usdcIsC0 ? 1 / ra : ra) * 10 ** (x.t.decimals - 6);
          // ⛔ DECIMALS-ROBUST garbage filter: skip swaps whose price is wildly off the token's real price
          // (a near-empty decoy pool's broken sqrtP decoded ONE swap to $1e36). This is value-independent,
          // so it works for 8-dec cirBTC, whale trades, everything — unlike a fixed $ cap that clipped real trades.
          if (!isFinite(price) || price <= 0 || (x.price > 0 && (price < x.price / 20 || price > x.price * 20))) continue;
          // Token amount word. V3 Swap AND V4 Swap both put amount0 in word 0 and amount1 in word 1, so the TOKEN is
          // word 1 when USDC is currency0, else word 0 — for BOTH kinds. ⛔⛔ V3 had this inverted (09-24): it read the
          // USDC amount as the token amount, so every V3 token's 24h volume was ~$0 at 18 decimals (ARK $0 vs $30.7K
          // real), 5-8x too high at 6 decimals (EURC, WETH), and ~800x at 8 (cirBTC → over the $1B cap → blank).
          const wi = pool.usdcIsC0 ? 1 : 0;
          let a = BigInt('0x' + d.slice(wi * 64, wi * 64 + 64)); if (a >= (1n << 255n)) a -= (1n << 256n);
          const usd = Math.abs(Number(a)) / 10 ** x.t.decimals * price;
          if (isFinite(usd) && usd >= 0) pts.push({ bn: Number(BigInt(l.blockNumber)), price, usd });
        }
        vol += pts.reduce((s, p) => s + p.usd, 0);
        if (pool.primary && pts.length) primaryPts = pts;
      }
      primaryPts.sort((a, b) => a.bn - b.bn);
      const chg = primaryPts.length && primaryPts[0].price > 0 ? ((primaryPts[primaryPts.length - 1].price - primaryPts[0].price) / primaryPts[0].price) * 100 : null;
      // 1H change: first price at/after (head - 1h) vs the latest.
      const recent = primaryPts.filter((p) => p.bn >= cut1h);
      const chg1h = recent.length >= 2 && recent[0].price > 0 ? ((recent[recent.length - 1].price - recent[0].price) / recent[0].price) * 100 : null;
      // Sparkline: downsample the 24h price series to ~24 points.
      let spark = null;
      if (primaryPts.length >= 4) { const N = 24, step = primaryPts.length / N; spark = []; for (let i = 0; i < N; i++) spark.push(primaryPts[Math.min(primaryPts.length - 1, Math.floor(i * step))].price); }
      if (process.env.DEBUG_VOL) console.log('VOL', x.t.symbol, 'pools', pools.length, 'vol', Math.round(vol), 'chg1h', chg1h == null ? '-' : chg1h.toFixed(1));
      dayMap.set(x.addr, { vol, chg, chg1h, spark, extraUsdc });
    } catch (e) { if (process.env.DEBUG_VOL) console.log('VOLERR', x.t.symbol, e.message); dayMap.set(x.addr, { vol: 0, chg: null, chg1h: null, spark: null, extraUsdc: 0 }); }
  }

  const out = [];
  for (const x of rows) {
    const { addr, t, price, liq } = x; const dec = t.decimals;
    if (IMPERSONATOR.has((t.symbol || '').toUpperCase()) && !IMPERSONATOR_ALLOW.has(addr.toLowerCase())) continue; // skip fake WETH/XRP/GOLD… but keep the real Circle-issued ones
    const supply = t.supplyRaw ? num(t.supplyRaw, dec) : null;
    const mcap = supply ? price * supply : null;
    const ds = dayMap.get(addr);
    // Sane volume: < $1B AND < 300× the pool's liquidity (a bad-decimals pool made cirBTC read $8.2B).
    const volCap = Math.min(1e9, (liq || 1e9) * 300);
    const vol = ds && isFinite(ds.vol) && ds.vol >= 0 && ds.vol < volCap ? ds.vol : null;
    const clampC = (c) => (c != null && isFinite(c) ? Math.max(-99, Math.min(9999, c)) : null);
    const chg = clampC(ds && ds.chg);
    const chg1h = clampC(ds && ds.chg1h);
    const spark = ds && Array.isArray(ds.spark) && ds.spark.every((n) => isFinite(n) && n > 0) ? ds.spark : null;
    // createdAt (ms): prefer the real creation-block timestamp; fall back to block-extrapolation.
    const createdAt = t.createdAt || (t.created ? Date.now() - Math.round((head - t.created) * blockTime) * 1000 : null);
    const aggLiq = (liq || 0) + (ds?.extraUsdc || 0); // liquidity summed across the token's USDC pools
    if (aggLiq < MIN_LIQ) continue; // only index pools over $100 of value (owner call — cleaner + faster)
    // "?" symbols: use the name if the symbol didn't decode; skip a token with neither.
    let symbol = t.symbol && t.symbol !== '?' ? t.symbol : (t.name && t.name !== '?' ? t.name.slice(0, 12) : null);
    if (!symbol) continue;
    out.push({ address: addr, symbol, name: t.name && t.name !== '?' ? t.name : symbol, decimals: dec, price,
      liq: aggLiq || null, mcap: mcap && mcap <= 1e10 ? mcap : null,
      volume24h: vol, change24h: chg, change1h: chg1h, spark, createdAt,
      holders: t.holders ?? null,
      iconUrl: t.iconUrl || null,
      // pool identity so the client can re-price the row LIVE (kills the ~15-min screener staleness).
      pool: t.pool || null, poolId: t.poolId || null, usdcIsC0: !!t.usdcIsC0, decimals: dec,
      v4fee: t.poolId && t.v4fee != null ? t.v4fee : null, v4tick: t.poolId && t.v4tick != null ? t.v4tick : null, hooks: t.poolId && t.hooks ? t.hooks : null,
      hooked: !!(t.hooks && t.hooks !== ZERO && /[1-9a-f]/.test(t.hooks.slice(2))),
      source: t.kind === 'v2' ? (t.dex || 'V2') : t.kind.toUpperCase(), launchpad: t.kind === 'v4' ? 'onchain' : null });
  }
  console.log(`[disc] priced ${out.length}, liquid (vol/chg scanned) ${liquid.length}`);

  for (const x of rows) { const st = state.tokens[x.addr]; if (st && x.liq > 0) st.lastLiq = x.liq; } // remember last-good liquidity
  for (const o of out) { const st = state.tokens[o.address]; if (st) st.lastPrice = o.price; } // remember last-good price
  state.cursor = head;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), count: out.length, tokens: out }));
  console.log(`[disc] priced ${out.length} on-chain tokens → ${OUT_FILE}; cursor=${head}`);
}
main().catch((e) => { console.error('[disc] FATAL', e); process.exit(1); });
