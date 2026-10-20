// Wallet P&L from the swap store (every swap in the wallet's own transactions, exact USD price at the time — see
// server/swap-store.ts swapsInTxs). Replaces the in-tab receipt reconstruction (newest 160 txs, unordered average) when
// the store answers:
//   • trades are walked IN TIME ORDER with a moving average cost — a sell realizes against the cost of what was held then
//   • a token→token swap is two swaps in one tx (sell A for USDC, buy B with it), each valued in USDC — no longer dropped
//   • tokens sold out completely keep their realized result (the "closed positions" list)
//   • pnlSeries: the wallet's total P&L day by day (realized so far + open position marked to that day's close)
import type { TokenPnl } from './arc';
import type { V2WalletSwap } from './v2';

export interface StorePnl extends TokenPnl { trades: number; firstTs: number; lastTs: number; openQty: number; openCost: number; untrackedSold: number }

// One wallet swap list → per-token P&L. Several swaps of the same token in one tx (a route through two pools) are one trade.
export function storePnl(swaps: V2WalletSwap[]): Record<string, StorePnl> {
  const out: Record<string, StorePnl> = {};
  const ordered = [...swaps].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const txSeen = new Set<string>();
  for (const s of ordered) {
    const t = s.token.toLowerCase();
    const p = out[t] || (out[t] = { invested: 0, qtyBought: 0, proceeds: 0, qtySold: 0, avgCost: null, realized: 0, trades: 0, firstTs: s.ts, lastTs: s.ts, openQty: 0, openCost: 0, untrackedSold: 0 });
    const k = s.tx + t + s.side; if (!txSeen.has(k)) { txSeen.add(k); p.trades++; }
    p.lastTs = s.ts;
    if (s.side === 'buy') { p.invested += s.usd; p.qtyBought += s.amount; p.openQty += s.amount; p.openCost += s.usd; }
    else {
      p.proceeds += s.usd; p.qtySold += s.amount;
      const matched = Math.min(s.amount, p.openQty), avg = p.openQty > 0 ? p.openCost / p.openQty : 0;
      // tokens sold beyond what this wallet bought (received by transfer / airdrop) have no known cost: their proceeds are not
      // counted as profit — they're reported as untracked instead
      const proceedsMatched = s.amount > 0 ? s.usd * (matched / s.amount) : 0;
      p.realized += proceedsMatched - avg * matched;
      p.openCost -= avg * matched; p.openQty -= matched;
      p.untrackedSold += s.amount - matched;
      if (p.openQty < 1e-12) { p.openQty = 0; p.openCost = 0; }
    }
    p.avgCost = p.openQty > 0 ? p.openCost / p.openQty : p.qtyBought > 0 ? p.invested / p.qtyBought : null;
  }
  return out;
}

// Daily total P&L. closes[token] = daily closes { time (UTC day start, s) → close }. Days before a token's first close use
// its first known close; a token without any close counts only its realized result.
export function pnlSeries(swaps: V2WalletSwap[], closes: Record<string, Map<number, number>>, nowPx: Record<string, number>): { time: number; value: number; realized: number }[] {
  if (!swaps.length) return [];
  const ordered = [...swaps].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const day = (ts: number) => Math.floor(ts / 86400) * 86400;
  const start = day(ordered[0].ts), end = day(Date.now() / 1000);
  const pos = new Map<string, { q: number; c: number }>();
  let realized = 0, i = 0;
  const lastClose = new Map<string, number>();
  const out: { time: number; value: number; realized: number }[] = [];
  for (let d = start; d <= end; d += 86400) {
    while (i < ordered.length && ordered[i].ts < d + 86400) {
      const s = ordered[i++], t = s.token.toLowerCase(), p = pos.get(t) || { q: 0, c: 0 };
      if (s.side === 'buy') { p.q += s.amount; p.c += s.usd; }
      else { const m = Math.min(s.amount, p.q), avg = p.q > 0 ? p.c / p.q : 0; realized += (s.amount > 0 ? s.usd * (m / s.amount) : 0) - avg * m; p.c -= avg * m; p.q -= m; if (p.q < 1e-12) { p.q = 0; p.c = 0; } }
      pos.set(t, p);
    }
    let unreal = 0;
    for (const [t, p] of pos) {
      if (p.q <= 0) continue;
      const cm = closes[t];
      let px = cm?.get(d) ?? (d === end ? nowPx[t] : undefined);
      if (px == null) px = lastClose.get(t) ?? (cm && cm.size ? cm.values().next().value : undefined);
      if (px != null) { lastClose.set(t, px); unreal += p.q * px - p.c; }
    }
    out.push({ time: d, value: realized + unreal, realized });
  }
  return out;
}
