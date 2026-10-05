// OUR OWN WALLET HISTORY (09-30, owner: "Statera builds its own data for everything"). A wallet's token transfers — in and
// out, every ERC-20 incl. native USDC (Arc emits a Transfer log for native value, EIP-7708) — read from chain.
//
// ⛔ WHY: the Portfolio's P&L, the swap panel's "recent activity" and the holdings service's history window all came from
// arc-scan's /address/txs. arc-scan went down 09-30; the holdings window then fell back to "last 1M blocks" (~6 days) and
// silently dropped anything the wallet received before that.
//
// HOW: getLogs Transfer with topic1 = wallet (sent) and topic2 = wallet (received), 95k-block ranges from ERA_START (the
// first ERC-20 on Arc mainnet, EURC at block 542,237) to the head. Saved per wallet and updated from the last block.
import fs from 'node:fs';
import path from 'node:path';

const WIDE = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://arc.gateway.tenderly.co', 'https://rpc.mainnet.arc.io'];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ERA_START = 540_000, RANGE = 95_000, CONC = 2;
const DIR = process.env.WALLETS_DIR || '/root/statera-api-state/wallets';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// ⛔ 10-05: native USDC sent as msg.value (bonding-curve buys, some routers) is logged by THIS system emitter, 18 decimals,
// not by 0x3600. It used to be dropped with the other 0xffff… emitters, so the portfolio P&L never saw what a curve buy cost
// (owner's APEPE: 15 USDC, WarpCat: 2 USDC showed no P&L). Kept now; it is never a holding (no balanceOf).
export const NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';

async function call(url: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(String(j.error.message || 'rpc error'));
  return j.result;
}
// Blockdaemon keeps ~2M blocks of logs ("pruned history unavailable" before that) — older ranges go to the full-history nodes.
// Old ranges: ONLY Tenderly serves them (public RPC rate-limits wide getLogs, dRPC caps 10k blocks, Blockdaemon pruned) —
// so they go to Tenderly alone, paced, with patient retries (8 parallel requests tripped its limit on the first try).
async function logs(topics: (string | null)[], lo: number, hi: number, head: number, address?: string): Promise<any[]> {
  const old = head - lo > 1_900_000;
  const order = old ? [1, 1, 1] : [0, 1, 0];
  let last = '';
  for (let i = 0; i < 10; i++) {
    await sleep(old ? 150 : 60);
    try { return await call(WIDE[order[i % 3]], 'eth_getLogs', [{ ...(address ? { address } : {}), topics, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]); }
    catch (e) { last = (e as Error).message; await sleep(400 * (i + 1)); }
  }
  throw new Error(`getLogs failed: ${last}`);
}

export interface Xfer { h: string; b: number; i: number; t: string; f: string; to: string; v: string }
type W = { last: number; at: number; x: Xfer[]; nat?: boolean }; // nat: native-USDC logs covered back to ERA_START
const mem = new Map<string, W>();
const file = (w: string) => path.join(DIR, `${w}.json`);
function load(w: string): W | null {
  const hit = mem.get(w); if (hit) { mem.delete(w); mem.set(w, hit); return hit; }
  try { const j = JSON.parse(fs.readFileSync(file(w), 'utf8')); if (j?.v !== 1 && j?.v !== 2) return null; const s: W = { last: j.last, at: j.at, x: j.x, nat: j.v === 2 }; put(w, s); return s; } catch { return null; }
}
function put(w: string, s: W) { mem.delete(w); mem.set(w, s); while (mem.size > 200) mem.delete(mem.keys().next().value!); }
function save(w: string, s: W) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file(w) + '.tmp', JSON.stringify({ v: s.nat ? 2 : 1, last: s.last, at: s.at, x: s.x })); fs.renameSync(file(w) + '.tmp', file(w)); } catch { /* next */ }
}
export const walletStats: { built: number; updated: number; errors: number; lastMs: number; nativeBackfills?: number } = { built: 0, updated: 0, errors: 0, lastMs: 0 };
export let lastError = "";
const inflight = new Map<string, Promise<W | null>>();

