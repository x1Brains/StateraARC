// ARC NETWORK — live chain stats for the Network page, read from the chain by ONE follower on the VPS (never per visitor).
// Every block is read (batched, ~2 blocks/s → one batch of ≤ 40 every 15 s): producer (the `miner` = fee beneficiary =
// the validator that proposed it), tx count, gas, base fee. CCTP V2 USDC flows from the TokenMessengerV2 events, supplies
// from totalSupply(). Verified on-chain 2026-09-28: 17 distinct producers rotating round-robin, ~0.505 s blocks, base fee at
// the 20 gwei floor; DepositForBurn = USDC leaving Arc, MintAndWithdraw = USDC arriving. The chain does not say which
// institution runs which producer address — the page shows addresses, never guessed names.
import fs from 'node:fs';
import path from 'node:path';
type Rpc = (method: string, params: unknown[]) => Promise<any>;

const WINDOW_S = 6 * 3600;                 // rolling window kept in memory (6 h of blocks ≈ 43k small rows)
const BACKFILL_S = 3600;                   // on start, read back 1 h so the page is useful at once
const TOKEN_MESSENGER = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d';
const TOPIC_DEPOSIT_FOR_BURN = '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5'; // USDC out of Arc
const TOPIC_MINT_AND_WITHDRAW = '0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63'; // USDC into Arc
const MESSAGE_TRANSMITTER = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64';
const TOPIC_MESSAGE_RECEIVED = '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c'; // carries sourceDomain
// Circle CCTP domain ids we are sure of; anything else is shown as "domain N".
const DOMAINS: Record<number, string> = { 0: 'Ethereum', 1: 'Avalanche', 2: 'OP Mainnet', 3: 'Arbitrum', 5: 'Solana', 6: 'Base', 7: 'Polygon PoS', 10: 'Unichain', 11: 'Linea' };
const SUPPLY: { sym: string; addr: string; dec: number }[] = [
  { sym: 'USDC', addr: '0x3600000000000000000000000000000000000000', dec: 6 },
  { sym: 'EURC', addr: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', dec: 6 },
  { sym: 'cirBTC', addr: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', dec: 8 },
  { sym: 'USYC', addr: '0x8a5d989bbb96929f689b0200f435f53da42bf490', dec: 6 },
];

interface Blk { n: number; ts: number; miner: string; txs: number; gas: number; baseFee: number }
interface Flow { n: number; ts: number; dir: 'in' | 'out'; usd: number; domain: number | null }
const blocks = new Map<number, Blk>();
let flows: Flow[] = [];
let head = 0, lastBlock = 0, lastLogBlock = 0;
const supplies: Record<string, number | null> = {};
let suppliesAt = 0;
export const chainStats = { polls: 0, blocksRead: 0, errors: 0, backfilled: false };

const hex = (n: number) => '0x' + n.toString(16);
const word = (data: string, i: number) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'));

async function readBlocks(rpcBatch: (calls: [string, unknown[]][]) => Promise<any[]>, from: number, to: number) {
  const calls: [string, unknown[]][] = [];
  for (let n = from; n <= to; n++) calls.push(['eth_getBlockByNumber', [hex(n), false]]);
  const res = await rpcBatch(calls);
  for (const b of res) {
    if (!b || !b.number) continue;
    const n = parseInt(b.number, 16);
    blocks.set(n, { n, ts: parseInt(b.timestamp, 16), miner: String(b.miner).toLowerCase(), txs: Array.isArray(b.transactions) ? b.transactions.length : 0,
      gas: parseInt(b.gasUsed, 16), baseFee: b.baseFeePerGas ? parseInt(b.baseFeePerGas, 16) : 0 });
    chainStats.blocksRead++;
  }
}

async function readFlows(rpc: Rpc, from: number, to: number) {
  const [tm, mt] = await Promise.all([
    rpc('eth_getLogs', [{ address: TOKEN_MESSENGER, topics: [[TOPIC_DEPOSIT_FOR_BURN, TOPIC_MINT_AND_WITHDRAW]], fromBlock: hex(from), toBlock: hex(to) }]),
    rpc('eth_getLogs', [{ address: MESSAGE_TRANSMITTER, topics: [TOPIC_MESSAGE_RECEIVED], fromBlock: hex(from), toBlock: hex(to) }]),
  ]);
  if (!Array.isArray(tm)) throw new Error('cctp logs unavailable');
  // A received message's source domain, keyed by tx (MintAndWithdraw and MessageReceived share the receive tx).
  const srcByTx = new Map<string, number>();
  if (Array.isArray(mt)) for (const l of mt) { try { srcByTx.set(l.transactionHash, Number(word(l.data, 0))); } catch { /* skip */ } }
  const headTs = blocks.get(head)?.ts ?? null;
  // A log in a block not read yet (the backfill is behind): time it from the head at ~0.5 s/block until the block lands.
  const tsOf = (n: number) => blocks.get(n)?.ts ?? (headTs != null ? Math.round(headTs - (head - n) * 0.5) : null);
  for (const l of tm) {
    const n = parseInt(l.blockNumber, 16);
    try {
      if (l.topics[0] === TOPIC_DEPOSIT_FOR_BURN) {
        // non-indexed: amount, mintRecipient, destinationDomain, … (USDC ERC-20 face, 6 dec)
        flows.push({ n, ts: tsOf(n) ?? 0, dir: 'out', usd: Number(word(l.data, 0)) / 1e6, domain: Number(word(l.data, 2)) });
      } else {
        // non-indexed: amount, feeCollected
        flows.push({ n, ts: tsOf(n) ?? 0, dir: 'in', usd: Number(word(l.data, 0)) / 1e6, domain: srcByTx.get(l.transactionHash) ?? null });
      }
    } catch { /* skip malformed */ }
  }
}

async function readSupplies(rpc: Rpc) {
  for (const s of SUPPLY) {
    const r = await rpc('eth_call', [{ to: s.addr, data: '0x18160ddd' }, 'latest']).catch(() => null);
    try { supplies[s.sym] = r && r !== '0x' ? Number(BigInt(r)) / 10 ** s.dec : null; } catch { supplies[s.sym] = null; }
  }
  suppliesAt = Date.now();
}

// ── State survives restarts (a deploy used to blank the page for the ~6 min backfill, 09-28 owner screenshot) ──────
const STATE_FILE = process.env.CHAIN_STATE || '/root/statera-api-state/chain.json';
let firstBlock = 0;            // oldest block read so far; the background backfill walks it back to head − 1 h
let flowsFrom = 0;             // oldest block whose CCTP logs are in `flows`
export function saveChain() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, lastBlock, lastLogBlock, firstBlock, flowsFrom, blocks: [...blocks.values()], flows, supplies, suppliesAt }));
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* next time */ }
}
export function loadChain() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j.v !== 1) return;
    for (const b of j.blocks as Blk[]) blocks.set(b.n, b);
    flows = j.flows || []; Object.assign(supplies, j.supplies || {}); suppliesAt = 0; // supplies re-read on the first poll
    lastBlock = j.lastBlock || 0; lastLogBlock = j.lastLogBlock || 0; firstBlock = j.firstBlock || 0; flowsFrom = j.flowsFrom || 0;
  } catch { /* fresh start */ }
}

