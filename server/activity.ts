// ARC ACTIVITY — what the chain is DOING, block by block, for the Network page (owner 10-21, after eita.run/arc/live.html):
// a block tape (each bar one block, coloured by protocol), USDC issued vs burned, USDC moved, active + brand-new wallets, and
// one card per protocol with a 3-hour sparkline. Fed by server/chain.ts's block follower (full blocks + one unfiltered
// getLogs per 15 s poll) — no extra follower, no per-visitor reads. Kept light on the API thread: a few hundred logs a poll.
//   active wallet = a tx sender in that minute · new wallet = a sender whose tx nonce is 0 (its first transaction ever)
//   protocol of a tx = every protocol whose contract emitted a log in it (classified below; addresses verified on chain 10-21)
//   USDC: the native-USDC log emitter 0xff…fe is the ONE record of USDC movement (every 0x3600 Transfer has a twin there, plus
//   plain native sends) — mint = Transfer from 0x0, burn = Transfer to 0x0, moved = every other Transfer (18-dec amounts).
import fs from 'node:fs';
import path from 'node:path';

export const PROTOCOLS: { id: string; name: string; cat: string; color: string }[] = [
  { id: 'uni-v4', name: 'Uniswap V4', cat: 'DEX', color: '#ff4fb8' },
  { id: 'dex-v3', name: 'Uniswap V3 · Aerodrome · Archery', cat: 'DEX', color: '#ff8fd1' },
  { id: 'dex-v2', name: 'V2 DEXes', cat: 'DEX', color: '#c77dff' },
  { id: 'uniswapx', name: 'UniswapX (filled orders)', cat: 'DEX', color: '#f7a8ff' },
  { id: 'stablefx', name: 'StableFX (Circle FX)', cat: 'FX', color: '#4fd1c5' },
  { id: 'morpho', name: 'Morpho', cat: 'Lending', color: '#6aa9ff' },
  { id: 'aave', name: 'Aave V4', cat: 'Lending', color: '#9b8cff' },
  { id: 'cctp', name: 'Circle CCTP', cat: 'Bridge', color: '#3ec46f' },
  { id: 'gateway', name: 'Circle Gateway', cat: 'Bridge', color: '#8be08f' },
  { id: 'across', name: 'Across', cat: 'Bridge', color: '#6ee7b7' },
  { id: 'launchpad', name: 'Launchpads (Argus …)', cat: 'Launch', color: '#ffb547' },
  { id: 'aa', name: 'Smart wallets (ERC-4337)', cat: 'Wallets', color: '#ffd27a' },
  { id: 'oracle', name: 'Chainlink price feeds', cat: 'Oracle', color: '#7aa7ff' },
];
const T_V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const T_UNIX_FILL = '0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66';
const T_ANSWER = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';
const ZERO_T = '0x0000000000000000000000000000000000000000000000000000000000000000';
const BY_EMITTER: Record<string, string> = {
  '0x8366a39cc670b4001a1121b8f6a443a643e40951': 'uni-v4',
  '0xe2e5f173576b513d994073ccbdacbe027d43dfe6': 'stablefx',
  '0x34cd04070dd72b14e241112f6d83812df5af7fcd': 'morpho',
  '0x17288dfc86205301064577b98b02b81017e6f79c': 'aave',
  '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d': 'cctp', '0x81d40f21f12a8f0e3252bccb954d722d4c464b64': 'cctp',
  '0xfd78ee919681417d192449715b2594ab58f5d002': 'cctp', '0x71f54f818671cd0d7ea140da213e5c8b5c92a408': 'cctp',
  '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee': 'gateway', '0x2222222d7164433c4c09b0b0d809a9b52c04c205': 'gateway',
  '0x9b4a302a548c7e313c2b74c461db7b84d3074a84': 'across',
  '0xb021be536808f551b31789422fd28a6c9c6e97da': 'launchpad', '0x0f1c7cb26d6cd36bd4189e41947658b39437587a': 'launchpad',
  '0xd969062076f75fbc4fd0195561501dc13ef87c72': 'launchpad',
  '0x95d262c8ab207a54c08569887177fa301e7f9687': 'launchpad', '0x34a0b64a88bbd4bf6acba8a0ff8f27c8add67e9c': 'launchpad',
  '0x1594f838177784f4fcba8f4082d3ca53aeb2672b': 'launchpad', '0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad': 'launchpad',
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': 'aa', '0x0000000071727de22e5e9d8baf0edac6f37da032': 'aa', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': 'aa',
};
function classify(l: any): string | null {
  const a = String(l.address || '').toLowerCase(), t0 = String(l.topics?.[0] || '').toLowerCase();
  const e = BY_EMITTER[a]; if (e) return e;
  if (t0 === T_V3_SWAP) return 'dex-v3';
  if (t0 === T_V2_SWAP) return 'dex-v2';
  if (t0 === T_UNIX_FILL) return 'uniswapx';
  if (t0 === T_ANSWER) return 'oracle';
  if (t0 === T_V4_SWAP) return 'uni-v4';
  return null;
}

