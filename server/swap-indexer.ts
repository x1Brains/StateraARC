// swap-indexer — keeps EVERY swap of every USDC-paired pool on Arc in server/swap-db.ts (SQLite), so the token chart has
// real history (every timeframe, back to the first Uniswap block) instead of re-scanning the last ~5 days on each request.
//   node --disable-warning=ExperimentalWarning server/swap-indexer.ts      (systemd: server/statera-swaps.service)
// Two cursors, one process:
//   live — follows the head every ~2 s (getLogs from the last indexed block; includes V4 Initialize so new pools are known)
//   back — walks from the first live block DOWN to START_BLOCK (mainnet launch, 2026-09-16), newest history first
// A V4 Initialize pre-pass (the whole chain, ~300 calls) runs once first so every V4 swap can be attributed.
// Venues: Uniswap V3 + Aerodrome/Archery CL (same Swap event), V2 forks (DyorSwap, UniV2, WarpV2, Arctide), Uniswap V4.
// ⛔ A V3/V2/CL pool is accepted only when its factory is a KNOWN factory AND that factory's getPool/getPair returns this
// exact address — anyone can deploy a contract that emits a Swap event claiming to be a USDC pool.
// ⛔ Arc has single-slot finality (no reorgs), so a block once indexed is final.
// Archive RPC: tenderly (blockdaemon is pruned before ~26M, publicnode needs a token). ⛔ rpc.mainnet.arc.io + blockdaemon are what
// the live Arc grid bot and bridge keepers on this box use — the backfill stays OFF them (and paces itself) so it can never get
// this IP rate-limited for the money bots. The head follower makes ~1 call / 2 s.
import { openSwapDb, metaGet, metaSet, txToBlob, addrToBlob, USDC, START_BLOCK } from './swap-db.ts';
import { encAggregate3, decAggregate3 } from '../scripts/lib/multicall.mjs';
import { buildTokenStats } from './swap-stats.ts';
import { initReserveTables, refreshReserves } from './swap-reserves.ts';

const T_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const T_V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const T_V4_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const T_V4_MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'; // ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)
const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const V3_FACTORIES: Record<string, string> = { '0xf0db7b58379503491d857db50ac9ece64c653918': 'V3' };
const CL_FACTORIES: Record<string, string> = { '0xb89df768af2cfe637ceb352c587fe8edaf491d03': 'Aerodrome', '0xc481038c013fe96f38ce7a2dc417b2b1b78b16a4': 'Archery' };
const V2_FACTORIES: Record<string, string> = { '0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10': 'DyorSwap', '0x89e5db8b5aa49aa85ac63f691524311aeb649eba': 'UniV2', '0x32330c2400a6e0830d56661169ebb6c147e3577a': 'WarpV2', '0x6afd30cb35d8b70cfd84c9aca92ddc2dda2879cb': 'Arctide' };
const ARCHIVE = (process.env.SWAPS_RPCS || 'https://arc.gateway.tenderly.co').split(',');
const HEAD_RPCS = [...ARCHIVE, 'https://rpc.blockdaemon.mainnet.arc.io'];
const PACE_MS = Number(process.env.SWAPS_PACE_MS || 250); // pause between backfill steps
const MAX_RANGE = 10_000;               // arc.io caps getLogs at 10k blocks; tenderly at 20k results
const WIDE_RANGE = 95_000;              // tenderly alone takes up to ~100k blocks (sparse early history, the Initialize pre-pass)
const WIDE_RPCS = ARCHIVE.filter((u) => u.includes('tenderly'));
const STOP_AT = process.env.SWAPS_STOP_AT ? Number(process.env.SWAPS_STOP_AT) : null; // test runs: back cursor stops here
const NO_LIVE = process.env.SWAPS_NO_LIVE === '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), '[swaps]', ...a);
const hex = (n: number) => '0x' + n.toString(16);
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const S256 = 1n << 255n, M256 = 1n << 256n;
const word = (d: string, i: number) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
const sword = (d: string, i: number) => { const w = word(d, i); return w >= S256 ? w - M256 : w; };