/** One poll (every 15 s): supplies (every 5 min), the NEWEST blocks up to the head, CCTP logs for the same range. Never
 *  blocks on history — the page is right from the first poll; backfillStep() lengthens the window in the background. */
export async function pollChain(rpc: Rpc, rpcBatch: (calls: [string, unknown[]][]) => Promise<any[]>) {
  chainStats.polls++;
  const h = parseInt(await rpc('eth_blockNumber', []), 16);
  if (!Number.isFinite(h)) throw new Error('no head');
  head = h;
  if (Date.now() - suppliesAt > 5 * 60_000) await readSupplies(rpc);
  // A long gap (first start, or a restart after hours) = start from the head; the backfill fills in behind.
  if (!lastBlock || h - lastBlock > 2000) { lastBlock = h - 40; if (!firstBlock || firstBlock > lastBlock) firstBlock = lastBlock + 1; }
  // 20 blocks per batch; advance only past what was actually read, so a rate-limited batch is retried next poll
  // instead of aborting the whole poll with the window frozen (09-28 on the VPS: covered stuck at 2 min).
  let got = lastBlock;
  try { for (let n = lastBlock + 1; n <= h; n += 20) { const to = Math.min(h, n + 19); await readBlocks(rpcBatch, n, to); got = to; } }
  catch { chainStats.errors++; }
  // CCTP: the whole last hour in one call on start (≤ 9,000 blocks), then only what is new.
  if (!lastLogBlock || h - lastLogBlock > 8000) {
    const from = h - Math.round(BACKFILL_S / 0.5);
    try { const keep = flows; flows = []; await readFlows(rpc, from, h).catch((e) => { flows = keep; throw e; }); flowsFrom = from; lastLogBlock = h; } catch { chainStats.errors++; }
  } else if (h > lastLogBlock) { try { await readFlows(rpc, lastLogBlock + 1, h); lastLogBlock = h; } catch { chainStats.errors++; } }
  lastBlock = got;
  trim();
}
/** Background history: 20 older blocks per call, newest-first, until 1 h (then the 6 h window fills on its own). */
export async function backfillStep(rpcBatch: (calls: [string, unknown[]][]) => Promise<any[]>): Promise<boolean> {
  if (!head || !firstBlock) return false;
  const target = head - Math.round(BACKFILL_S / 0.5);
  if (firstBlock <= target) { chainStats.backfilled = true; return false; }
  const from = Math.max(target, firstBlock - 20);
  await readBlocks(rpcBatch, from, firstBlock - 1);
  firstBlock = from;
  return true;
}
function trim() {
  const newest = blocks.get(head)?.ts ?? Math.max(0, ...[...blocks.values()].slice(-1).map((b) => b.ts));
  for (const f of flows) if (!f.ts) f.ts = blocks.get(f.n)?.ts ?? 0;
  for (const [n, b] of blocks) if (b.ts < newest - WINDOW_S) blocks.delete(n);
  flows = flows.filter((f) => !f.ts || f.ts >= newest - WINDOW_S);
}

