// THE BOARD — every rule that decides what the screener, the home dashboard, the market stats and the swap picker show.
// Pure functions over the token list: no React, no fetch, no DOM. The SAME file runs in the browser (App.tsx) and on the
// VPS (server/statera-api.mjs, Node strip-types), so the two can never drift. Extracted verbatim from App.tsx on
// 2026-09-28 (v1-baseline tag) and A/B-proven identical by scripts/regress/board-ab.ts — change a rule HERE only.
// ⛔ Node runs this file with type-stripping: type-only imports, no enums/namespaces/parameter properties.
import type { Token } from './rules.ts';

export type Filter = 'all' | 'new' | 'eco';
export type SortKey = 'liq' | 'mcap' | 'holders' | 'price' | 'name' | 'volume' | 'change24h' | 'change1h' | 'age';
export type Dir = 'desc' | 'asc';

export const MIN_HOLDERS = 50; // sub-50-holder pools are always hidden from the screener (no toggle — owner call)
// ⛔ 09-26 (owner: "ur filter aint blocking a lot of spam pools"): holder counts are GAMED by dust airdrops — TIP 33,612
// holders / $0 volume, DALVBANG 21,059 / $0, INU 10,337 / $0. Of 314 tokens passing the holder bar only 89 had traded $50
// in 24h. The default screener + dashboard show ACTIVE tokens only (24h volume >= $50, or a pinned/core asset); the rest
// stay searchable and one tap away ("Show inactive").
export const MIN_VOL_24H = 50;

export const LP_DESC: Record<string, string> = {
  'Argus pad': 'Minted by the Argus launchpad contracts (the ARGUS team) — GLITCH and most Arc meme launches.',
  'faze.fun': 'Minted by the faze.fun launchpad.',
  'Warp': 'Launched on Warp and still on its bonding curve.',
  'Launchpad': 'Minted by a token-factory contract that has launched several Arc tokens.',
};

export const byLiq = (a: Token, b: Token) => (b.liq ?? -1) - (a.liq ?? -1);

export interface BoardIndex {
  pinned: Set<string>;
  canonical: Set<string>;
  tickerCount: Map<string, number>;
}

// Ticker impersonation: Arc has 100+ duplicate tickers (11 fake "USDC", etc.). For each ticker we keep the CANONICAL
// token; the rest are flagged as likely impersonators.
export function buildIndex(tokens: Token[], pinned: Set<string>): BoardIndex {
  const best = new Map<string, { addr: string; score: number }>();
  const count = new Map<string, number>();
  for (const t of tokens) {
    const s = (t.symbol || '').toUpperCase(); if (!s) continue;
    count.set(s, (count.get(s) || 0) + 1);
    // Ecosystem/core tokens (native USDC, Animus…) are always the real one for their ticker. Otherwise HOLDERS decide (an
    // impersonator has ~0 holders; the real token has thousands) — ranking by liquidity let a fake with a wash-traded pool
    // win. Liquidity is only the tiebreak. Pinned real tokens (by ADDRESS) always own their ticker — a fake "CRCL"
    // airdropped to 25,745 wallets outranked the real one.
    const score = (t.isEcosystem || pinned.has(t.address.toLowerCase()) ? 1e18 : 0) + (t.holders ?? 0) * 1e9 + (t.liq ?? 0);
    const cur = best.get(s);
    if (!cur || score > cur.score) best.set(s, { addr: t.address.toLowerCase(), score });
  }
  return { pinned, canonical: new Set([...best.values()].map((v) => v.addr)), tickerCount: count };
}