// ── RPC ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
class TooMany extends Error { to: number | null; constructor(to: number | null) { super('too many results'); this.to = to; } }
let rr = 0;
async function rpc(urls: string[], method: string, params: unknown[], tries = 6): Promise<any> {
  let last = '';
  for (let i = 0; i < tries; i++) {
    const url = urls[(rr++) % urls.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 || r.status >= 500) { last = url + ' ' + r.status; await sleep(400 * (i + 1) + Math.random() * 400); continue; }
      const j: any = await r.json();
      if (j.error) {
        const m = String(j.error.message || '');
        // "query exceeds max results 20000, retry with the range A-B" → the node tells us a range that fits
        if (/max results|too many|exceed|limit/i.test(m) && method === 'eth_getLogs') { const g = m.match(/range\s+(\d+)-(\d+)/); throw new TooMany(g ? Number(g[2]) : null); }
        last = url + ' ' + m.slice(0, 80); await sleep(300 * (i + 1)); continue;
      }
      return j.result;
    } catch (e) { if (e instanceof TooMany) throw e; last = url + ' ' + (e as Error).message; await sleep(400 * (i + 1)); }
  }
  throw new Error(`${method} failed: ${last}`);
}
// getLogs over [from, to]; splits itself when a node says the answer is too big.
async function getLogs(filter: Record<string, unknown>, from: number, to: number): Promise<any[]> {
  const urls = to - from + 1 > MAX_RANGE && WIDE_RPCS.length ? WIDE_RPCS : ARCHIVE;
  try { return await rpc(urls, 'eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]); }
  catch (e) {
    if (!(e instanceof TooMany) || from >= to) throw e;
    const mid = e.to != null && e.to >= from && e.to < to ? e.to : Math.floor((from + to) / 2);
    const a = await getLogs(filter, from, mid);
    const b = await getLogs(filter, mid + 1, to);
    return a.concat(b);
  }
}
// Multicall3 in chunks; a chunk that fails as a whole (one spam contract can burn the call's gas — "out of gas: gas required
// exceeds 30000000") is split in halves down to single calls, and a single call that still fails reads as '0x' (= no answer).
async function multicall(calls: { target: string; data: string }[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < calls.length; i += 100) out.push(...(await mcChunk(calls.slice(i, i + 100))));
  return out;
}
async function mcChunk(part: { target: string; data: string }[]): Promise<string[]> {
  try { return decAggregate3(await rpc(HEAD_RPCS, 'eth_call', [{ to: MULTICALL3, data: encAggregate3(part), gas: '0x1c9c380' }, 'latest'], part.length > 1 ? 3 : 4)); }
  catch (e) {
    // only a call the CHAIN refused is split / given up on; a network failure throws, so the range is retried later
    // (marking a real pool 'no token0' because an RPC hiccupped would hide its swaps for good)
    if (!/gas|revert|execution/i.test((e as Error).message)) throw e;
    if (part.length === 1) return ['0x'];
    const h = Math.ceil(part.length / 2);
    return [...(await mcChunk(part.slice(0, h))), ...(await mcChunk(part.slice(h)))];
  }
}
const addrOf = (r: string) => (r && r.length >= 66 ? ('0x' + r.slice(-40)).toLowerCase() : null);
const uintOf = (r: string) => (r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : null);
const intOf = (r: string) => { if (!r || r.length < 66) return null; let v = BigInt(r.slice(0, 66)); if (v >= S256) v -= M256; return Number(v); };

// ── DB ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const db = openSwapDb(false);
initReserveTables(db); // reserves + V4 tick profiles (server/swap-reserves.ts) — before the v4init insert below is prepared
type PoolRow = { pid: number; key: string; kind: string; token: string | null; usdc0: number; dec: number; ok: number };
// ⛔ 10-20: these were loaded WHOLE into memory at start (every pool ever seen + 264k V4 Initialize rows, mostly decoys) —
// ~600 MB, OOM-killed under the VPS unit's 300 MB cap. Now: read from SQLite on demand behind a bounded LRU (misses cached too).
class DbMap<V> {
  private m = new Map<string, V | null>();
  private q: (k: string) => V | undefined;
  private max: number;
  constructor(q: (k: string) => V | undefined, max = 40_000) { this.q = q; this.max = max; }
  get(k: string): V | undefined {
    if (this.m.has(k)) { const v = this.m.get(k)!; this.m.delete(k); this.m.set(k, v); return v ?? undefined; }
    const v = this.q(k); this.put(k, v ?? null); return v;
  }
  has(k: string) { return this.get(k) !== undefined; }
  set(k: string, v: V) { this.put(k, v); }
  private put(k: string, v: V | null) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!); }
}
const poolQ = db.prepare('SELECT pid,key,kind,token,usdc0,dec,ok FROM pools WHERE key=?');
const poolByKey = new DbMap<PoolRow>((k) => poolQ.get(k) as PoolRow | undefined);
const v4Q = db.prepare('SELECT c0,c1 FROM v4init WHERE pool=?');
const v4 = new DbMap<{ c0: string; c1: string }>((k) => v4Q.get(k) as { c0: string; c1: string } | undefined);
let v4Seen = 0;
const decCache = new Map<string, number | null>();
const insPool = db.prepare('INSERT INTO pools(key,kind,venue,token,usdc0,dec,ok,why,at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING');
const insInit = db.prepare('INSERT OR IGNORE INTO v4init(pool,c0,c1,fee,ts,hooks,blk,spacing) VALUES(?,?,?,?,?,?,?,?)');
const insSwap = db.prepare('INSERT OR IGNORE INTO swaps(blk,li,pid,ts,side,price,usd,amt,tx) VALUES(?,?,?,?,?,?,?,?,?)');
const minuteRows = db.prepare('SELECT price,usd FROM swaps WHERE pid=? AND ts>=? AND ts<? ORDER BY blk,li');
const upC1m = db.prepare('INSERT INTO c1m(pid,t,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(pid,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v,n=excluded.n');
const unknownFactories = new Map<string, number>();