async function build(w: string): Promise<W | null> {
  const t0 = Date.now();
  try {
    const head = parseInt(await call(WIDE[2], 'eth_blockNumber', []), 16);
    const s: W = load(w) || { last: ERA_START - 1, at: 0, x: [], nat: true }; // a new wallet's first scan covers native logs too
    const fresh = !s.at;
    const pad = '0x' + w.slice(2).padStart(64, '0');
    const ranges: [number, number][] = [];
    for (let lo = s.last + 1; lo <= head; lo += RANGE) ranges.push([lo, Math.min(head, lo + RANGE - 1)]);
    const seen = new Set(s.x.map((x) => `${x.h}:${x.i}`));
    const add = (r: any[]) => { for (const l of r) {
      if (!l.topics || l.topics.length < 3) continue; // ERC-721 transfers carry the id in topic 3 — not a token balance
      if (/^0xffffffff/i.test(String(l.address)) && String(l.address).toLowerCase() !== NATIVE_LOG) continue; // other system emitters
      const k = `${l.transactionHash}:${parseInt(l.logIndex, 16)}`; if (seen.has(k)) continue; seen.add(k);
      s.x.push({ h: l.transactionHash, b: parseInt(l.blockNumber, 16), i: parseInt(l.logIndex, 16), t: String(l.address).toLowerCase(),
        f: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), v: l.data && l.data !== '0x' ? BigInt(l.data).toString() : '0' });
    } };
    let next = 0;
    const worker = async () => { for (;;) { const k = next++; if (k >= ranges.length) return; const [lo, hi] = ranges[k];
      const sent = await logs([TRANSFER, pad], lo, hi, head); const got = await logs([TRANSFER, null, pad], lo, hi, head);
      add(sent); add(got); } };
    await Promise.all(Array.from({ length: Math.min(CONC, ranges.length) }, worker));
    s.x.sort((a, b) => b.b - a.b || b.i - a.i); // newest first
    s.last = head; s.at = Date.now();
    put(w, s); save(w, s);
    if (fresh) walletStats.built++; else walletStats.updated++;
    walletStats.lastMs = Date.now() - t0;
    if (!s.nat) backfillNative(w, s).catch(() => {}); // an older copy: add its native-USDC logs in the background
    return s;
  } catch (e) { walletStats.errors++; lastError = String((e as Error).message).slice(0, 200); return null; }
}
// One-time per stored wallet: the native-USDC logs (NATIVE_LOG) from ERA_START to where the copy was built. Runs behind the
// request (the wallet is served as it is meanwhile); on success the copy is marked nat and saved as v2.
const backfilling = new Set<string>();
async function backfillNative(w: string, s: W) {
  if (backfilling.has(w) || s.nat) return;
  backfilling.add(w);
  try {
    const head = s.last, pad = '0x' + w.slice(2).padStart(64, '0');
    const seen = new Set(s.x.map((x) => `${x.h}:${x.i}`)); const got: Xfer[] = [];
    for (let lo = ERA_START; lo <= head; lo += RANGE) {
      const hi = Math.min(head, lo + RANGE - 1);
      for (const topics of [[TRANSFER, pad], [TRANSFER, null, pad]] as (string | null)[][]) {
        for (const l of await logs(topics, lo, hi, head, NATIVE_LOG)) {
          if (!l.topics || l.topics.length < 3) continue;
          const k = `${l.transactionHash}:${parseInt(l.logIndex, 16)}`; if (seen.has(k)) continue; seen.add(k);
          got.push({ h: l.transactionHash, b: parseInt(l.blockNumber, 16), i: parseInt(l.logIndex, 16), t: NATIVE_LOG,
            f: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), v: l.data && l.data !== '0x' ? BigInt(l.data).toString() : '0' });
        }
      }
    }
    const cur = load(w) || s; // a newer copy may have been saved meanwhile — merge into it
    const have = new Set(cur.x.map((x) => `${x.h}:${x.i}`));
    for (const g of got) if (!have.has(`${g.h}:${g.i}`)) cur.x.push(g);
    cur.x.sort((a, b) => b.b - a.b || b.i - a.i); cur.nat = true;
    put(w, cur); save(w, cur); walletStats.nativeBackfills = (walletStats.nativeBackfills || 0) + 1;
  } catch (e) { lastError = 'native backfill: ' + String((e as Error).message).slice(0, 160); }
  finally { backfilling.delete(w); }
}
/** The wallet's transfers, newest first — up to date within `maxAgeMs` (the saved copy is extended from its last block). */
export async function walletTransfers(wallet: string, maxAgeMs = 30_000): Promise<W | null> {
  const w = wallet.toLowerCase();
  const s = load(w);
  if (s && Date.now() - s.at < maxAgeMs) return s;
  let p = inflight.get(w);
  if (!p) { p = build(w).finally(() => inflight.delete(w)); inflight.set(w, p); }
  return p;
}

// Exact block times for the newest transfers (the swap panel and the chart's B/S markers show real times), cached.
const tsCache = new Map<number, number>();
export async function blockTimes(blocks: number[]): Promise<Map<number, number>> {
  const want = [...new Set(blocks)].filter((b) => !tsCache.has(b)).slice(0, 60);
  for (let i = 0; i < want.length; i += 10) {
    await Promise.all(want.slice(i, i + 10).map(async (b) => {
      for (let k = 0; k < 3; k++) { try { const blk = await call(WIDE[k === 1 ? 2 : 0], 'eth_getBlockByNumber', ['0x' + b.toString(16), false]); if (blk?.timestamp) { tsCache.set(b, parseInt(blk.timestamp, 16) * 1000); return; } } catch { await sleep(200); } }
    }));
  }
  if (tsCache.size > 20000) tsCache.clear();
  return new Map(blocks.map((b) => [b, tsCache.get(b) ?? 0]));
}
