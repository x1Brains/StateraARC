// HOLDER INTEL for the token page (owner 09-29, from the GLITCH dev's feedback):
//  1. every top holder gets a badge: Uniswap V4 pools / Liquidity pool / Burned / Locked (with unlock dates) / Contract;
//  2. token LOCKS are read from the locker contract itself — amount still locked and when each part unlocks;
//  3. "holders over $0.10": arc-scan's count includes every dust wallet (GLITCH: 62,250 holders, 245 over ten cents).
// Everything is read on chain or from arc-scan's balance index; nothing is guessed. Cached so the warmer pays, not visitors.
import { encAggregate3, decAggregate3 } from '../scripts/lib/multicall.mjs';

const RPCS = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org'];
const MC = '0xca11bde05977b3631167028862be2a173976ca11';
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');

async function rpc(method: string, params: unknown[]): Promise<any> {
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
      const j: any = await r.json();
      if (j && j.result !== undefined) return j.result;
    } catch { /* next rpc */ }
  }
  return null;
}
async function multicall(calls: { target: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += 100) {
    const ch = calls.slice(i, i + 100);
    const r = await rpc('eth_call', [{ to: MC, data: encAggregate3(ch) }, 'latest']);
    out.push(...(r && r.length > 2 ? decAggregate3(r) : ch.map(() => null)));
  }
  return out;
}

// ── known addresses ──
export const POOL_MANAGER_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const BURN = new Set(['0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000']);
// Token lockers. The Argus one was identified 09-29 from its own bytecode (lock / withdraw / getLock / lockedTotal / extend)
// and holds only Argus-pad tokens (GLITCH 5%, ARGUS, ARCANUS…); the GLITCH dev calls it "locked on argus".
// getLock(i) → (token, unlockTime, withdrawn?, owner, lockedAt, amount) — word 2 is 0 on every live lock seen.
export const LOCKERS: { address: string; label: string }[] = [
  { address: '0xfee1d11d4501d66d8ea1024dc198ee5663c2bf6b', label: 'Argus locker' },
];
const LOCKER_SET = new Map(LOCKERS.map((l) => [l.address, l]));

// ── 1. contract or wallet (eth_getCode; a contract stays a contract — cached for the process) ──
const codeCache = new Map<string, boolean>();
export async function contractFlags(addrs: string[]): Promise<Map<string, boolean>> {
  const want = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => !codeCache.has(a));
  // a few at a time: the public RPC refuses bursts of ~20
  for (let i = 0; i < want.length; i += 8) {
    const ch = want.slice(i, i + 8);
    const codes = await Promise.all(ch.map((a) => rpc('eth_getCode', [a, 'latest'])));
    ch.forEach((a, j) => { if (codes[j] != null) codeCache.set(a, codes[j] !== '0x'); });
  }
  return new Map(addrs.map((a) => [a.toLowerCase(), codeCache.get(a.toLowerCase()) ?? false]));
}

// ── 2. locks (every locker's full lock list, one multicall, refreshed every 10 min) ──
type Lock = { locker: string; label: string; token: string; unlock: number; owner: string; amountRaw: bigint; withdrawn: boolean };
let locks: Lock[] = [], locksAt = 0, locksP: Promise<void> | null = null;
async function refreshLocks() {
  const all: Lock[] = [];
  for (const L of LOCKERS) {
    const n = await rpc('eth_call', [{ to: L.address, data: '0x9b10b6f5' }, 'latest']); // lockCount()
    if (!n) return; // keep the old list on a failed read
    const count = Number(BigInt(n));
    const res = await multicall(Array.from({ length: count + 1 }, (_, i) => ({ target: L.address, data: '0xd68f4dd1' + pad('0x' + i.toString(16)) })));
    res.forEach((h) => {
      if (!h || h.length < 2 + 64 * 6) return;
      const w = (k: number) => '0x' + h.slice(2 + k * 64, 2 + (k + 1) * 64);
      const token = '0x' + w(0).slice(-40);
      if (/^0x0+$/.test(token)) return;
      all.push({ locker: L.address, label: L.label, token, unlock: Number(BigInt(w(1))), withdrawn: BigInt(w(2)) !== 0n, owner: '0x' + w(3).slice(-40), amountRaw: BigInt(w(5)) });
    });
  }
  locks = all; locksAt = Date.now();
}
async function ensureLocks() {
  if (Date.now() - locksAt < 10 * 60_000) return;
  locksP ||= refreshLocks().catch(() => {}).finally(() => { locksP = null; });
  await locksP;
}
export interface TokenLocks { locker: string; label: string; locked: number; pct: number | null; nextUnlock: number | null; lastUnlock: number | null; parts: { amount: number; unlock: number }[]; expiredNotWithdrawn: number }
/** Tokens still locked (unlock date in the future) per locker, with each part's unlock time. */
export async function tokenLocks(token: string, dec: number, supply: number | null): Promise<TokenLocks[]> {
  await ensureLocks();
  const t = token.toLowerCase(), now = Date.now() / 1000, out: TokenLocks[] = [];
  for (const L of LOCKERS) {
    const mine = locks.filter((l) => l.locker === L.address && l.token === t && !l.withdrawn && l.amountRaw > 0n);
    if (!mine.length) continue;
    const amt = (l: Lock) => Number(l.amountRaw) / 10 ** dec;
    const live = mine.filter((l) => l.unlock > now).sort((a, b) => a.unlock - b.unlock);
    const locked = live.reduce((s, l) => s + amt(l), 0);
    out.push({ locker: L.address, label: L.label, locked, pct: supply && supply > 0 ? (locked / supply) * 100 : null,
      nextUnlock: live[0]?.unlock ?? null, lastUnlock: live.length ? live[live.length - 1].unlock : null,
      parts: live.map((l) => ({ amount: amt(l), unlock: l.unlock })), expiredNotWithdrawn: mine.filter((l) => l.unlock <= now).reduce((s, l) => s + amt(l), 0) });
  }
  return out;
}