async function decimalsOf(tokens: string[]) {
  const need = [...new Set(tokens)].filter((t) => !decCache.has(t));
  if (!need.length) return;
  const r = await multicall(need.map((t) => ({ target: t, data: '0x313ce567' })));
  need.forEach((t, i) => { const d = uintOf(r[i]); decCache.set(t, d != null && d <= 36 ? d : null); });
}
function addPool(key: string, kind: string, venue: string, token: string | null, usdc0: boolean, dec: number | null, ok: boolean, why: string) {
  insPool.run(key, kind, venue, token, usdc0 ? 1 : 0, dec ?? 0, ok ? 1 : 0, why, Date.now());
  const row = db.prepare('SELECT pid,key,kind,token,usdc0,dec,ok FROM pools WHERE key=?').get(key) as PoolRow;
  poolByKey.set(key, row);
}
// Resolve unseen V3/V2/CL pool addresses: token0/token1/factory/fee/tickSpacing, then ask the factory to confirm.
async function resolvePools(addrs: string[], kinds: Map<string, 'v3' | 'v2'>) {
  const need = [...new Set(addrs)].filter((a) => !poolByKey.has(a));
  if (!need.length) return;
  const SELS = ['0x0dfe1681', '0xd21220a7', '0xc45a0155', '0xddca3f43', '0xd0c93a7c'];
  const r = await multicall(need.flatMap((a) => SELS.map((s) => ({ target: a, data: s }))));
  const cand: { a: string; t0: string; t1: string; fac: string; kind: string; venue: string; check: string }[] = [];
  need.forEach((a, i) => {
    const [t0, t1, fac] = [addrOf(r[i * 5]), addrOf(r[i * 5 + 1]), addrOf(r[i * 5 + 2])];
    const fee = uintOf(r[i * 5 + 3]), ts = intOf(r[i * 5 + 4]);
    const isV2 = kinds.get(a) === 'v2';
    if (!t0 || !t1 || !fac) { addPool(a, isV2 ? 'V2' : 'V3', '?', null, false, null, false, 'no token0/token1/factory'); return; }
    if (t0 !== USDC && t1 !== USDC) { addPool(a, isV2 ? 'V2' : 'V3', '?', null, false, null, false, 'not a USDC pair'); return; }
    let venue: string | undefined, check = '';
    if (isV2 && V2_FACTORIES[fac]) { venue = V2_FACTORIES[fac]; check = '0xe6a43905' + pad(t0) + pad(t1); }
    else if (!isV2 && V3_FACTORIES[fac] && fee != null) { venue = 'V3'; check = '0x1698ee82' + pad(t0) + pad(t1) + fee.toString(16).padStart(64, '0'); }
    else if (!isV2 && CL_FACTORIES[fac] && ts != null) { venue = CL_FACTORIES[fac]; check = '0x28af8d0b' + pad(t0) + pad(t1) + (BigInt.asUintN(256, BigInt(ts))).toString(16).padStart(64, '0'); }
    if (!venue) { unknownFactories.set(fac, (unknownFactories.get(fac) || 0) + 1); addPool(a, isV2 ? 'V2' : 'V3', '?', null, false, null, false, 'unknown factory ' + fac); return; }
    cand.push({ a, t0, t1, fac, kind: isV2 ? 'V2' : CL_FACTORIES[fac] ? 'CL' : 'V3', venue: venue === 'V3' && fee != null ? `V3 ${fee / 1e4}%` : venue, check });
  });
  if (!cand.length) return;
  const chk = await multicall(cand.map((c) => ({ target: c.fac, data: c.check })));
  await decimalsOf(cand.map((c) => (c.t0 === USDC ? c.t1 : c.t0)));
  cand.forEach((c, i) => {
    const token = c.t0 === USDC ? c.t1 : c.t0, dec = decCache.get(token) ?? null;
    const real = addrOf(chk[i]) === c.a;
    addPool(c.a, c.kind, c.venue, token, c.t0 === USDC, dec, real && dec != null, real ? (dec == null ? 'no decimals' : 'ok') : 'factory does not confirm');
  });
}
async function resolveV4(ids: string[]) {
  const need = [...new Set(ids)].filter((id) => !poolByKey.has(id) && v4.has(id));
  if (!need.length) return;
  const toks = need.map((id) => { const p = v4.get(id)!; return p.c0 === USDC ? p.c1 : p.c0; });
  await decimalsOf(toks.filter((t, i) => { const p = v4.get(need[i])!; return p.c0 === USDC || p.c1 === USDC; }));
  need.forEach((id, i) => {
    const p = v4.get(id)!, usdcPair = p.c0 === USDC || p.c1 === USDC, dec = usdcPair ? decCache.get(toks[i]) ?? null : null;
    addPool(id, 'V4', 'V4', usdcPair ? toks[i] : null, p.c0 === USDC, dec, usdcPair && dec != null, usdcPair ? (dec == null ? 'no decimals' : 'ok') : 'not a USDC pair');
  });
}
function storeInits(logs: any[]) {
  for (const l of logs) {
    if ((l.topics?.[0] || '').toLowerCase() !== T_V4_INIT || (l.address || '').toLowerCase() !== PM_V4) continue;
    const id = l.topics[1].toLowerCase(), c0 = ('0x' + l.topics[2].slice(26)).toLowerCase(), c1 = ('0x' + l.topics[3].slice(26)).toLowerCase();
    const d = l.data.slice(2);
    insInit.run(id, c0, c1, Number(word(d, 0)), Number(BigInt(l.blockTimestamp || '0x0')), '0x' + d.slice(64 * 2 + 24, 64 * 3), Number(BigInt(l.blockNumber)), Number(sword(d, 1)));
    v4.set(id, { c0, c1 }); v4Seen++;
  }
}
// Decode one Swap log for a known USDC pool → the row (or null for an unpriceable / zero swap).
function decode(l: any, p: PoolRow): { side: number; price: number; usd: number; amt: number } | null {
  const d = l.data.slice(2), topic = l.topics[0].toLowerCase(), u0 = p.usdc0 === 1, dexp = 10 ** (p.dec - 6);
  let usdc: bigint, tok: bigint, side: number, price: number;
  if (topic === T_V2_SWAP) {
    const a0in = word(d, 0), a1in = word(d, 1), a0out = word(d, 2), a1out = word(d, 3);
    const uIn = u0 ? a0in : a1in, uOut = u0 ? a0out : a1out, tIn = u0 ? a1in : a0in, tOut = u0 ? a1out : a0out;
    usdc = uIn > uOut ? uIn - uOut : uOut - uIn; tok = tIn > tOut ? tIn - tOut : tOut - tIn;
    if (tok === 0n || usdc === 0n) return null;
    side = uIn > uOut ? 1 : -1;
    price = (Number(usdc) / Number(tok)) * dexp;
  } else {
    const a0 = sword(d, 0), a1 = sword(d, 1), sqrtP = word(d, 2);
    if (sqrtP <= 0n) return null;
    const ur = u0 ? a0 : a1, tr = u0 ? a1 : a0;
    usdc = ur < 0n ? -ur : ur; tok = tr < 0n ? -tr : tr;
    if (tok === 0n && usdc === 0n) return null;
    // V3/CL amounts are the POOL's delta (USDC in = buy); V4's are the CALLER's BalanceDelta (token received = buy)
    side = topic === T_V4_SWAP ? (tr > 0n ? 1 : -1) : (ur > 0n ? 1 : -1);
    const ratio = (Number(sqrtP) / 2 ** 96) ** 2;
    price = (u0 ? 1 / ratio : ratio) * dexp;
  }
  if (!isFinite(price) || price <= 0 || price > 1e9) return null;
  return { side, price, usd: Number(usdc) / 1e6, amt: Number(tok) / 10 ** p.dec };
}

