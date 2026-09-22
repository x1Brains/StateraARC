// Arc name resolution (.arc / .circle) — address -> human name, with the safety checks that
// make it safe to DISPLAY. Verified on Arc mainnet 2026-09-22.
//
// ⛔ THE RULE: a reverse name is a CLAIM, not a fact. Anyone can point their wallet's reverse
// record at "circle.arc". It only counts if resolving that name FORWARD lands back on the same
// address. We never render an unconfirmed name — we fall back to the hex address instead.
//
// Second guard: even a forward-confirmed name can be a homoglyph ("circlе.arc" with a Cyrillic
// е resolves back to the attacker's own wallet and is therefore "confirmed"). So the string
// itself must be plain ASCII before we are willing to draw it. See ARC_NAMES.md §4.
//
// Cost: 4 batched eth_calls total, no matter how many addresses — all through Multicall3.
import { useEffect, useState } from 'react';
import { keccak_256 } from '@noble/hashes/sha3';
import { mCall } from './arc';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // verified deployed on Arc mainnet

// Registries we read. ArcNS is the only one with live mainnet names today (18 .arc, 8 .circle as
// of 2026-09-22). Adding our own registry later = one more entry here, nothing else changes.
const REGISTRIES = [
  { label: 'ArcNS', registry: '0xcA4d60A6d237EDa59aA1F57EbAe6B3150BcAb8Fb', tlds: ['arc', 'circle'] },
];

// selectors
const SEL_RESOLVER = '0x0178b8bf'; // registry.resolver(bytes32)
const SEL_NAME     = '0x691f3431'; // resolver.name(bytes32)
const SEL_ADDR     = '0x3b3b57de'; // resolver.addr(bytes32)
const SEL_AGG3     = '0x82ad56cb'; // multicall3.aggregate3((address,bool,bytes)[])
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

// ── hashing ──────────────────────────────────────────────────────────────────
const toHex = (u8: Uint8Array) => '0x' + Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => { const s = h.replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
const utf8 = (s: string) => new TextEncoder().encode(s);

export function namehash(name: string): string {
  let node = ZERO32;
  if (!name) return node;
  const labels = name.split('.');
  for (let i = labels.length - 1; i >= 0; i--) {
    const cat = new Uint8Array(64);
    cat.set(fromHex(node), 0);
    cat.set(keccak_256(utf8(labels[i])), 32);
    node = toHex(keccak_256(cat));
  }
  return node;
}

const ADDR_REVERSE_NODE = namehash('addr.reverse');

/** ENS derivation: keccak(namehash("addr.reverse") ++ keccak(lowercase hex address, no 0x)) */
export function reverseNode(addr: string): string {
  const cat = new Uint8Array(64);
  cat.set(fromHex(ADDR_REVERSE_NODE), 0);
  cat.set(keccak_256(utf8(addr.toLowerCase().replace(/^0x/, ''))), 32);
  return toHex(keccak_256(cat));
}

// ── the display guard ────────────────────────────────────────────────────────
// Plain lowercase ASCII only, known TLD only, and never a label that imitates a hex address.
// Anything rejected here is shown as the raw address instead — a name we cannot vouch for is
// strictly worse than an address, because an address does not lie about who it is.
const LABEL_OK = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;
const KNOWN_TLDS = new Set(REGISTRIES.flatMap((r) => r.tlds));

export function isDisplayableName(name: string): boolean {
  if (!name || name.length > 64 || name !== name.toLowerCase()) return false;
  const parts = name.split('.');
  if (parts.length < 2) return false;
  if (!KNOWN_TLDS.has(parts[parts.length - 1])) return false;
  for (const p of parts) {
    if (!LABEL_OK.test(p)) return false;          // rejects unicode, zero-width, spaces, edge hyphens
    if (/^0x[0-9a-f]+$/.test(p)) return false;    // a label must never impersonate an address
  }
  return true;
}

// ── multicall ────────────────────────────────────────────────────────────────
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
const word = (n: number) => n.toString(16).padStart(64, '0');

type Call = { to: string; data: string };

function encodeAggregate3(calls: Call[]): string {
  const heads: string[] = [];
  const bodies: string[] = [];
  // element offsets are relative to the start of the element region (just past the length word)
  let cursor = calls.length * 32;
  for (const c of calls) {
    heads.push(word(cursor));
    const payload = c.data.replace(/^0x/, '');
    const bytesLen = payload.length / 2;
    const padded = payload.padEnd(Math.ceil(bytesLen / 32) * 64, '0');
    // tuple: target, allowFailure=true, offset-to-bytes(0x60), length, data
    const body = pad(c.to) + word(1) + word(0x60) + word(bytesLen) + padded;
    bodies.push(body);
    cursor += body.length / 2;
  }
  return SEL_AGG3 + word(0x20) + word(calls.length) + heads.join('') + bodies.join('');
}

function decodeAggregate3(ret: string | null, n: number): (string | null)[] {
  const out: (string | null)[] = new Array(n).fill(null);
  if (!ret || ret === '0x') return out;
  const h = ret.replace(/^0x/, '');
  const at = (off: number) => h.slice(off * 2, off * 2 + 64);
  try {
    const arrOff = Number(BigInt('0x' + at(0)));
    const len = Number(BigInt('0x' + at(arrOff)));
    const elemsBase = arrOff + 32;
    for (let i = 0; i < Math.min(len, n); i++) {
      const eOff = elemsBase + Number(BigInt('0x' + at(elemsBase + i * 32)));
      const ok = BigInt('0x' + at(eOff)) === 1n;
      if (!ok) continue;
      const bOff = eOff + Number(BigInt('0x' + at(eOff + 32)));
      const bLen = Number(BigInt('0x' + at(bOff)));
      out[i] = '0x' + h.slice((bOff + 32) * 2, (bOff + 32 + bLen) * 2);
    }
  } catch { /* malformed batch — treat as all-unresolved, never as a name */ }
  return out;
}

const batch = async (calls: Call[]): Promise<(string | null)[]> => {
  if (!calls.length) return [];
  return decodeAggregate3(await mCall(MULTICALL3, encodeAggregate3(calls)), calls.length);
};

const decodeAddress = (h: string | null) => (h && h.length >= 66 ? '0x' + h.slice(-40) : null);
const decodeString = (h: string | null) => {
  if (!h || h.length < 130) return null;
  try {
    const len = Number(BigInt('0x' + h.slice(66, 130)));
    if (!len || len > 256) return null;
    let s = '';
    for (let i = 0; i < len; i++) { const c = parseInt(h.substr(130 + i * 2, 2), 16); if (!c) return null; s += String.fromCharCode(c); }
    return s;
  } catch { return null; }
};

// ── resolution ───────────────────────────────────────────────────────────────
export interface NameRec { name: string; registry: string }

const CACHE_KEY = 'arcnames.v1';
const TTL_MS = 10 * 60 * 1000;
type CacheEntry = { name: string | null; registry: string | null; at: number };
const mem = new Map<string, CacheEntry>();

function loadCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(o)) if (now - v.at < TTL_MS) mem.set(k, v);
  } catch { /* private mode / blocked storage — memory cache still works */ }
}
let cacheLoaded = false;
function saveCache() {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(mem))); } catch { /* ignore */ }
}