type Bucket = { t: number; txs: number; nw: number; mint: number; burn: number; moved: number; act: Set<string>; p: Record<string, number> };
const buckets = new Map<number, Bucket>();
type TapeBlock = { n: number; ts: number; txs: number; p: Record<string, number> };
const tape: TapeBlock[] = [];
const blockIndex = new Map<number, TapeBlock>();
let since = 0;
export const activityStats = { blocks: 0, logs: 0, logPolls: 0, logErrors: 0 };
const KEEP_S = 26 * 3600;
const bucketOf = (ts: number) => { const t = Math.floor(ts / 60) * 60; let b = buckets.get(t); if (!b) { b = { t, txs: 0, nw: 0, mint: 0, burn: 0, moved: 0, act: new Set(), p: {} }; buckets.set(t, b); } return b; };

/** Full blocks (eth_getBlockByNumber …, true) from the live follower. */
export function onBlocks(blocks: any[]) {
  for (const b of blocks) {
    if (!b?.number || !Array.isArray(b.transactions)) continue;
    const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16);
    if (blockIndex.has(n)) continue;
    const bk = bucketOf(ts);
    for (const tx of b.transactions) {
      if (!tx || typeof tx !== 'object') continue;
      bk.txs++;
      if (tx.from) bk.act.add(String(tx.from).toLowerCase());
      if (tx.nonce === '0x0') bk.nw++;
    }
    if (!liveFrom || n < liveFrom) { liveFrom = n; liveSinceTs = ts; }
    const tb: TapeBlock = { n, ts, txs: b.transactions.length, p: {} };
    tape.push(tb); blockIndex.set(n, tb);
    if (!since) since = ts;
    activityStats.blocks++;
  }
  tape.sort((x, y) => x.n - y.n);
  while (tape.length > 240) blockIndex.delete(tape.shift()!.n);
}
/** Every log of the same blocks (unfiltered getLogs): protocols per tx, USDC mint / burn / moved. */
export function onLogs(logs: any[]) {
  activityStats.logPolls++;
  ingestLogs(logs);
  trimActivity();
}
let liveFrom = 0, liveSinceTs = 0; // first block the live follower fed — the 24 h backfill stops just below it
function ingestLogs(logs: any[]) {
  const seen = new Set<string>();
  for (const l of logs) {
    activityStats.logs++;
    const ts = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : null;
    const n = parseInt(l.blockNumber, 16);
    const tsOk = ts ?? blockIndex.get(n)?.ts; if (tsOk == null) continue;
    const bk = bucketOf(tsOk);
    const a = String(l.address || '').toLowerCase(), t0 = String(l.topics?.[0] || '').toLowerCase();
    if (a === NATIVE_LOG && t0 === T_TRANSFER && l.topics.length >= 3) {
      let v = 0; try { v = Number(BigInt(l.data && l.data !== '0x' ? l.data : '0x0')) / 1e18; } catch { /* */ }
      if (l.topics[1] === ZERO_T) bk.mint += v; else if (l.topics[2] === ZERO_T) bk.burn += v; else bk.moved += v;
    }
    const p = classify(l); if (!p) continue;
    const k = l.transactionHash + p; if (seen.has(k)) continue; seen.add(k);
    bk.p[p] = (bk.p[p] || 0) + 1;
    const tb = blockIndex.get(n); if (tb) tb.p[p] = (tb.p[p] || 0) + 1;
  }
}
function trimActivity() {
  const newest = tape.length ? tape[tape.length - 1].ts : Math.floor(Date.now() / 1000);
  for (const t of buckets.keys()) if (t < newest - KEEP_S) buckets.delete(t);
}

