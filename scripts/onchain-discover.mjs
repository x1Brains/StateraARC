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

const STATE_FILE = process.env.ONCHAIN_STATE || './onchain-state.json';
const OUT_FILE = process.env.ONCHAIN_OUT || './onchain-tokens.json';
const CH = 95000n;                       // getLogs range for the big-range RPCs
const INITIAL_LOOKBACK = BigInt(process.env.ONCHAIN_LOOKBACK || 1_200_000); // first run: how far back to sweep
const MAX_NEW_PER_RUN = 1500;            // cap the per-run filter/metadata work so a run stays bounded
const V4_ACTIVE_WINDOW = 40000n;         // blocks of recent V4 swaps to catch active launchpad pools
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
    if (!state.tokens[token]) v3cand.push({ token, pool, usdcIsToken0: t0 === USDC });
  }
  console.log(`[disc] V3 new USDC pools: ${v3cand.length}`);

  // ── 2) ACTIVE V4 pools from recent Swap events (activity = the real-vs-decoy signal) ──────────────
  // Recent swaps are dense (~7k logs / 2k blocks), so scan a SHORT window in SMALL chunks. Then resolve
  // each active poolId's currencies from ONE bulk Initialize map (scanned once, not per pool).
  const v4swaps = await scanLogs(PM_V4, [T_V4_SWAP], BigInt(head) - V4_ACTIVE_WINDOW, BigInt(head), 2000n);
  const v4active = new Map(); for (const l of v4swaps) v4active.set(l.topics[1], (v4active.get(l.topics[1]) || 0) + 1);
  const wantIds = new Set([...v4active].filter(([, c]) => c >= 3).map(([p]) => p).filter((p) => {
    // only resolve ones we don't already know
    for (const t of Object.values(state.tokens)) if (t.poolId === p) return false; return true;
  }));
  const v4cand = [];
  if (wantIds.size) {
    const initLogs = await scanLogs(PM_V4, [T_V4_INIT], from, BigInt(head)); // sparse: one map for all
    const idMap = new Map();
    for (const l of initLogs) idMap.set(l.topics[1], { c0: ('0x' + l.topics[2].slice(26)).toLowerCase(), c1: ('0x' + l.topics[3].slice(26)).toLowerCase() });
    for (const poolId of wantIds) {
      const cc = idMap.get(poolId); if (!cc) continue;
      if (cc.c0 !== USDC && cc.c1 !== USDC) continue;
      const token = cc.c0 === USDC ? cc.c1 : cc.c0;
      if (state.tokens[token]) continue;
      v4cand.push({ token, poolId, usdcIsC0: cc.c0 === USDC });
    }
  }
  console.log(`[disc] V4 active pools: ${v4active.size}, new USDC tokens: ${v4cand.length}`);

  // ── 3) Filter V3 candidates by REAL USDC liquidity (parallel eth_getBalance) ───────────────────────
  const v3slice = v3cand.slice(0, MAX_NEW_PER_RUN);
  const bals = await runLimited(v3slice.map((c) => async () => { const b = await rpc('eth_getBalance', [c.pool, 'latest']); return b ? Number(BigInt(b)) / 1e18 : 0; }), 12);
  const v3keep = v3slice.map((c, i) => ({ ...c, usdc: bals[i] })).filter((c) => c.usdc >= MIN_USDC);
  console.log(`[disc] V3 real (>= $${MIN_USDC}): ${v3keep.length}`);

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
        supplyRaw: supHex && supHex !== '0x' ? supHex : null, firstSeen: Date.now() };
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
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const [addr, t] = entries[i]; const r = pr[i]; const dec = t.decimals;
    let price = null;
    try {
      if (t.kind === 'v3' && r?.data && r.data.length >= 66) {
        const sqrtP = BigInt(r.data.slice(0, 66)); if (sqrtP > 0n) { const ratio = (Number(sqrtP) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ratio : ratio) * 10 ** (dec - 6); }
      } else if (t.kind === 'v4' && r?.data && r.data !== '0x') {
        const sqrtP = BigInt(r.data) & ((1n << 160n) - 1n); if (sqrtP > 0n) { const ratio = (Number(sqrtP) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / ratio : ratio) * 10 ** (dec - 6); }
      }
    } catch { /* */ }
    if (price == null || !isFinite(price) || price <= 0 || price >= 1e6) continue;
    const supply = t.supplyRaw ? num(t.supplyRaw, dec) : null;
    const mcap = supply ? price * supply : null;
    out.push({ address: addr, symbol: t.symbol, name: t.name, decimals: dec, price,
      liq: t.usdc ?? null, mcap: mcap && mcap <= 1e10 ? mcap : null, source: t.kind.toUpperCase(),
      launchpad: t.kind === 'v4' ? 'onchain' : null });
  }

  state.cursor = head;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), count: out.length, tokens: out }));
  console.log(`[disc] priced ${out.length} on-chain tokens → ${OUT_FILE}; cursor=${head}`);
}
main().catch((e) => { console.error('[disc] FATAL', e); process.exit(1); });