/**
 * Batch reverse-resolve addresses to forward-CONFIRMED names.
 * Returns only entries we are willing to display; everything else is simply absent.
 */
export async function resolveNames(addresses: string[]): Promise<Map<string, NameRec>> {
  if (!cacheLoaded) { loadCache(); cacheLoaded = true; }
  const out = new Map<string, NameRec>();
  const now = Date.now();
  const want: string[] = [];
  for (const a of addresses) {
    if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
    const k = a.toLowerCase();
    const hit = mem.get(k);
    if (hit && now - hit.at < TTL_MS) { if (hit.name && hit.registry) out.set(k, { name: hit.name, registry: hit.registry }); continue; }
    if (!want.includes(k)) want.push(k);
  }
  if (!want.length) return out;

  for (const R of REGISTRIES) {
    const pending = want.filter((a) => !out.has(a));
    if (!pending.length) break;
    const rnodes = pending.map(reverseNode);

    // 1. which reverse nodes have a resolver?
    const resolvers = (await batch(rnodes.map((n) => ({ to: R.registry, data: SEL_RESOLVER + pad(n) })))).map(decodeAddress);

    // 2. read the CLAIMED name from each
    const step2 = pending.map((a, i) => ({ a, res: resolvers[i], node: rnodes[i] }))
      .filter((x) => x.res && x.res !== '0x0000000000000000000000000000000000000000');
    const claimed = (await batch(step2.map((x) => ({ to: x.res!, data: SEL_NAME + pad(x.node) })))).map(decodeString);

    // 3. keep only names that pass the display guard, then look up THEIR resolver
    const cand = step2.map((x, i) => ({ ...x, name: claimed[i] }))
      .filter((x) => x.name && isDisplayableName(x.name)) as { a: string; name: string }[];
    const fnodes = cand.map((c) => namehash(c.name));
    const fResolvers = (await batch(fnodes.map((n) => ({ to: R.registry, data: SEL_RESOLVER + pad(n) })))).map(decodeAddress);

    // 4. forward-confirm: the name must resolve BACK to the same address
    const step4 = cand.map((c, i) => ({ ...c, res: fResolvers[i], node: fnodes[i] }))
      .filter((x) => x.res && x.res !== '0x0000000000000000000000000000000000000000');
    const fwd = (await batch(step4.map((x) => ({ to: x.res!, data: SEL_ADDR + pad(x.node) })))).map(decodeAddress);

    step4.forEach((x, i) => {
      if (fwd[i] && fwd[i]!.toLowerCase() === x.a) out.set(x.a, { name: x.name, registry: R.label });
    });
  }

  for (const a of want) {
    const rec = out.get(a) ?? null;
    mem.set(a, { name: rec?.name ?? null, registry: rec?.registry ?? null, at: now });
  }
  saveCache();
  return out;
}

/** React hook: pass the addresses on screen, get back the confirmed names. */
export function useNames(addresses: (string | null | undefined)[]): Map<string, NameRec> {
  const [names, setNames] = useState<Map<string, NameRec>>(new Map());
  const key = addresses.filter(Boolean).map((a) => a!.toLowerCase()).sort().join(',');
  useEffect(() => {
    if (!key) { setNames(new Map()); return; }
    let alive = true;
    resolveNames(key.split(',')).then((m) => { if (alive) setNames(m); }).catch(() => {});
    return () => { alive = false; };
  }, [key]);
  return names;
}

/** The one display helper: a confirmed name, else the shortened address. */
export const shortAddr = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
/** A confirmed name, else the shortened address. `short` lets a caller keep its own truncation. */
export function displayName(addr: string, names: Map<string, NameRec>, short: (a: string) => string = shortAddr): string {
  return names.get((addr || '').toLowerCase())?.name || short(addr);
}
/** True when we are rendering a name rather than an address — for styling / the "verified" dot. */
export const hasName = (addr: string, names: Map<string, NameRec>) => names.has((addr || '').toLowerCase());