// ── 24 h backfill (owner 10-21: "it should be last 24 hours so we have enough data") ───────────────────────────────────
// Protocol activity + USDC mint / burn / moved for the day BEFORE the live counter started, from FILTERED logs (the known
// contracts; DEX / fill / price-feed events by topic; native-USDC transfers) — 2,000 blocks a step, one call at a time, paced
// by the caller (~1 call/s). Tx counts and active / new wallets need every full block, so those cards fill live only (their
// coverage is reported separately: liveSince). A step that the node refuses as too big is split in halves.
type Rpc = (method: string, params: unknown[]) => Promise<any>;
const BF_STEP = 2000;
let bf = { to: 0, target: 0, done: false };   // to = next block to read DOWNWARD from (exclusive top); target = 24 h back
export const backfillStats = { calls: 0, errors: 0, blocks: 0 };
async function logsSplit(rpc: Rpc, filter: Record<string, unknown>, from: number, to: number): Promise<any[]> {
  backfillStats.calls++;
  const r = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]).catch(() => null);
  if (Array.isArray(r)) return r;
  if (to - from < 50) throw new Error('logs refused');
  const mid = Math.floor((from + to) / 2);
  return [...(await logsSplit(rpc, filter, from, mid)), ...(await logsSplit(rpc, filter, mid + 1, to))];
}
// the V4 PoolManager is left out of the address list (its Swap events come in through the topic query — with it the list
// answer is huge and rpc.mainnet.arc.io refuses the range: "requested range too large")
const EMITTERS = Object.keys(BY_EMITTER).filter((a) => a !== '0x8366a39cc670b4001a1121b8f6a443a643e40951');
/** One backfill step (call every ~1.5 s from the API until it returns false). */
export async function activityBackfillStep(rpc: Rpc, headTs: number, blockTime: number): Promise<boolean> {
  if (bf.done || !liveFrom) return false;
  if (!bf.to || bf.to > liveFrom) { bf.to = liveFrom; bf.target = Math.max(0, liveFrom - Math.ceil(86400 / Math.max(0.2, blockTime)) - 200); }
  if (bf.to <= bf.target) { bf.done = true; return false; }
  const from = Math.max(bf.target, bf.to - BF_STEP), to = bf.to - 1;
  try {
    const [a, b, c] = [
      await logsSplit(rpc, { address: EMITTERS }, from, to),
      await logsSplit(rpc, { topics: [[T_V4_SWAP, T_V3_SWAP, T_V2_SWAP, T_UNIX_FILL, T_ANSWER]] }, from, to),
      await logsSplit(rpc, { address: NATIVE_LOG, topics: [T_TRANSFER] }, from, to),
    ];
    ingestLogs([...a, ...b, ...c]);
    bf.to = from; backfillStats.blocks += to - from + 1;
    const earliest = [...a, ...b, ...c].reduce((m, l) => Math.min(m, l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : Infinity), Infinity);
    if (isFinite(earliest)) bfFromTs = Math.min(bfFromTs || earliest, earliest);
  } catch { backfillStats.errors++; }
  void headTs;
  return !bf.done;
}
let bfFromTs = 0; // oldest time the backfilled protocol / USDC counts reach