// ── badges for the top holders ──
export type HolderKind = 'v4' | 'pool' | 'burn' | 'locker' | 'contract' | null;
export async function holderBadges(addrs: string[], poolAddrs: string[]): Promise<Map<string, { kind: HolderKind; label: string | null }>> {
  const pools = new Set(poolAddrs.map((a) => a.toLowerCase()));
  const plain = addrs.map((a) => a.toLowerCase()).filter((a) => a !== POOL_MANAGER_V4 && !BURN.has(a) && !pools.has(a) && !LOCKER_SET.has(a));
  const isC = await contractFlags(plain);
  const out = new Map<string, { kind: HolderKind; label: string | null }>();
  for (const raw of addrs) {
    const a = raw.toLowerCase();
    if (a === POOL_MANAGER_V4) out.set(a, { kind: 'v4', label: 'Uniswap V4 pools' });
    else if (BURN.has(a)) out.set(a, { kind: 'burn', label: 'Burned' });
    else if (pools.has(a)) out.set(a, { kind: 'pool', label: 'Liquidity pool' });
    else if (LOCKER_SET.has(a)) out.set(a, { kind: 'locker', label: LOCKER_SET.get(a)!.label });
    else if (isC.get(a)) out.set(a, { kind: 'contract', label: null });
    else out.set(a, { kind: null, label: null });
  }
  return out;
}

// ── 3. holders over $0.10 (arc-scan's balance index, largest first — stop at the first balance under ten cents) ──
export interface HoldersOver { over: number; total: number | null; minUsd: number; capped: boolean; at: number }
const overCache = new Map<string, HoldersOver>();
const MAX_PAGES = 150; // 15,000 holders (background only, ~30 s); beyond that the page shows "15,000+"
export async function holdersOver(token: string, price: number | null, exclude: string[], minUsd = 0.1): Promise<HoldersOver | null> {
  const t = token.toLowerCase(), hit = overCache.get(t);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit;
  if (!price || !(price > 0) || !isFinite(price)) return hit ?? null;
  const minBal = minUsd / price, skip = new Set([...exclude.map((a) => a.toLowerCase()), POOL_MANAGER_V4, ...BURN, ...LOCKER_SET.keys()]);
  let cursor: string | null = null, pages = 0, over = 0, total: number | null = null, capped = false;
  try {
    for (;;) {
      const r = await fetch(`https://api.arc-scan.org/v1/tokens/${t}/holders?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return hit ?? null;
      const j: any = await r.json(); pages++;
      if (j.holder_count != null) total = Number(j.holder_count);
      let stop = false;
      for (const h of j.items || []) {
        const a = String(h.address?.address || '').toLowerCase(), bal = Number(h.balance?.formatted ?? 0);
        if (!(bal >= minBal)) { stop = true; break; }
        if (!skip.has(a)) over++;
      }
      if (stop || !j.page?.has_more) break;
      if (pages >= MAX_PAGES) { capped = true; break; }
      cursor = j.page.next;
    }
  } catch { return hit ?? null; }
  const v: HoldersOver = { over, total, minUsd, capped, at: Date.now() };
  overCache.set(t, v);
  return v;
}
