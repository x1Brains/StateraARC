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
const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const T_V3_CREATE = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'; // PoolCreated(token0,token1,fee,tickSpacing,pool)
const T_V4_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const T_V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const VOL_FLOOR = 50; // only scan 24h volume/change for tokens with at least this much liquidity (bounds cost)

const STATE_FILE = process.env.ONCHAIN_STATE || './onchain-state.json';
const OUT_FILE = process.env.ONCHAIN_OUT || './onchain-tokens.json';
const CH = 95000n;                       // getLogs range for the big-range RPCs
const INITIAL_LOOKBACK = BigInt(process.env.ONCHAIN_LOOKBACK || 1_200_000); // first run: how far back to sweep
const MAX_NEW_PER_RUN = Number(process.env.ONCHAIN_MAX_NEW || 3000); // V3 candidates to liquidity-check per run; the rest carry over in a backlog so a run never hangs on 19k checks
const V4_ACTIVE_WINDOW = BigInt(process.env.V4_ACTIVE_WINDOW || 40000); // blocks of recent V4 swaps to catch active launchpad pools
const MIN_USDC = 40;                     // a pool must hold at least this much USDC to count as real

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
    for (const l of initLogs) idMap.set(l.topics[1], { c0: ('0x' + l.topics[2].slice(26)).toLowerCase(), c1: ('0x' + l.topics[3].slice(26)).toLowerCase(), created: parseInt(l.blockNumber, 16) });
    // ⛔ A token can have MANY active pools — real + WASH-TRADED DECOYS (GLITCH's real pool had 5736 swaps,
    // a decoy 38). Group by token and keep the poolId with the MOST swaps, so price/vol come from the real one.
    const byToken = new Map();
    for (const [poolId, cnt] of activeIds) {
      const cc = idMap.get(poolId); if (!cc) continue;
      if (cc.c0 !== USDC && cc.c1 !== USDC) continue;
      const token = cc.c0 === USDC ? cc.c1 : cc.c0;
      const prev = byToken.get(token);
      if (!prev || cnt > prev.cnt) byToken.set(token, { poolId, cnt, usdcIsC0: cc.c0 === USDC, created: cc.created });
    }
    for (const [token, info] of byToken) {
      const known = state.tokens[token];
      if (known && known.poolId === info.poolId) continue; // already have the best pool
      if (known && known.cnt != null && known.cnt >= info.cnt) continue; // keep the better existing choice
      // new token, OR upgrade an existing token whose stored pool was a weaker (decoy) one
      if (known) { known.poolId = info.poolId; known.usdcIsC0 = info.usdcIsC0; known.cnt = info.cnt; continue; }
      v4cand.push({ token, poolId: info.poolId, usdcIsC0: info.usdcIsC0, created: info.created, cnt: info.cnt });
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
    for (const t of newTokens) { calls.push({ target: t.token, data: '0x95d89b41' }, { target: t.token, data: '0x06fdde03' }, { target: t.token, data: '0x313ce567' }, { target: t.token, data: '0x18160ddd' }); }
    const mr = await batchCall(calls);
    newTokens.forEach((t, i) => {
      const sym = decStr(mr[i * 4]?.data) || '?';
      const nm = decStr(mr[i * 4 + 1]?.data) || sym;
      const decHex = mr[i * 4 + 2]?.data; const dec = decHex && decHex !== '0x' ? parseInt(decHex.slice(0, 66), 16) : 18;
      const supHex = mr[i * 4 + 3]?.data;
      state.tokens[t.token] = { symbol: sym, name: nm, decimals: Number.isFinite(dec) && dec <= 36 ? dec : 18,
        kind: t.kind, pool: t.pool || null, poolId: t.poolId || null, usdcIsC0: t.usdcIsC0 ?? t.usdcIsToken0 ?? false,
        supplyRaw: supHex && supHex !== '0x' ? supHex : null, created: t.created || null, cnt: t.cnt ?? null, firstSeen: Date.now() };
    });
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

  // decode prices, and read each pool's live USDC liquidity (V3 = pool native balance; V4 = token side × price)
  const rows = entries.map(([addr, t], i) => { const r = pr[i], dec = t.decimals; let price = null;
    try {
      if (t.kind === 'v3' && r?.data && r.data.length >= 66) { const sq = BigInt(r.data.slice(0, 66)); if (sq > 0n) { const ra = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ra : ra) * 10 ** (dec - 6); } }
      else if (t.kind === 'v4' && r?.data && r.data !== '0x') { const sq = BigInt(r.data) & ((1n << 160n) - 1n); if (sq > 0n) { const ra = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ra : ra) * 10 ** (dec - 6); } }
    } catch { /* */ }
    return { addr, t, price };
  }).filter((x) => x.price != null && isFinite(x.price) && x.price > 0 && x.price < 1e6);

  const liqs = await runLimited(rows.map((x) => async () => {
    if (x.t.kind === 'v3') { const b = await rpc('eth_getBalance', [x.t.pool, 'latest']); return b ? Number(BigInt(b)) / 1e18 : 0; } // V3 pool USDC (native)
    const b = await call(x.addr, '0x70a08231' + pad(PM_V4)); const tok = b && b !== '0x' ? Number(BigInt(b)) / 10 ** x.t.decimals : 0; return tok * x.price; // V4: token side value
  }), 12);
  rows.forEach((x, i) => { x.liq = liqs[i]; });

  // 24h volume + change from each LIQUID pool's own swaps. Scanning every one floods the RPCs (→ zeros),
  // so scan the most-liquid TOP_VOL tokens (covers everything with real volume; sub-floor nanocaps have
  // ~$0 volume anyway). Verified: GLITCH scans to $18.7k/24h.
  const TOP_VOL = Number(process.env.ONCHAIN_TOP_VOL || 150);
  const liquid = rows.filter((x) => x.liq >= VOL_FLOOR).sort((a, b) => b.liq - a.liq).slice(0, TOP_VOL);
  const day = await runLimited(liquid.map((x) => async () => {
    if (process.env.DEBUG_VOL) console.log('VOLCB', x.t.symbol, x.t.kind, 'liq', Math.round(x.liq), 'poolId', (x.t.poolId || x.t.pool || '?').slice(0, 12));
    const spec = x.t.kind === 'v3' ? { address: x.t.pool, topics: [[T_V3_SWAP]] } : { address: PM_V4, topics: [T_V4_SWAP, x.t.poolId] };
    const ranges = []; for (let f = BigInt(head) - BigInt(blocks24); f < BigInt(head); f += CH) ranges.push([f, f + CH > BigInt(head) ? BigInt(head) : f + CH]);
    const res = await runLimited(ranges.map(([f, to], i) => () => rpc('eth_getLogs', [{ ...spec, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }], true)), 2);
    const pts = [];
    for (const logs of res) if (Array.isArray(logs)) for (const l of logs) {
      const d = l.data.slice(2); const sq = BigInt('0x' + d.slice(128, 192)); if (sq <= 0n) continue;
      const ra = (Number(sq) / 2 ** 96) ** 2; const price = (x.t.usdcIsC0 ? 1 / ra : ra) * 10 ** (x.t.decimals - 6);
      let usd = 0;
      if (x.t.kind === 'v4') { let a = BigInt('0x' + d.slice((x.t.usdcIsC0 ? 1 : 0) * 64, (x.t.usdcIsC0 ? 1 : 0) * 64 + 64)); if (a >= (1n << 255n)) a -= (1n << 256n); usd = Math.abs(Number(a)) / 10 ** x.t.decimals * price; }
      else { let a = BigInt('0x' + d.slice((x.t.usdcIsC0 ? 0 : 1) * 64, (x.t.usdcIsC0 ? 0 : 1) * 64 + 64)); if (a >= (1n << 255n)) a -= (1n << 256n); usd = Math.abs(Number(a)) / 10 ** x.t.decimals * price; }
      if (isFinite(price) && price > 0) pts.push({ bn: Number(BigInt(l.blockNumber)), price, usd });
    }
    if (process.env.DEBUG_VOL && x.t.kind === 'v4') console.error('DBG', x.t.symbol, 'blocks24', blocks24, 'ranges', ranges.length, 'res', res.map((r) => Array.isArray(r) ? r.length : 'null'), 'pts', pts.length);
    if (!pts.length) return { vol: 0, chg: null };
    pts.sort((a, b) => a.bn - b.bn);
    return { vol: pts.reduce((s, p) => s + (isFinite(p.usd) ? p.usd : 0), 0), chg: pts[0].price > 0 ? ((pts[pts.length - 1].price - pts[0].price) / pts[0].price) * 100 : null };
  }, 3));
  const dayMap = new Map(); liquid.forEach((x, i) => dayMap.set(x.addr, day[i]));

  const out = [];
  for (const x of rows) {
    const { addr, t, price, liq } = x; const dec = t.decimals;
    const supply = t.supplyRaw ? num(t.supplyRaw, dec) : null;
    const mcap = supply ? price * supply : null;
    const ds = dayMap.get(addr);
    const ageSec = t.created ? Math.round((head - t.created) * blockTime) : null;
    out.push({ address: addr, symbol: t.symbol, name: t.name, decimals: dec, price,
      liq: liq || null, mcap: mcap && mcap <= 1e10 ? mcap : null,
      volume24h: ds ? ds.vol : null, change24h: ds ? ds.chg : null,
      createdAt: ageSec != null ? Math.floor(Date.now() / 1000) - ageSec : null,
      source: t.kind.toUpperCase(), launchpad: t.kind === 'v4' ? 'onchain' : null });
  }
  console.log(`[disc] priced ${out.length}, liquid (vol/chg scanned) ${liquid.length}`);

  state.cursor = head;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), count: out.length, tokens: out }));
  console.log(`[disc] priced ${out.length} on-chain tokens → ${OUT_FILE}; cursor=${head}`);
}
main().catch((e) => { console.error('[disc] FATAL', e); process.exit(1); });