const SWAP_FILTER = { topics: [[T_V3_SWAP, T_V2_SWAP, T_V4_SWAP]] };
const LIVE_FILTER = { topics: [[T_V3_SWAP, T_V2_SWAP, T_V4_SWAP, T_V4_INIT, T_V4_MODIFY]] };
export const stats = { stored: 0, skipped: 0, calls: 0 };

// Fetch + store one block range (logs already sorted by the node). Returns how many logs came back.
// Per-UTC-day counters of the live stream (meta day:<YYYY-MM-DD>): every Swap event SEEN by venue (stored or not) and how many were
// STORED — to cross-check against outside counts (e.g. Eita's uni_swaps) and see what the USDC/verified-pool filter drops.
const dayCounts = new Map<string, Record<string, number>>();
function countDay(l: any, stored: boolean) {
  const day = new Date(Number(BigInt(l.blockTimestamp)) * 1000).toISOString().slice(0, 10), t = l.topics[0].toLowerCase();
  const c = dayCounts.get(day) || (() => { const o = JSON.parse(metaGet(db, 'day:' + day) || '{}'); dayCounts.set(day, o); return o; })();
  const k = t === T_V4_SWAP ? 'v4' : t === T_V2_SWAP ? 'v2' : 'v3cl';
  c[k] = (c[k] || 0) + 1; if (stored) c.stored = (c.stored || 0) + 1;
}
async function ingest(logs: any[], fromLive = false): Promise<number> {
  storeInits(logs);
  // V4 positions changed → that pool's tick profile is re-read (reserves); swaps below mark their pools for a reserves refresh
  for (const l of logs) if ((l.topics?.[0] || '').toLowerCase() === T_V4_MODIFY && (l.address || '').toLowerCase() === PM_V4) { const id = l.topics[1].toLowerCase(); profileDirty.add(id); const p = poolByKey.get(id); if (p?.ok) reserveDirty.add(p.pid); }
  const swapLogs = logs.filter((l) => l.topics?.[0] && l.topics[0].toLowerCase() !== T_V4_INIT && l.topics[0].toLowerCase() !== T_V4_MODIFY);
  const kinds = new Map<string, 'v3' | 'v2'>(), addrs: string[] = [], ids: string[] = [];
  for (const l of swapLogs) {
    const t = l.topics[0].toLowerCase(), a = l.address.toLowerCase();
    if (t === T_V4_SWAP) { if (a === PM_V4) ids.push(l.topics[1].toLowerCase()); }
    else { addrs.push(a); kinds.set(a, t === T_V2_SWAP ? 'v2' : 'v3'); }
  }
  await resolvePools(addrs, kinds);
  await resolveV4(ids);
  const touched = new Set<string>();
  db.exec('BEGIN');
  try {
    for (const l of swapLogs) {
      const t = l.topics[0].toLowerCase(), a = l.address.toLowerCase();
      if (t === T_V4_SWAP && a !== PM_V4) continue;
      const p = poolByKey.get(t === T_V4_SWAP ? l.topics[1].toLowerCase() : a);
      if (!p || !p.ok) { stats.skipped++; if (fromLive) countDay(l, false); continue; }
      const r = decode(l, p); if (!r) { stats.skipped++; if (fromLive) countDay(l, false); continue; }
      const ts = Number(BigInt(l.blockTimestamp));
      const res = insSwap.run(Number(BigInt(l.blockNumber)), Number(BigInt(l.logIndex)), p.pid, ts, r.side, r.price, r.usd, r.amt, txToBlob(l.transactionHash));
      if (res.changes) { stats.stored++; touched.add(p.pid + ':' + Math.floor(ts / 60) * 60); if (fromLive) makerQueue.set(l.transactionHash.toLowerCase(), 0); }
      if (fromLive && res.changes) { countDay(l, true); reserveDirty.add(p.pid); }
    }
    for (const k of touched) {
      const [pid, t] = k.split(':').map(Number);
      const rows = minuteRows.all(pid, t, t + 60) as { price: number; usd: number }[];
      if (!rows.length) continue;
      let h = -Infinity, lo = Infinity, v = 0;
      for (const x of rows) { if (x.price > h) h = x.price; if (x.price < lo) lo = x.price; v += x.usd; }
      upC1m.run(pid, t, rows[0].price, h, lo, rows[rows.length - 1].price, v, rows.length);
    }
    for (const [day, c] of dayCounts) metaSet(db, 'day:' + day, JSON.stringify(c));
    if (dayCounts.size > 2) dayCounts.delete(dayCounts.keys().next().value!);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return logs.length;
}

// ── V4 Initialize pre-pass (once): every poolId → currencies, for the whole chain ────────────────────────────────────
async function initPrepass(head: number) {
  let from = Number(metaGet(db, 'init_cursor') || START_BLOCK);
  if (from >= head) return;
  log('V4 Initialize pre-pass', from, '→', head);
  while (from < head) {
    const to = Math.min(head, from + (WIDE_RPCS.length ? WIDE_RANGE : MAX_RANGE) - 1);
    const logs = await getLogs({ address: PM_V4, topics: [T_V4_INIT] }, from, to); stats.calls++;
    db.exec('BEGIN'); try { storeInits(logs); metaSet(db, 'init_cursor', to + 1); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    from = to + 1;
    if (stats.calls % 50 === 0) log('init pre-pass at', from, 'v4 pools', v4Seen);
  }
  log('V4 pre-pass done:', v4Seen, 'new pools');
}

// ── back cursor: from the first live block down to START_BLOCK, 3 ranges in flight ───────────────────────────────────
let span = 4000, lastLog = 0;
async function backfill() {
  const stopAt = STOP_AT ?? START_BLOCK;
  let back = Number(metaGet(db, 'back'));
  while (back > stopAt) {
    const hi = back - 1, lo = Math.max(stopAt, hi - span * 3 + 1);
    const parts: [number, number][] = [];
    for (let f = lo; f <= hi; f += span) parts.push([f, Math.min(hi, f + span - 1)]);
    const t0 = Date.now();
    let res: any[][];
    try { res = await Promise.all(parts.map(([f, t]) => getLogs(SWAP_FILTER, f, t))); stats.calls += parts.length; }
    catch (e) { span = Math.max(500, Math.floor(span / 2)); log('back range failed, retrying with span', span, (e as Error).message); await sleep(3000); continue; }
    const all = res.flat();
    try { await ingest(all); } catch (e) { log('back ingest failed, retrying:', (e as Error).message); await sleep(3000); continue; }
    // the time the history now reaches back to (the chart's "history starts here"): the oldest log, else the block itself
    let backTs: number | null = all.length ? all.reduce((m, l) => Math.min(m, Number(BigInt(l.blockTimestamp))), Infinity) : null;
    if (backTs == null) { const b = await rpc(ARCHIVE, 'eth_getBlockByNumber', [hex(lo), false]).catch(() => null); if (b?.timestamp) backTs = Number(BigInt(b.timestamp)); }
    if (backTs != null) metaSet(db, 'back_ts', backTs);
    metaSet(db, 'back', lo);
    back = lo;
    await sleep(PACE_MS);
    const most = Math.max(...res.map((r) => r.length));
    span = most > 15000 ? Math.max(500, Math.floor(span / 2)) : most < 6000 ? Math.min(WIDE_RPCS.length ? WIDE_RANGE : MAX_RANGE, Math.floor(span * 1.5)) : span;
    if (Date.now() - lastLog > 20_000) { lastLog = Date.now(); log(`back ${lo} (${((hi - START_BLOCK) / 1e6).toFixed(2)}M left) logs ${all.length} stored ${stats.stored} span ${span} ${Date.now() - t0}ms`); }
  }
  metaSet(db, 'back_done', Date.now());
  log('BACKFILL COMPLETE — stored', stats.stored, 'swaps; unknown factories:', JSON.stringify([...unknownFactories].sort((a, b) => b[1] - a[1]).slice(0, 10)));
}

// ── live cursor: head follower ───────────────────────────────────────────────────────────────────────────────────────
async function live() {
  for (;;) {
    try {
      const head = parseInt(await rpc(HEAD_RPCS, 'eth_blockNumber', []), 16);
      let cur = Number(metaGet(db, 'live'));
      while (cur < head) {
        const to = Math.min(head, cur + MAX_RANGE);
        const logs = await getLogs(LIVE_FILTER, cur + 1, to); stats.calls++;
        await ingest(logs, true);
        metaSet(db, 'live', to); metaSet(db, 'live_at', Date.now());
        cur = to;
      }
    } catch (e) { log('live error:', (e as Error).message); await sleep(3000); }
    await sleep(2000);
  }
}

// ── makers: who sent each new swap's transaction (swap events only name the router) ─────────────────────────────────
// Batched eth_getTransactionByHash on a node that still indexes recent txs (blockdaemon answers 100/100 per batch; arc.io
// caps a batch at 30 and has pruned its tx index for older txs — history is filled by scripts/makers-backfill.ts instead).
const MAKER_RPCS = (process.env.SWAPS_MAKER_RPCS || 'https://rpc.blockdaemon.mainnet.arc.io').split(',');
const makerQueue = new Map<string, number>(); // tx → failed attempts
const insMaker = db.prepare('INSERT OR IGNORE INTO makers(tx, maker) VALUES(?, ?)');
export const makerStats = { resolved: 0, dropped: 0 };
async function resolveMakers() {
  const want = [...makerQueue.keys()].slice(0, 500);
  for (let i = 0; i < want.length; i += 100) {
    const part = want.slice(i, i + 100);
    try {
      const r = await fetch(MAKER_RPCS[(rr++) % MAKER_RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(part.map((h, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getTransactionByHash', params: [h] }))), signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json();
      if (!Array.isArray(j)) throw new Error('batch refused');
      db.exec('BEGIN');
      try {
        for (const x of j) {
          const h = part[x.id], from = x?.result?.from;
          if (h && from) { insMaker.run(txToBlob(h), addrToBlob(from)); makerQueue.delete(h); makerStats.resolved++; }
          else if (h) { const n = (makerQueue.get(h) || 0) + 1; if (n >= 6) { makerQueue.delete(h); makerStats.dropped++; } else makerQueue.set(h, n); }
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } catch (e) { log('makers:', (e as Error).message); return; }
    await sleep(300);
  }
}
async function makersLoop() { for (;;) { if (makerQueue.size) await resolveMakers().catch(() => {}); await sleep(15_000); } }

// ── real pool reserves (liquidity): pools that traded / changed positions since the last pass, plus a backlog of the rest ──
const reserveDirty = new Set<number>(), profileDirty = new Set<string>();
const reserveDeps = { mc: multicall, log, logsAt: async (filter: Record<string, unknown>, b: number) => { const r = await rpc(HEAD_RPCS, 'eth_getLogs', [{ ...filter, fromBlock: hex(b), toBlock: hex(b) }]).catch(() => null); return Array.isArray(r) ? r : []; } };
const backlogQ = db.prepare(`SELECT p.pid FROM pools p LEFT JOIN reserves r ON r.pid = p.pid WHERE p.ok = 1 AND r.pid IS NULL
  AND EXISTS (SELECT 1 FROM c1m c WHERE c.pid = p.pid AND c.t >= ?) LIMIT 400`);
const triedAt = new Map<number, number>(); // a pool that could not be measured (no spacing / unreadable) waits an hour
async function reservesLoop() {
  for (;;) {
    try {
      const pids = [...reserveDirty].slice(0, 400); pids.forEach((p) => reserveDirty.delete(p));
      const prof = new Set(profileDirty); profileDirty.clear();
      // backlog: pools active in the last 30 days that have never been measured (first pass after deploy, then new pools)
      const now = Date.now();
      const back = (backlogQ.all(Math.floor(now / 1000) - 30 * 86400) as { pid: number }[]).map((r) => r.pid)
        .filter((p) => !pids.includes(p) && now - (triedAt.get(p) || 0) > 3600_000).slice(0, 40);
      back.forEach((p) => triedAt.set(p, now));
      if (triedAt.size > 50_000) triedAt.clear();
      const n = await refreshReserves(db, reserveDeps, [...pids, ...back], prof);
      if (back.length) log('reserves: measured', n, 'pools (backlog', back.length + ')');
    } catch (e) { log('reserves error:', (e as Error).message); }
    await sleep(60_000);
  }
}

// screener numbers for statera-api (table tstats), every ~2 min
async function statsLoop() {
  for (;;) {
    try {
      const t0 = Date.now(), map = await buildTokenStats(db);
      db.exec('BEGIN');
      try { db.exec('DELETE FROM tstats'); const ins = db.prepare('INSERT INTO tstats(token, j) VALUES(?, ?)'); for (const [k, v] of map) ins.run(k, JSON.stringify(v)); metaSet(db, 'tstats_at', Date.now()); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      if (Date.now() - t0 > 8000) log('stats took', Date.now() - t0, 'ms for', map.size, 'tokens');
    } catch (e) { log('stats error:', (e as Error).message); }
    await sleep(120_000);
  }
}

async function main() {
  const head = parseInt(await rpc(HEAD_RPCS, 'eth_blockNumber', []), 16);
  if (metaGet(db, 'live') == null) { metaSet(db, 'live', head); metaSet(db, 'back', head + 1); metaSet(db, 'started', Date.now()); }
  // The pre-pass only has to reach the block the live follower started at — the live filter includes Initialize from there.
  // ⛔ Re-running it to the CURRENT head on every restart sent wide getLogs to tenderly, which 429s the VPS (crash loop).
  if (metaGet(db, 'init_to') == null) metaSet(db, 'init_to', metaGet(db, 'live')!);
  await initPrepass(Number(metaGet(db, 'init_to')));
  // the pre-pass covered Initialize up to `head`; the live loop's filter includes Initialize from here on
  // after an imported reserves export (scripts/reserves-backfill.ts --import): V4 positions changed between that export and now
  // are marked for a profile re-read (the live follower only sees ModifyLiquidity from this run on)
  const pf = Number(metaGet(db, 'prof_from') || 0), ps = Number(metaGet(db, 'prof_scanned') || 0);
  if (pf && ps < pf) {
    try {
      const to = Number(metaGet(db, 'live'));
      for (let f = pf; f <= to; f += MAX_RANGE) {
        const lg = await getLogs({ address: PM_V4, topics: [T_V4_MODIFY] }, f, Math.min(to, f + MAX_RANGE - 1));
        for (const l of lg) { const id = l.topics[1].toLowerCase(); profileDirty.add(id); const p = poolByKey.get(id); if (p?.ok) reserveDirty.add(p.pid); }
      }
      metaSet(db, 'prof_scanned', pf); log('profiles: catch-up marked', profileDirty.size, 'V4 pools since block', pf);
    } catch (e) { log('profiles catch-up failed:', (e as Error).message); }
  }
  if (!NO_LIVE) { live(); makersLoop(); setTimeout(statsLoop, 20_000); setTimeout(reservesLoop, 30_000); }
  await backfill();
  setInterval(() => metaSet(db, 'unknown_factories', JSON.stringify([...unknownFactories])), 600_000).unref();
}
main().catch((e) => { console.error(e); process.exit(1); });