// ── summary for /v2/activity ────────────────────────────────────────────────────────────────────────────────────────────
let cache: { at: number; v: unknown } | null = null;
export function activitySummary() {
  if (cache && Date.now() - cache.at < 4000) return cache.v;
  const list = [...buckets.values()].sort((a, b) => a.t - b.t);
  if (!list.length) return null;
  const now = list[list.length - 1].t + 60;
  const liveSince = liveSinceTs ? Math.floor(liveSinceTs / 60) * 60 : now; // when the live (full-block) counting began
  const dayStart = Math.floor(now / 86400) * 86400;
  const win = (from: number) => {
    const bs = list.filter((b) => b.t >= from);
    const act = new Set<string>(); const p: Record<string, number> = {};
    let txs = 0, nw = 0, mint = 0, burn = 0, moved = 0;
    for (const b of bs) { txs += b.txs; nw += b.nw; mint += b.mint; burn += b.burn; moved += b.moved; for (const a of b.act) act.add(a); for (const [k, v] of Object.entries(b.p)) p[k] = (p[k] || 0) + v; }
    // two coverages: protocol + USDC counts reach back as far as the backfill went; tx / wallet counts only since the live start
    return { from: Math.max(from, list[0].t), liveFrom: Math.max(from, liveSince), txs, active: act.size, newWallets: nw, minted: mint, burned: burn, net: mint - burn, moved, protocols: p };
  };
  // last 3 hours, one point per minute (missing minutes = 0), for the sparklines
  const S = 180, start = now - S * 60;
  const series = { txs: [] as number[], active: [] as number[], newWallets: [] as number[], net: [] as number[], moved: [] as number[], protocols: {} as Record<string, number[]> };
  for (const pr of PROTOCOLS) series.protocols[pr.id] = [];
  for (let t = start; t < now; t += 60) {
    const b = buckets.get(t);
    series.txs.push(b?.txs ?? 0); series.active.push(b?.act.size ?? 0); series.newWallets.push(b?.nw ?? 0);
    series.net.push(b ? b.mint - b.burn : 0); series.moved.push(b?.moved ?? 0);
    for (const pr of PROTOCOLS) series.protocols[pr.id].push(b?.p[pr.id] ?? 0);
  }
  const v = { at: Date.now(), since: list[0].t, liveSince, backfill: { done: bf.done, fromTs: bfFromTs || null, ...backfillStats }, now, protocols: PROTOCOLS, h1: win(now - 3600), today: win(dayStart), h24: win(now - 86400),
    series: { start, step: 60, ...series }, tape: tape.slice(-180).map((b) => ({ n: b.n, ts: b.ts, txs: b.txs, p: b.p })) };
  cache = { at: Date.now(), v };
  return v;
}

// ── survives restarts ───────────────────────────────────────────────────────────────────────────────────────────────────
const FILE = process.env.ACTIVITY_STATE || '/root/statera-api-state/activity.json';
export function saveActivity() {
  try {
    const body = JSON.stringify({ v: 1, since, bf, bfFromTs, liveFrom, liveSinceTs, buckets: [...buckets.values()].map((b) => ({ ...b, act: [...b.act] })) });
    fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', body); fs.renameSync(FILE + '.tmp', FILE);
  } catch { /* next time */ }
}
export function loadActivity() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j?.v !== 1) return;
    since = j.since || 0; if (j.bf) bf = j.bf; bfFromTs = j.bfFromTs || 0; liveFrom = j.liveFrom || 0; liveSinceTs = j.liveSinceTs || 0;
    for (const b of j.buckets || []) buckets.set(b.t, { ...b, act: new Set(b.act || []) });
    trimActivity();
  } catch { /* fresh start */ }
}
