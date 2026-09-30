// OUR OWN HOLDER INDEX (09-30). Every listed token's holders, built from its Transfer logs on chain — no explorer needed.
//
// ⛔ WHY: the token page's top-holder list (and so every POOL / BURNED / LOCKED / CONTRACT badge) came only from arc-scan's
// API. On 09-30 arc-scan went down (Cloudflare 530 / error 1033 — their origin unreachable) and EVERY token page lost its
// holder list; the page fell back to RadarDEX in the browser, which has no badges. Owner rule: on-chain is primary.
//
// HOW: once per token, scan Transfer(from,to,value) from the contract's deploy block (binary search on eth_getCode) to the
// head in 95k-block ranges on the wide-range RPCs (a range that returns too much is split in halves), and sum balances.
// Saved to disk (/root/statera-api-state/holders/<token>.json) and updated incrementally from the last scanned block.
// Measured 09-30: GLITCH 139,544 transfers / 63,641 holders in 23 s (19 requests); EURC 281 requests in 206 s; no negative
// balances on either (the sum is consistent); GLITCH's top 5 matched arc-scan's exactly.
// The top holders are re-checked with balanceOf() (one Multicall3 call) before they are shown.
import fs from 'node:fs';
import path from 'node:path';
import { encAggregate3, decAggregate3 } from '../scripts/lib/multicall.mjs';

// ⛔ 09-30 from the VPS: Tenderly answers 429 (the box's IP is busy with the bots), Arc's public RPC 429s wide getLogs, dRPC
// caps getLogs at 10k blocks — Blockdaemon serves 95k-block ranges. So Blockdaemon first, and every read retries on the
// next node instead of failing the whole token (97 of 98 attempts failed in the first hour).
const WIDE = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://arc.gateway.tenderly.co']; // allow 95k-block getLogs
const MAIN = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://arc.drpc.org'];
const MC = '0xca11bde05977b3631167028862be2a173976ca11';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const RANGE = 95_000;
const DIR = process.env.HOLDERS_DIR || '/root/statera-api-state/holders';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(url: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(String(j.error.message || 'rpc error'));
  return j.result;
}
async function main(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 8; i++) { try { return await call(MAIN[i % MAIN.length], method, params); } catch { await sleep(200 * (i + 1)); } }
  throw new Error('rpc unavailable');
}
let rr = 0;
/** Logs for [lo, hi]; null = the range returned too much (the caller splits it). Throws if the RPCs are unreachable. */
async function logs(token: string, lo: number, hi: number): Promise<any[] | null> {
  let last = '';
  for (let i = 0; i < 8; i++) {
    await sleep(120); // paced — one wide read at a time, a breath between them
    try { return await call(WIDE[(rr + i) % WIDE.length], 'eth_getLogs', [{ address: token, topics: [TRANSFER], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]); }
    catch (e) { last = (e as Error).message; if (/too many|exceed|range|size|results/i.test(last) && !/rate limit/i.test(last) && hi - lo > 1000) return null; await sleep(300 * (i + 1)); }
  }
  throw new Error(`getLogs failed: ${last}`);
}

type State = { start: number; last: number; bal: Map<string, bigint>; at: number };
const mem = new Map<string, State>();
const file = (t: string) => path.join(DIR, `${t}.json`);
// Memory: at most MEM_MAX tokens' balance maps (GLITCH alone is 63k wallets); the rest are re-read from disk when needed.
const MEM_MAX = 60; // batch mode holds up to 40 at once
function keep(t: string, s: State) { mem.delete(t); mem.set(t, s); while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!); }
function load(t: string): State | null {
  const hit = mem.get(t);
  if (hit) { keep(t, hit); return hit; }
  try {
    const j = JSON.parse(fs.readFileSync(file(t), 'utf8'));
    if (j?.v !== 1) return null;
    const s: State = { start: j.start, last: j.last, at: j.at || 0, bal: new Map(Object.entries(j.bal as Record<string, string>).map(([a, v]) => [a, BigInt(v)])) };
    keep(t, s); return s;
  } catch { return null; }
}
function save(t: string, s: State) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const bal: Record<string, string> = {};
    for (const [a, v] of s.bal) if (v !== 0n) bal[a] = v.toString();
    fs.writeFileSync(file(t) + '.tmp', JSON.stringify({ v: 1, start: s.start, last: s.last, at: s.at, bal }));
    fs.renameSync(file(t) + '.tmp', file(t));
  } catch { /* next pass */ }
}
async function deployBlock(t: string, head: number): Promise<number> {
  let lo = 0, hi = head;
  // ⛔ a FAILED read must never count as "no code yet" — that would start the scan too late and miss early transfers.
  // main() retries across nodes and throws; the whole token then waits for the next pass.
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const c = await main('eth_getCode', [t, '0x' + mid.toString(16)]); if (c && c !== '0x') hi = mid; else lo = mid + 1; }
  return lo;
}