export const isActive = (ix: BoardIndex, t: Token) => t.isEcosystem || ix.pinned.has(t.address.toLowerCase()) || (t.volume24h ?? 0) >= MIN_VOL_24H;
// A non-canonical duplicate ticker, before the hard-rule flag is considered (the hero typeahead uses this one).
export const isDupTicker = (ix: BoardIndex, t: Token) => (ix.tickerCount.get((t.symbol || '').toUpperCase()) ?? 0) > 1 && !ix.canonical.has(t.address.toLowerCase());
// A duplicate ticker OR a row that failed the hard rules (sanitizeToken: impossible numbers, Circle impersonator) is hidden
// from the default screener, the dashboard and every total. Search still finds it, with the bad numbers blanked.
export const isDup = (ix: BoardIndex, t: Token) => !!(t as any).bad || isDupTicker(ix, t);
export const notDup = (ix: BoardIndex, t: Token) => !isDup(ix, t);
// A real project earns holders; core ecosystem assets are exempt.
export const hasHolders = (t: Token) => t.isEcosystem || (t.holders ?? 0) >= MIN_HOLDERS;
export const quality = (ix: BoardIndex, t: Token) => notDup(ix, t) && hasHolders(t) && isActive(ix, t);

export interface BoardQuery { filter: Filter; q: string; sort: SortKey; dir: Dir; hideDupes: boolean; showInactive: boolean }

export function boardRows(tokens: Token[], ix: BoardIndex, o: BoardQuery): Token[] {
  let r = tokens;
  if (o.filter === 'new') r = r.filter((t) => t.launchpad);
  else if (o.filter === 'eco') r = r.filter((t) => t.isEcosystem);
  const s = o.q.trim().toLowerCase();
  if (s) {
    r = r.filter((t) => t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s) || t.address.toLowerCase().includes(s));
    // ⛔ 10-05 (owner: "I type GLITCH and get 15 different GLITCH"): search used to show every exact-ticker copy (13 GLITCH,
    // 35 ARGUS) and sort them by liquidity, so a fake ARGUS with \$3.6M of pool and 40 holders came FIRST. Copies are hidden
    // like on the default board unless toggled; an address search always finds its token, copy or not.
    if (o.hideDupes && !s.startsWith('0x')) r = r.filter((t) => !isDup(ix, t));
    const rank = (t: Token) => {
      const sym = t.symbol.toLowerCase(), nm = t.name.toLowerCase();
      if (sym === s || t.address.toLowerCase() === s) return 0;
      if (sym.startsWith(s)) return 1;
      if (nm.startsWith(s)) return 2;
      return 3;
    };
    // Exact/prefix matches first; within a group the token that OWNS the ticker, then holders (a pool can be faked, thousands of
    // holders can't), then liquidity.
    const own = (t: Token) => (ix.canonical.has(t.address.toLowerCase()) ? 0 : 1);
    return [...r].sort((a, b) => (rank(a) - rank(b)) || (own(a) - own(b)) || ((b.holders ?? -1) - (a.holders ?? -1)) || ((b.liq ?? -1) - (a.liq ?? -1)));
  }
  // Default view: drop fully-dead tokens (no price/liq/holders/volume) and, unless toggled, impersonators.
  r = r.filter((t) => t.price != null || t.liq != null || (t.holders ?? 0) > 0 || t.volume24h != null);
  if (o.hideDupes) r = r.filter((t) => !isDup(ix, t));
  // Quality gate: hide sub-50-holder pools (KLO646 = 3, GLASSHOUSE = 12); unknown holder count = below the bar.
  r = r.filter(hasHolders);
  if (!o.showInactive) r = r.filter((t) => isActive(ix, t)); // no real trading in 24h = not on the default board
  const val = (t: Token): number | null => (
    o.sort === 'volume' ? t.volume24h
    : o.sort === 'change24h' ? t.change24h
    : o.sort === 'change1h' ? t.change1h
    : o.sort === 'age' ? t.createdAt
    : (t as any)[o.sort]) ?? null; // liq | mcap | holders | price
  return [...r].sort((a, b) => {
    if (o.sort === 'name') { const c = a.name.localeCompare(b.name); return o.dir === 'asc' ? c : -c; }
    const av = val(a), bv = val(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls last, regardless of direction
    if (bv == null) return -1;
    return o.dir === 'desc' ? bv - av : av - bv;
  });
}

