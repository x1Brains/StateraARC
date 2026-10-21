// swap-reserves — the REAL reserves of every USDC pool, for liquidity (owner 10-21: "only $2,000 in liquidity but 53K in volume …
// do a full audit … you're off"). Run inside server/swap-indexer.ts.
//   V2 / V3 / Aerodrome / Archery pools: the pool contract's own balances (USDC ERC-20 face + token) — re-read after it trades
//   V4 pools (the singleton holds every pool's tokens, so there is no per-pool balance): every position from the pool's tick
//     profile (StateView getTickBitmap / getTickLiquidity), summed at the current price — exactly what the pool could pay out.
//     The profile changes only on ModifyLiquidity (refetched then); a swap only moves the price, taken from the swap itself.
// ⛔ Before: V4 liquidity = (token held by the PoolManager) × price — token side only. A fresh Argus launch (1B tokens in the
// pool, $0 USDC) read $2.48K "liquidity" = its whole market cap; TOLLY's listed V4 pool holds nothing at all.
import type { DatabaseSync } from 'node:sqlite';

const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';   // Uniswap V4 StateView on Arc
const USDC = '0x3600000000000000000000000000000000000000';
const S_SLOT0 = '0xc815641c', S_BITMAP = '0x1c7ccb4c', S_TICK = '0xcaedab54';
const w32 = (n: number | bigint) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const big = (h: string | undefined) => (h && h.length >= 66 ? BigInt(h.slice(0, 66)) : 0n);
const sqrtAt = (t: number) => Math.sqrt(1.0001 ** t);
export const MAX_V4_WORDS = 3000; // tick spacing ≥ 3 (spacing 1 = 6.9k bitmap words — read lazily, never in the hot path)

export type Deps = { mc: (calls: { target: string; data: string }[]) => Promise<string[]>; logsAt: (filter: Record<string, unknown>, block: number) => Promise<any[]>; log: (...a: unknown[]) => void };
type Pool = { pid: number; key: string; kind: string; token: string; usdc0: number; dec: number };

