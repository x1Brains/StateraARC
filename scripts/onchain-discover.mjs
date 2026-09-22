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
const VOL_FLOOR = Number(process.env.ONCHAIN_MIN_LIQ || 100); // only scan 24h vol/change for tokens we'll keep (>= the $100 floor) — the vol scan is the bottleneck, so this is the real speedup
// Major-asset tickers that DON'T legitimately exist as launchpad mints on Arc — any on-chain token using
// them is an impersonator (fake "Wrapped Ether" $267M etc.), and its faked high price inflates the
// liquidity estimate so it ranks #1. Drop them from discovery. (Real ecosystem tokens come via RadarDEX.)
const IMPERSONATOR = new Set(['WETH', 'ETH', 'WBTC', 'BTC', 'CBBTC', 'USDT', 'USDC', 'DAI', 'XRP', 'SOL', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI', 'MATIC', 'SHIB', 'PEPE', 'TRX', 'LTC', 'DOT', 'GOLD', 'XAU', 'XAUM', 'SILVER', 'EURC', 'EUROC', 'USD', 'WBNB', 'STETH', 'TON', 'NVDA', 'AAPL', 'TSLA']);

const STATE_FILE = process.env.ONCHAIN_STATE || './onchain-state.json';
const OUT_FILE = process.env.ONCHAIN_OUT || './onchain-tokens.json';
const CH = 95000n;                       // getLogs range for the big-range RPCs
const INITIAL_LOOKBACK = BigInt(process.env.ONCHAIN_LOOKBACK || 1_200_000); // first run: how far back to sweep
const MAX_NEW_PER_RUN = Number(process.env.ONCHAIN_MAX_NEW || 3000); // V3 candidates to liquidity-check per run; the rest carry over in a backlog so a run never hangs on 19k checks
const V4_ACTIVE_WINDOW = BigInt(process.env.V4_ACTIVE_WINDOW || 40000); // blocks of recent V4 swaps to catch active launchpad pools
const MIN_USDC = Number(process.env.ONCHAIN_MIN_USDC || 60); // a V3 pool must hold >= this much USDC to be tracked (≈ $120 both-sides value)
const MIN_LIQ = Number(process.env.ONCHAIN_MIN_LIQ || 100);  // only OUTPUT tokens whose total pool value clears this — cuts nanocap noise + keeps the indexer lean/fast

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
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
  const out = []; for (const r of res) if (Array.isArray(r)) out.push(...r); return out;
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
    let s = ''; const d = b.slice(128, 128 + len * 2);
    for (let i = 0; i < d.length; i += 2) { const c = parseInt(d.substr(i, 2), 16); if (c) s += String.fromCharCode(c); }
    return s;
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

  // ── 2) ACTIVE V4 pools from recent Swap events (activity = the real-vs-decoy signal) ──────────────
  // Recent swaps are dense (~7k logs / 2k blocks), so scan a SHORT window in SMALL chunks. Then resolve
  // each active poolId's currencies from ONE bulk Initialize map (scanned once, not per pool).
  const v4swaps = await scanLogs(PM_V4, [T_V4_SWAP], BigInt(head) - V4_ACTIVE_WINDOW, BigInt(head), 2000n);
  const v4active = new Map(); for (const l of v4swaps) v4active.set(l.topics[1], (v4active.get(l.topics[1]) || 0) + 1);
  const activeIds = [...v4active].filter(([, c]) => c >= 3);
  const v4cand = [];
  if (activeIds.length) {
    const initLogs = await scanLogs(PM_V4, [T_V4_INIT], from, BigInt(head)); // sparse: one map for all
    const idMap = new Map();
    for (const l of initLogs) idMap.set(l.topics[1], { c0: ('0x' + l.topics[2].slice(26)).toLowerCase(), c1: ('0x' + l.topics[3].slice(26)).toLowerCase(), created: parseInt(l.blockNumber, 16), hooks: ('0x' + l.data.slice(2).slice(2*64 + 24, 2*64 + 64)).toLowerCase() });
    // ⛔ A token can have MANY active pools — real + WASH-TRADED DECOYS (GLITCH's real pool had 5736 swaps,
    // a decoy 38). Group by token and keep the poolId with the MOST swaps, so price/vol come from the real one.
    const byToken = new Map();
    for (const [poolId, cnt] of activeIds) {
      const cc = idMap.get(poolId); if (!cc) continue;
      if (cc.c0 !== USDC && cc.c1 !== USDC) continue;
      const token = cc.c0 === USDC ? cc.c1 : cc.c0;
      const prev = byToken.get(token);
      if (!prev || cnt > prev.cnt) byToken.set(token, { poolId, cnt, usdcIsC0: cc.c0 === USDC, created: cc.created, hooks: cc.hooks });
    }
    for (const [token, info] of byToken) {
      const known = state.tokens[token];
      if (known && known.poolId === info.poolId) continue; // already have the best pool
      if (known && known.cnt != null && known.cnt >= info.cnt) continue; // keep the better existing choice
      // new token, OR upgrade an existing token whose stored pool was a weaker (decoy) one
      if (known) { known.poolId = info.poolId; known.usdcIsC0 = info.usdcIsC0; known.cnt = info.cnt; continue; }
      v4cand.push({ token, poolId: info.poolId, usdcIsC0: info.usdcIsC0, created: info.created, cnt: info.cnt, hooks: info.hooks });
    }
  }
  console.log(`[disc] V4 active pools: ${v4active.size}, new USDC tokens: ${v4cand.length}`);

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

  // ── 5) Re-price EVERY known token on-chain (they move) ────────────────────────────────────────────
  const entries = Object.entries(state.tokens);
  const priceCalls = [];
  for (const [addr, t] of entries) {
    if (t.kind === 'v3') priceCalls.push({ target: t.pool, data: '0x3850c7bd', _a: addr, _k: 'slot0' });
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
      else if (t.kind === 'v4' && r?.data && r.data !== '0x') { const sq = BigInt(r.data) & ((1n << 160n) - 1n); if (sq > 0n) { const ra = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ra : ra) * 10 ** (dec - 6); } }
    } catch { /* */ }
    if ((price == null || !isFinite(price) || price <= 0 || price >= 1e6) && t.lastPrice) price = t.lastPrice; // keep last-good on a transient RPC miss so tokens don't flicker out
    return { addr, t, price };
  }).filter((x) => x.price != null && isFinite(x.price) && x.price > 0 && x.price < 1e6);

  const liqs = await runLimited(rows.map((x) => async () => {
    if (x.t.kind === 'v3') { const b = await rpc('eth_getBalance', [x.t.pool, 'latest']); return b ? Number(BigInt(b)) / 1e18 : 0; } // V3 pool USDC (native)
    const b = await call(x.addr, '0x70a08231' + pad(PM_V4)); const tok = b && b !== '0x' ? Number(BigInt(b)) / 10 ** x.t.decimals : 0; return tok * x.price; // V4: token side value
  }), 12);
  rows.forEach((x, i) => { x.liq = liqs[i]; });

  // HOLDERS from arc-scan for the top tokens by liquidity (bounded), cached ~6h in state so we don't
  // re-fetch every run. arc-scan is a REST indexer the VPS can reach (GLITCH 5969, ARGUS 19162 verified).
  const HOLDERS_TTL = 6 * 3600 * 1000, HOLDERS_TOP = Number(process.env.ONCHAIN_HOLDERS_TOP || 300);
  const needH = rows.filter((x) => x.liq >= 200).sort((a, b) => b.liq - a.liq).slice(0, HOLDERS_TOP)
    .filter((x) => { const st = state.tokens[x.addr]; return !st.holders || (Date.now() - (st.holdersAt || 0) > HOLDERS_TTL); });
  if (needH.length) {
    const hr = await runLimited(needH.map((x) => async () => {
      try { const r = await fetch(`https://api.arc-scan.org/v1/tokens/${x.addr}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); return j.holders != null ? Number(j.holders) : null; } catch { return null; }
    }), 6);
    needH.forEach((x, i) => { if (hr[i] != null && isFinite(hr[i])) { state.tokens[x.addr].holders = hr[i]; state.tokens[x.addr].holdersAt = Date.now(); } });
    console.log(`[disc] holders fetched for ${needH.length} tokens`);
  }

  // 24h volume + change from each LIQUID pool's own swaps. Scanning every one floods the RPCs (→ zeros),
  // so scan the most-liquid TOP_VOL tokens (covers everything with real volume; sub-floor nanocaps have
  // ~$0 volume anyway). Verified: GLITCH scans to $18.7k/24h.
  const TOP_VOL = Number(process.env.ONCHAIN_TOP_VOL || 150);
  const withLiq = rows.filter((x) => x.liq >= VOL_FLOOR);
  const byLiq = [...withLiq].sort((a, b) => b.liq - a.liq).slice(0, TOP_VOL);
  const active = withLiq.filter((x) => (x.t.cnt || 0) >= 50); // active launchpad coins (GLITCH cnt 880) even if liq-rank is lower
  const liquid = [...new Map([...byLiq, ...active].map((x) => [x.addr, x])).values()];
  const ranges = []; for (let f = BigInt(head) - BigInt(blocks24); f < BigInt(head); f += CH) ranges.push([f, f + CH > BigInt(head) ? BigInt(head) : f + CH]);
  // AGGREGATE a token's 24h volume across ALL its USDC pools (V3 fee tiers + its V4 pool), not just the
  // deepest — a token split across pools was undercounting. (V2 is absent on Arc.) Both V3 & V4 Swaps put
  // sqrtPriceX96 in data word 2, so one decoder handles both. Change % comes from the deepest (primary) pool.
  async function poolsOf(x) {
    const pools = []; let extraUsdc = 0;
    if (x.t.pool) pools.push({ kind: 'v3', address: x.t.pool, usdcIsC0: x.t.usdcIsC0, primary: true });
    if (x.t.poolId) pools.push({ kind: 'v4', poolId: x.t.poolId, usdcIsC0: x.t.usdcIsC0, primary: true });
    const seen = new Set(pools.filter((p) => p.address).map((p) => p.address));
    const cand = await Promise.all([100, 500, 3000, 10000].map((fee) => call(V3_FACTORY, '0x1698ee82' + pad(x.addr) + pad(USDC) + fee.toString(16).padStart(64, '0')).catch(() => null)));
    for (const r of cand) {
      const p = r && r.length >= 42 ? ('0x' + r.slice(-40)).toLowerCase() : null;
      if (!p || p === ZERO || seen.has(p)) continue; seen.add(p);
      const [bal, t0] = await Promise.all([rpc('eth_getBalance', [p, 'latest']).catch(() => null), call(p, '0x0dfe1681').catch(() => null)]);
      const usdc = bal ? Number(BigInt(bal)) / 1e18 : 0;
      if (usdc < MIN_USDC) continue; // only real pools
      extraUsdc += usdc; // aggregate liquidity across the token's other USDC pools
      pools.push({ kind: 'v3', address: p, usdcIsC0: t0 ? ('0x' + t0.slice(-40)).toLowerCase() === USDC : false, primary: false });
    }
    return { pools, extraUsdc };
  }
  const blocks1h = Math.ceil(3600 / blockTime), cut1h = head - blocks1h;
  const dayMap = new Map();
  for (const x of liquid) {
    try {
      const { pools, extraUsdc } = await poolsOf(x);
      let vol = 0; let primaryPts = [];
      for (const pool of pools) {
        const spec = pool.kind === 'v4' ? { address: PM_V4, topics: [T_V4_SWAP, pool.poolId] } : { address: pool.address, topics: [[T_V3_SWAP]] };
        const res = await Promise.all(ranges.map(([f, to]) => rpc('eth_getLogs', [{ ...spec, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }], true)));
        const pts = [];
        for (const logs of res) if (Array.isArray(logs)) for (const l of logs) {
          const d = l.data.slice(2); const sq = BigInt('0x' + d.slice(128, 192)); if (sq <= 0n) continue;
          const ra = (Number(sq) / 2 ** 96) ** 2; const price = (pool.usdcIsC0 ? 1 / ra : ra) * 10 ** (x.t.decimals - 6);
          // ⛔ DECIMALS-ROBUST garbage filter: skip swaps whose price is wildly off the token's real price
          // (a near-empty decoy pool's broken sqrtP decoded ONE swap to $1e36). This is value-independent,
          // so it works for 8-dec cirBTC, whale trades, everything — unlike a fixed $ cap that clipped real trades.
          if (!isFinite(price) || price <= 0 || (x.price > 0 && (price < x.price / 20 || price > x.price * 20))) continue;
          const wi = (pool.kind === 'v4' ? (pool.usdcIsC0 ? 1 : 0) : (pool.usdcIsC0 ? 0 : 1)); // token amount word
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
    if (IMPERSONATOR.has((t.symbol || '').toUpperCase())) continue; // skip fake WETH/XRP/GOLD… impersonators
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
      hooked: !!(t.hooks && t.hooks !== ZERO && /[1-9a-f]/.test(t.hooks.slice(2))),
      source: t.kind.toUpperCase(), launchpad: t.kind === 'v4' ? 'onchain' : null });
  }
  console.log(`[disc] priced ${out.length}, liquid (vol/chg scanned) ${liquid.length}`);

  for (const o of out) { const st = state.tokens[o.address]; if (st) st.lastPrice = o.price; } // remember last-good price
  state.cursor = head;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), count: out.length, tokens: out }));
  console.log(`[disc] priced ${out.length} on-chain tokens → ${OUT_FILE}; cursor=${head}`);
}
main().catch((e) => { console.error('[disc] FATAL', e); process.exit(1); });