/** The Network page payload: windows 5 min / 1 h / (up to) 6 h, validators by blocks produced, CCTP flows, supplies. */
export function chainSummary() {
  const all = [...blocks.values()].sort((a, b) => a.n - b.n);
  if (all.length < 2) return null;
  const last = all[all.length - 1];
  const win = (sec: number) => {
    const bs = all.filter((b) => b.ts > last.ts - sec);
    if (bs.length < 2) return null;
    const span = Math.max(1, bs[bs.length - 1].ts - bs[0].ts);
    const txs = bs.reduce((s, b) => s + b.txs, 0), gas = bs.reduce((s, b) => s + b.gas, 0);
    const fees = bs.reduce((s, b) => s + (b.gas * b.baseFee) / 1e18, 0); // base fee is paid in native USDC (18-dec view)
    return { seconds: span, blocks: bs.length, blockTime: span / (bs.length - 1), txs, tps: txs / span, gasPerBlock: gas / bs.length, feesUsdc: fees };
  };
  const hour = all.filter((b) => b.ts > last.ts - 3600);
  const prod = new Map<string, { blocks: number; last: number }>();
  for (const b of hour) { const p = prod.get(b.miner) || { blocks: 0, last: 0 }; p.blocks++; p.last = Math.max(p.last, b.n); prod.set(b.miner, p); }
  const validators = [...prod.entries()].map(([address, p]) => ({ address, blocks: p.blocks, share: p.blocks / hour.length, lastBlock: p.last, behind: last.n - p.last }))
    .sort((a, b) => b.blocks - a.blocks);
  const flowWin = (sec: number) => {
    const fs = flows.filter((f) => f.ts > last.ts - sec);
    const agg = (dir: 'in' | 'out') => {
      const x = fs.filter((f) => f.dir === dir), by = new Map<string, { usd: number; n: number }>();
      for (const f of x) { const k = f.domain == null ? 'unknown' : (DOMAINS[f.domain] || `domain ${f.domain}`); const v = by.get(k) || { usd: 0, n: 0 }; v.usd += f.usd; v.n++; by.set(k, v); }
      return { usd: x.reduce((s, f) => s + f.usd, 0), count: x.length, byChain: [...by.entries()].map(([chain, v]) => ({ chain, ...v })).sort((a, b) => b.usd - a.usd) };
    };
    return { in: agg('in'), out: agg('out') };
  };
  const cover = last.ts - all[0].ts;
  return {
    at: Date.now(), head: last.n, headTs: last.ts, baseFeeGwei: last.baseFee / 1e9, coveredSeconds: cover,
    m5: win(300), h1: win(3600), h6: cover >= 5 * 3600 ? win(6 * 3600) : null,
    validators, validatorCount: validators.length,
    cctp: { h1: flowWin(3600), h6: cover >= 5 * 3600 ? flowWin(6 * 3600) : null, fromBlock: flowsFrom },
    backfilling: !chainStats.backfilled,
    supplies: { ...supplies }, suppliesAt,
  };
}
