// swap-stats — the screener's numbers from the swap store, run INSIDE the indexer (server/swap-indexer.ts) every ~2 min and
// written to table `tstats` (token → JSON); statera-api reads that table (swap-store.ts tokenStatsNow) and overlays the board.
// (Inside the API the 7-day scan blocked every request for ~2 s.)
import type { DatabaseSync } from 'node:sqlite';
export interface StoreTokenStats { volume24h?: number; txns24?: number; change1h?: number | null; change24h?: number | null; spark?: number[]; price?: number | null;
  liq?: number; liqUsdc?: number; liqPools?: number; hi7?: number | null }
// owner 10-20: "the screener's 1h/24h/volume should be real".
// Every ~2 min: per token with trades in the last 7 days — 24h USD volume + trade count across its counted pools, and from its
// busiest pool (7d trade count) the 1h / 24h change and a 7-day sparkline (one close every 4 h). Runs in slices that yield to
// the event loop, so the API keeps answering while it builds.
const yieldNow = () => new Promise((r) => setImmediate(r));
export async function buildTokenStats(d: DatabaseSync): Promise<Map<string, StoreTokenStats>> {
  {
    const now = Math.floor(Date.now() / 1000), d1 = now - 86400, d7 = now - 7 * 86400;
    // pools that traded in the last 7 days, with their token, 7d trade count, 24h volume + count
    const act = d.prepare(`SELECT c.pid, p.token, SUM(c.n) n7, SUM(c.v) v7, SUM(CASE WHEN c.t >= ? THEN c.v ELSE 0 END) v24, SUM(CASE WHEN c.t >= ? THEN c.n ELSE 0 END) n24
      FROM c1m c JOIN pools p ON p.pid = c.pid WHERE c.t >= ? AND p.ok = 1 GROUP BY c.pid`).all(d1, d1, d7) as { pid: number; token: string; n7: number; v7: number; v24: number; n24: number }[];
    await yieldNow();
    const byTok = new Map<string, typeof act>();
    for (const r of act) { const l = byTok.get(r.token); if (l) l.push(r); else byTok.set(r.token, [r]); }
    const at = d.prepare('SELECT c FROM c1m WHERE pid = ? AND t <= ? ORDER BY t DESC LIMIT 1');
    const firstAfter = d.prepare('SELECT c FROM c1m WHERE pid = ? AND t > ? ORDER BY t LIMIT 1');
    const spark = d.prepare('SELECT t / 14400 AS b, MAX(t) AS mt, c FROM c1m WHERE pid = ? AND t >= ? GROUP BY b ORDER BY b');
    // the 7-day high of the main pool's 1-minute CLOSES (a close, not a wick) — the red-flag check measures the drop from it
    const hiQ = d.prepare('SELECT MAX(c) AS hi FROM c1m WHERE pid = ? AND t >= ?');
    const map = new Map<string, StoreTokenStats>();
    let k = 0;
    for (const [tok, list] of byTok) {
      // the same decoy rule as the chart: a pool counts with ≥3 trades and ≥1% of the token's trades (7d)
      const totN = list.reduce((s, x) => s + x.n7, 0);
      const pools = list.filter((x) => x.n7 >= 3 && x.n7 >= totN * 0.01);
      if (!pools.length) continue;
      // the price comes from the deepest pool by USD (same as the chart) — a small side pool's off-market print can't move it
      const main = pools.reduce((a, b) => (b.v7 > a.v7 ? b : a));
      const last = (at.get(main.pid, now) as { c: number } | undefined)?.c ?? null;
      const px = (cut: number) => ((at.get(main.pid, cut) as { c: number } | undefined)?.c ?? (firstAfter.get(main.pid, cut) as { c: number } | undefined)?.c ?? null);
      const p1 = px(now - 3600), p24 = px(d1);
      const ch = (ref: number | null) => (ref && last ? ((last - ref) / ref) * 100 : null);
      const pts = spark.all(main.pid, d7) as { b: number; c: number }[];
      // one point per 4 h bucket, quiet buckets carry the previous close
      const sp: number[] = []; let prev: number | null = null, j = 0;
      for (let b = Math.floor(d7 / 14400); b <= Math.floor(now / 14400); b++) {
        while (j < pts.length && pts[j].b < b) j++;
        if (j < pts.length && pts[j].b === b) prev = pts[j].c;
        if (prev != null) sp.push(prev);
      }
      const hi7 = (hiQ.get(main.pid, d7) as { hi: number | null } | undefined)?.hi ?? null;
      map.set(tok, { volume24h: pools.reduce((s, x) => s + x.v24, 0), txns24: pools.reduce((s, x) => s + x.n24, 0), change1h: ch(p1), change24h: ch(p24), spark: sp, price: last, hi7 });
      if (++k % 150 === 0) await yieldNow();
    }
    // ── liquidity from REAL pool reserves (server/swap-reserves.ts → table reserves): per token, every measured pool's USDC plus
    // its tokens at the pool's own price, the token side counted up to 3 × the USDC (the screener's rule for V3 since 09-25:
    // a pile of unsold tokens next to $0 of USDC is not liquidity — nobody can sell into it)
    try {
      const rs = d.prepare('SELECT p.token, r.usdc, r.tok, r.px FROM reserves r JOIN pools p ON p.pid = r.pid WHERE p.ok = 1').all() as { token: string; usdc: number; tok: number; px: number | null }[];
      const liq = new Map<string, { liq: number; usdc: number; n: number }>();
      for (const r of rs) {
        const px = r.px ?? map.get(r.token)?.price ?? 0, side = Math.max(0, r.tok) * (isFinite(px) ? px : 0), u = Math.max(0, r.usdc);
        const g = liq.get(r.token) || { liq: 0, usdc: 0, n: 0 }; g.liq += u + Math.min(side, u * 3); g.usdc += u; g.n++; liq.set(r.token, g);
      }
      for (const [tok, g] of liq) { const e = map.get(tok) || {}; map.set(tok, { ...e, liq: g.liq, liqUsdc: g.usdc, liqPools: g.n }); }
    } catch { /* reserves table not there yet */ }
    return map;
  }
}