export const indexStats = { indexed: 0, updates: 0, errors: 0, lastMs: 0, tokens: 0 };
const busy = new Set<string>();
/** Bring one token's holder balances up to the chain head (full scan the first time, new blocks after). */
export async function indexHolders(token: string): Promise<boolean> {
  const t = token.toLowerCase();
  if (busy.has(t)) return false;
  busy.add(t);
  const t0 = Date.now();
  try {
    const head = parseInt(await main('eth_blockNumber', []), 16);
    let s = load(t);
    const fresh = !s;
    if (!s) { const start = await deployBlock(t, head); s = { start, last: start - 1, bal: new Map(), at: 0 }; }
    const st = s;
    const apply = (r: any[]) => { for (const l of r) {
      if (!l.topics || l.topics.length < 3) continue; // an ERC-721-style Transfer has 4 topics and no data value — skip
      const f = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26);
      let v = 0n; try { v = BigInt(l.data && l.data !== '0x' ? l.data : 0); } catch { continue; }
      if (f !== ZERO) st.bal.set(f, (st.bal.get(f) || 0n) - v);
      st.bal.set(to, (st.bal.get(to) || 0n) + v);
    } };
    const scan = async (lo: number, hi: number): Promise<void> => {
      const r = await logs(t, lo, hi);
      if (r === null) { const m = Math.floor((lo + hi) / 2); await scan(lo, m); await scan(m + 1, hi); return; }
      apply(r);
    };
    for (let lo = st.last + 1; lo <= head; lo += RANGE) {
      const hi = Math.min(head, lo + RANGE - 1);
      await scan(lo, hi);
      st.last = hi; // only after the whole range is applied — a failure resumes from here, never double-counts
    }
    for (const [a, v] of st.bal) if (v === 0n) st.bal.delete(a); // emptied wallets: a later transfer re-adds them
    st.at = Date.now();
    keep(t, st); save(t, st);
    // same self-check as batch mode: sum of balances == totalSupply() now
    try { const [sup] = await supplies([t], 'latest'); const sum = sumOf(st);
      counts.set(t, { count: countOf(st), at: st.at, supplyOk: sup != null && (sup === sum || (sup > 0n && (sum > sup ? sum - sup : sup - sum) * 10000n <= sup)) }); saveCounts(); } catch { /* count next pass */ }
    if (fresh) indexStats.indexed++; else indexStats.updates++;
    indexStats.lastMs = Date.now() - t0;
    try { indexStats.tokens = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length; } catch { /* */ }
    return true;
  } catch { indexStats.errors++; return false; }
  finally { busy.delete(t); }
}

/** The top `n` holders, each balance re-checked with balanceOf() (one multicall), and the number of holders. */
export async function indexedHolders(token: string, dec: number, supply: number | null, n = 100):
  Promise<{ top: { rank: number; address: string; balance: number; share: number | null }[]; count: number; at: number } | null> {
  const t = token.toLowerCase(), s = load(t);
  if (!s || !s.at) return null;
  const live = [...s.bal.entries()].filter(([a, v]) => v > 0n && a !== ZERO);
  live.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const cand = live.slice(0, Math.min(live.length, n + 20));
  // re-check against the contract (a rebasing / fee-on-transfer token can drift from the sum of its Transfer events)
  try {
    const r = await main('eth_call', [{ to: MC, data: encAggregate3(cand.map(([a]) => ({ target: t, data: '0x70a08231' + a.slice(2).padStart(64, '0') }))) }, 'latest']);
    const out = r && r.length > 2 ? decAggregate3(r) : [];
    cand.forEach((c, i) => { const h = out[i]; if (h && h.length >= 66) { try { c[1] = BigInt(h.slice(0, 66)); } catch { /* keep the sum */ } } });
    cand.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  } catch { /* shown from the sum */ }
  const div = 10 ** dec;
  const top = cand.filter(([, v]) => v > 0n).slice(0, n).map(([a, v], i) => {
    const bal = Number(v) / div;
    return { rank: i + 1, address: a, balance: bal, share: supply && supply > 0 ? (bal / supply) * 100 : null };
  });
  return { top, count: live.length, at: s.at };
}