export function initReserveTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS supply (token TEXT PRIMARY KEY, total REAL NOT NULL, burned REAL NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reserves (pid INTEGER PRIMARY KEY, usdc REAL NOT NULL, tok REAL NOT NULL, px REAL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS v4profile (pool TEXT PRIMARY KEY, spacing INTEGER, j TEXT, at INTEGER);`);
  try { db.exec('ALTER TABLE v4init ADD COLUMN spacing INTEGER'); } catch { /* already there */ }
}

// tick spacing of a V4 pool: from v4init (captured live), else its Initialize log (one block read), saved
async function spacingOf(db: DatabaseSync, d: Deps, pool: string): Promise<number | null> {
  const r = db.prepare('SELECT spacing, blk FROM v4init WHERE pool = ?').get(pool) as { spacing: number | null; blk: number } | undefined;
  if (!r) return null;
  if (r.spacing) return r.spacing;
  const lg = await d.logsAt({ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', topics: ['0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', pool] }, r.blk);
  if (!lg[0]) return null;
  const sp = Number(BigInt.asIntN(24, BigInt('0x' + lg[0].data.slice(2 + 64, 2 + 128))));
  db.prepare('UPDATE v4init SET spacing = ? WHERE pool = ?').run(sp, pool);
  return sp;
}
async function v4Profile(db: DatabaseSync, d: Deps, pool: string, refresh: boolean): Promise<{ t: number[]; n: string[] } | null> {
  const row = db.prepare('SELECT j FROM v4profile WHERE pool = ?').get(pool) as { j: string } | undefined;
  if (row && !refresh) return JSON.parse(row.j);
  const sp = await spacingOf(db, d, pool); if (!sp) return null;
  const p = pool.slice(2), minW = Math.floor(Math.floor(-887272 / sp) / 256), maxW = Math.floor(Math.floor(887272 / sp) / 256);
  if (maxW - minW + 1 > MAX_V4_WORDS) return null;
  const words: number[] = []; for (let w = minW; w <= maxW; w++) words.push(w);
  const bm = await d.mc(words.map((w) => ({ target: SV, data: S_BITMAP + p + w32(w) })));
  const ticks: number[] = [];
  words.forEach((w, i) => { const v = big(bm[i]); if (!v) return; for (let b = 0; b < 256; b++) if ((v >> BigInt(b)) & 1n) ticks.push((w * 256 + b) * sp); });
  ticks.sort((a, b) => a - b);
  const tl = ticks.length ? await d.mc(ticks.map((t) => ({ target: SV, data: S_TICK + p + w32(t) }))) : [];
  const prof = { t: ticks, n: tl.map((h) => BigInt.asIntN(128, BigInt('0x' + (h || '0x' + '0'.repeat(128)).slice(66, 130))).toString()) };
  db.prepare('INSERT INTO v4profile(pool, spacing, j, at) VALUES(?,?,?,?) ON CONFLICT(pool) DO UPDATE SET spacing=excluded.spacing, j=excluded.j, at=excluded.at').run(pool, sp, JSON.stringify(prof), Date.now());
  return prof;
}
// raw token0 / token1 amounts of every position at sqrtP (Q96-decoded)
function amountsAt(prof: { t: number[]; n: string[] }, sqrtP: number) {
  let L = 0n, a0 = 0, a1 = 0;
  for (let i = 0; i < prof.t.length - 1; i++) {
    L += BigInt(prof.n[i]); if (L <= 0n) continue;
    const lo = sqrtAt(prof.t[i]), hi = sqrtAt(prof.t[i + 1]), Ln = Number(L);
    if (sqrtP <= lo) a0 += Ln * (1 / lo - 1 / hi); else if (sqrtP >= hi) a1 += Ln * (hi - lo); else { a0 += Ln * (1 / sqrtP - 1 / hi); a1 += Ln * (sqrtP - lo); }
  }
  return { a0, a1 };
}

/** Re-read the reserves of these pools (`refreshProfile`: V4 pools whose positions changed). */
export async function refreshReserves(db: DatabaseSync, d: Deps, pids: number[], refreshProfile: Set<string>): Promise<number> {
  if (!pids.length) return 0;
  const pools = db.prepare(`SELECT pid, key, kind, token, usdc0, dec FROM pools WHERE ok = 1 AND pid IN (${pids.map(() => '?').join(',')})`).all(...pids) as Pool[];
  const put = db.prepare('INSERT INTO reserves(pid, usdc, tok, px, at) VALUES(?,?,?,?,?) ON CONFLICT(pid) DO UPDATE SET usdc=excluded.usdc, tok=excluded.tok, px=excluded.px, at=excluded.at');
  const lastPx = db.prepare('SELECT price FROM swaps WHERE pid = ? ORDER BY ts DESC LIMIT 1');
  let n = 0;
  // pool contracts: two balanceOf each, one multicall for all
  const own = pools.filter((p) => p.kind !== 'V4');
  if (own.length) {
    const r = await d.mc(own.flatMap((p) => [{ target: USDC, data: '0x70a08231' + pad(p.key) }, { target: p.token, data: '0x70a08231' + pad(p.key) }]));
    db.exec('BEGIN');
    try { own.forEach((p, i) => { if (!r[i * 2] || r[i * 2] === '0x') return; const px = (lastPx.get(p.pid) as { price: number } | undefined)?.price ?? null;
      put.run(p.pid, Number(big(r[i * 2])) / 1e6, Number(big(r[i * 2 + 1])) / 10 ** p.dec, px, Date.now()); n++; }); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // V4: positions × current price (price from slot0 — exact, one multicall for all)
  const v4 = pools.filter((p) => p.kind === 'V4');
  if (v4.length) {
    const s0 = await d.mc(v4.map((p) => ({ target: SV, data: S_SLOT0 + p.key.slice(2) })));
    for (let i = 0; i < v4.length; i++) {
      const p = v4[i];
      try {
        const sq = Number(big(s0[i]) & ((1n << 160n) - 1n)) / 2 ** 96; if (!(sq > 0)) continue;
        const prof = await v4Profile(db, d, p.key, refreshProfile.has(p.key)); if (!prof) continue;
        const { a0, a1 } = amountsAt(prof, sq), ra = sq * sq, dexp = 10 ** (p.dec - 6);
        const usdc = (p.usdc0 ? a0 : a1) / 1e6, tok = (p.usdc0 ? a1 : a0) / 10 ** p.dec, px = (p.usdc0 ? 1 / ra : ra) * dexp;
        put.run(p.pid, usdc, tok, isFinite(px) ? px : null, Date.now()); n++;
      } catch (e) { d.log('reserves v4', p.key.slice(0, 10), (e as Error).message); }
    }
  }
  return n;
}