export interface DashStats { count: number; vol24: number; newToday: number; tracked: number; tvl: number }
export function dashStats(tokens: Token[], ix: BoardIndex, now = Date.now()): DashStats {
  return {
    count: tokens.filter((t) => quality(ix, t)).length, // real, actively traded tokens — not every junk pool ever created
    // One token per ticker, quality bar only: 4-holder bot tokens washing $700K/day each had pushed the total to $27M.
    vol24: tokens.filter((t) => quality(ix, t)).reduce((s, t) => s + (t.volume24h ?? 0), 0),
    newToday: tokens.filter((t) => t.createdAt != null && now - t.createdAt < 86400000 && notDup(ix, t) && isActive(ix, t)).length,
    tracked: tokens.length, // every token the on-chain indexer reads (junk included) — what we TRACK
    // DEX liquidity on Arc: every real token's pools summed (no fakes/dups/flagged, 50+ holders or core), active or quiet.
    tvl: tokens.filter((t) => notDup(ix, t) && hasHolders(t)).reduce((s, t) => s + (t.liq ?? 0), 0),
  };
}

export const dupCount = (tokens: Token[], ix: BoardIndex) => tokens.filter((t) => isDup(ix, t)).length;
export const ecoCount = (tokens: Token[]) => tokens.filter((t) => t.isEcosystem).length;
export const launchpadCount = (tokens: Token[], ix: BoardIndex) => tokens.filter((t) => t.launchpad && quality(ix, t)).length;
export function launchpadLegend(tokens: Token[], ix: BoardIndex): { label: string; desc: string }[] {
  const n = new Map<string, number>();
  for (const t of tokens) if (t.launchpad && quality(ix, t)) n.set(t.launchpad, (n.get(t.launchpad) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([label, c]) => ({ label, desc: `${LP_DESC[label] || `Minted by the ${label} contract on Arc.`} ${c} active.` }));
}

// Home dashboard tabs. Impersonators are always dropped; Top Liquidity + Movers also need the quality bar; New keeps every
// fresh launch that trades (they're small by nature).
export const trending = (tokens: Token[], ix: BoardIndex) => [...tokens].filter((t) => t.liq != null && quality(ix, t)).sort(byLiq).slice(0, 8);
export const launches = (tokens: Token[], ix: BoardIndex) => [...tokens].filter((t) => t.launchpad && t.createdAt != null && notDup(ix, t) && isActive(ix, t))
  .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 8);
export const movers = (tokens: Token[], ix: BoardIndex) => [...tokens].filter((t) => t.change24h != null && t.liq != null && quality(ix, t))
  .sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0)).slice(0, 8);

// Swap token picker: one real token per ticker, no fakes/flagged rows. Pinned/core first, then actively traded by volume,
// then the rest by liquidity. Any other token is one paste of its address away.
export const swapTokens = (tokens: Token[], ix: BoardIndex) => tokens.filter((t) => !isDup(ix, t) && hasHolders(t)).sort((a, b) => {
  const rank = (t: Token) => (t.isEcosystem || ix.pinned.has(t.address.toLowerCase()) ? 2 : isActive(ix, t) ? 1 : 0);
  return rank(b) - rank(a) || (b.volume24h ?? 0) - (a.volume24h ?? 0) || (b.liq ?? 0) - (a.liq ?? 0);
});

// Hero typeahead: prefer the REAL token per ticker, rank exact > startsWith > contains, then by liquidity.
export function heroMatches(tokens: Token[], ix: BoardIndex, query: string, limit = 7): Token[] {
  const s = query.trim().toLowerCase(); if (s.length < 1) return [];
  if (s.startsWith('0x')) return tokens.filter((t) => t.address.toLowerCase().startsWith(s)).slice(0, limit);
  return tokens
    .filter((t) => !isDupTicker(ix, t))
    .map((t) => { const sym = (t.symbol || '').toLowerCase(), nm = (t.name || '').toLowerCase();
      const rank = sym === s ? 0 : sym.startsWith(s) ? 1 : nm.startsWith(s) ? 2 : (sym.includes(s) || nm.includes(s)) ? 3 : -1; return { t, rank }; })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (b.t.holders ?? 0) - (a.t.holders ?? 0) || (b.t.liq ?? 0) - (a.t.liq ?? 0)) // holders first: liquidity is fakeable
    .slice(0, limit).map((x) => x.t);
}