/** Holders worth ≥ minUsd at `price`, excluding the given addresses (pools, burn, lockers). From the index — no paging. */
export function indexedHoldersOver(token: string, dec: number, price: number | null, exclude: Set<string>, minUsd = 0.1):
  { over: number; total: number; minUsd: number; capped: boolean; at: number } | null {
  const s = load(token.toLowerCase());
  if (!s || !s.at || !price || !(price > 0)) return null;
  const minRaw = BigInt(Math.ceil((minUsd / price) * 10 ** Math.min(dec, 18))) * 10n ** BigInt(Math.max(0, dec - 18));
  let over = 0, total = 0;
  for (const [a, v] of s.bal) { if (v <= 0n || a === ZERO) continue; total++; if (v >= minRaw && !exclude.has(a)) over++; }
  return { over, total, minUsd, capped: false, at: s.at };
}
export const isIndexed = (token: string) => !!load(token.toLowerCase())?.at;
export const indexedAt = (token: string) => load(token.toLowerCase())?.at ?? 0;

// ── BATCH MODE (09-30) — every liquid token, not just the listed 100 ──────────────────────────────────────────────────
// The screener's holder counts (its 50-holder quality gate) came from arc-scan for ~800 tokens; arc-scan went down.
// Indexing them one by one = 800 deploy-block searches. Instead, up to BATCH tokens share each getLogs (address array),
// and each token's start is found without trusting anyone's data: Multicall3 asks totalSupply() for all of them at
// checkpoints every CHECK blocks (an archive eth_call — Arc's public RPC keeps history, Blockdaemon prunes it); a token
// starts at the last checkpoint where it did not exist yet. Logs before a token's deploy are simply empty.
// ⛔ SELF-CHECK: after the scan, the sum of every balance must equal totalSupply() read now. A token that fails is not
// trusted as a full count (supplyOk:false) — a rebasing / fee-on-transfer token, or a start that was too late.
const ARCHIVE = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org'];
const CHECK = 500_000, BATCH = 40;
async function archiveCall(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 8; i++) { try { return await call(ARCHIVE[i % ARCHIVE.length], method, params); } catch { await sleep(300 * (i + 1)); } }
  throw new Error('archive rpc unavailable');
}
async function supplies(tokens: string[], block: number | 'latest'): Promise<(bigint | null)[]> {
  const r = await archiveCall('eth_call', [{ to: MC, data: encAggregate3(tokens.map((t) => ({ target: t, data: '0x18160ddd' }))) }, block === 'latest' ? 'latest' : '0x' + block.toString(16)]);
  const out = r && r.length > 2 ? decAggregate3(r) : tokens.map(() => null);
  return out.map((h: string | null) => { try { return h && h.length >= 66 ? BigInt(h.slice(0, 66)) : null; } catch { return null; } });
}
export const batchStats = { built: 0, updated: 0, supplyOk: 0, supplyBad: 0, errors: 0, lastMs: 0 };
const counts = new Map<string, { count: number; at: number; supplyOk: boolean }>();
const COUNTS_FILE = path.join(DIR, '..', 'holder-counts.json');
try { for (const [a, v] of Object.entries(JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')))) counts.set(a, v as any); } catch { /* first run */ }
function saveCounts() { try { fs.writeFileSync(COUNTS_FILE + '.tmp', JSON.stringify(Object.fromEntries(counts))); fs.renameSync(COUNTS_FILE + '.tmp', COUNTS_FILE); } catch { /* next */ } }
function countOf(s: State) { let c = 0; for (const [a, v] of s.bal) if (v > 0n && a !== ZERO) c++; return c; }
function sumOf(s: State) { let t = 0n; for (const [a, v] of s.bal) if (v > 0n && a !== ZERO) t += v; return t; }

/** Build (never-indexed) or update (indexed) up to BATCH tokens together. */
export async function indexBatch(tokensIn: string[]): Promise<number> {
  const tokens = [...new Set(tokensIn.map((t) => t.toLowerCase()))].filter((t) => !busy.has(t)).slice(0, BATCH);
  if (!tokens.length) return 0;
  tokens.forEach((t) => busy.add(t));
  const t0 = Date.now();
  try {
    const head = parseInt(await main('eth_blockNumber', []), 16);
    const st = new Map<string, State>();
    const fresh = tokens.filter((t) => !load(t));
    for (const t of tokens) { const s = load(t); if (s) st.set(t, s); }
    if (fresh.length) {
      // checkpoint existence: start = last checkpoint where totalSupply() did not answer
      const start = new Map(fresh.map((t) => [t, 0]));
      for (let b = CHECK; b < head; b += CHECK) {
        const sup = await supplies(fresh, b);
        fresh.forEach((t, i) => { if (sup[i] == null) start.set(t, b); });
        await sleep(100);
      }
      for (const t of fresh) st.set(t, { start: start.get(t)!, last: start.get(t)! - 1, bal: new Map(), at: 0 });
    }
    const from = Math.min(...tokens.map((t) => st.get(t)!.last + 1));
    const apply = (r: any[]) => { for (const l of r) {
      const s = st.get(String(l.address).toLowerCase()); if (!s || !l.topics || l.topics.length < 3) continue;
      const bn = parseInt(l.blockNumber, 16); if (bn <= s.last) continue; // this token already has this block
      const f = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26);
      let v = 0n; try { v = BigInt(l.data && l.data !== '0x' ? l.data : 0); } catch { continue; }
      if (f !== ZERO) s.bal.set(f, (s.bal.get(f) || 0n) - v);
      s.bal.set(to, (s.bal.get(to) || 0n) + v);
    } };
    const scan = async (lo: number, hi: number, addrs: string[]): Promise<void> => {
      let r: any[] | null = null, last = '';
      for (let i = 0; i < 8 && r === null; i++) {
        await sleep(120);
        try { r = await call(WIDE[i % WIDE.length], 'eth_getLogs', [{ address: addrs, topics: [TRANSFER], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]); }
        catch (e) { last = (e as Error).message; if (/too many|exceed|range|size|results/i.test(last) && !/rate limit/i.test(last) && hi - lo > 500) break; await sleep(300 * (i + 1)); }
      }
      if (r === null) {
        if (hi - lo <= 500) throw new Error(`getLogs failed: ${last}`);
        const m = Math.floor((lo + hi) / 2); await scan(lo, m, addrs); await scan(m + 1, hi, addrs); return;
      }
      apply(r);
    };
    for (let lo = from; lo <= head; lo += RANGE) {
      const hi = Math.min(head, lo + RANGE - 1);
      const addrs = tokens.filter((t) => st.get(t)!.last < hi && st.get(t)!.start <= hi);
      if (addrs.length) await scan(lo, hi, addrs);
      for (const t of addrs) st.get(t)!.last = hi;
    }
    const now = await supplies(tokens, 'latest');
    tokens.forEach((t, i) => {
      const s = st.get(t)!;
      for (const [a, v] of s.bal) if (v === 0n) s.bal.delete(a);
      s.last = Math.max(s.last, head); s.at = Date.now();
      const sum = sumOf(s), sup = now[i];
      // burns to 0x…dead stay in the sum (dead is a holder), mints/burns via 0x0 are balanced — so sum == supply exactly
      const ok = sup != null && (sup === sum || (sup > 0n && (sum > sup ? sum - sup : sup - sum) * 10000n <= sup)); // within 0.01%
      if (ok) batchStats.supplyOk++; else batchStats.supplyBad++;
      keep(t, s); save(t, s);
      counts.set(t, { count: countOf(s), at: s.at, supplyOk: ok });
    });
    saveCounts();
    if (fresh.length) batchStats.built += fresh.length;
    batchStats.updated += tokens.length - fresh.length;
    batchStats.lastMs = Date.now() - t0;
    return tokens.length;
  } catch { batchStats.errors++; return 0; }
  finally { tokens.forEach((t) => busy.delete(t)); }
}
export const holderCountOf = (token: string) => counts.get(token.toLowerCase()) ?? null;
