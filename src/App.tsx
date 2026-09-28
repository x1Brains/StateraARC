import { useEffect, useMemo, useRef, useState } from 'react';
import * as Board from './lib/board';
import * as Live from './lib/live';
import { v2Enabled, v2Home, v2Board, v2Search, v2Token, v2SwapTokens, v2List, v2Chain, v2Lending, type V2Home, type V2Board } from './lib/v2';
import type { Filter, SortKey } from './lib/board';
import { fetchScreenerTokens, fetchRadarTokens, fetchDeepPoolPrices, fetchMarket, fetchCuratedV4Tokens, fetchOnchainScreenerPrices, fmt, price, tprice, usd, connectWallet, shareStamp, PINNED, type Token, type MarketPx } from './lib/arc';
import { TokenLogo } from './components/TokenLogo';
import { Sparkline } from './components/Sparkline';
import { Portfolio } from './components/Portfolio';
import { Swap } from './components/Swap';
import { Dropdown } from './components/Dropdown';
import { PremainDetail } from './components/PremainDetail';
import { Network } from './components/Network';
import { ArcLive } from './components/ArcLive';
import { TokenPage } from './components/TokenPage';
import { Disclaimer, disclaimerAcked } from './components/Disclaimer';
import { VisitCounter } from './components/VisitCounter';
import { WalletButton } from './components/WalletButton';
import { IconArrowRight, IconArrowLeft, IconX } from './components/icons';

type Page = 'home' | 'screener' | 'network' | 'portfolio' | 'swap' | 'token';

// ── deep-linkable URLs (clean path routing, e.g. stateraarc.com/swap). Vercel serves index.html for
//    any non-file/non-/api path (SPA fallback rewrite in vercel.json), so refresh/direct-load work. ──
const PATHS: Record<Page, string> = { home: '/', screener: '/screener', network: '/network', token: '/str', portfolio: '/portfolio', swap: '/swap' };
const pathFor = (pg: Page, sel: string | null): string =>
  pg === 'screener' && sel && /^0x[0-9a-fA-F]{40}$/.test(sel) ? `/token/${sel}` : (PATHS[pg] || '/');
function parsePath(): { page: Page; selected: string | null } {
  const h = ((window.location.pathname || '/').toLowerCase().replace(/\/+$/, '')) || '/';
  const m = h.match(/^\/token\/(0x[0-9a-f]{40})/);
  if (m) return { page: 'screener', selected: m[1] };
  const found = (Object.keys(PATHS) as Page[]).find((k) => PATHS[k] === h);
  return { page: found || 'home', selected: null };
}

const NAV: { key: Page; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'screener', label: 'Screener' },
  { key: 'network', label: 'Network' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'swap', label: 'Swap' },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'Launchpad' },
  { key: 'eco', label: 'Ecosystem' },
];
const PER_PAGE_OPTS = [50, 100, 250, 500];
// "updated Xm ago" from a snapshot timestamp (ms).
function agoStr(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

// Screener cell formatters
const chgCls = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const chgFmt = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`);
// Confidence score (0-100) from on-chain signals — weighted, only over the signals we actually have.
const confScore = (t: Token): number | null => {
  const parts: [number, number][] = []; // [value 0..1, weight]
  if (t.liq != null && t.mcap && t.mcap > 0) parts.push([Math.min(1, (t.liq / t.mcap) / 0.1), 35]);   // depth ≥10% of mcap = full
  if (t.liq != null) parts.push([Math.min(1, t.liq / 50000), 15]);                                      // $50k+ absolute depth
  if (t.holders != null) parts.push([Math.min(1, t.holders / 500), 30]);                                // 500+ holders
  if (t.change24h != null) parts.push([Math.max(0, 1 - Math.min(1, Math.abs(t.change24h) / 100)), 20]);  // calmer = healthier
  if (!parts.length) return null;
  const s = parts.reduce((a, [v, w]) => a + v * w, 0), w = parts.reduce((a, [, w]) => a + w, 0);
  return Math.round((s / w) * 100);
};
const ageStr = (ms: number | null | undefined) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo`;
  return `${(s / 31536000).toFixed(1)}y`;
};

// Legend for the launchpad tags. ⛔ 09-26: tags now come from the contract that CREATED each token (snapshot builder,
// tagLaunchpads) — the old list here (Memepad / LP factory / Launcher / Curve factory) was testnet addresses that match
// nothing on mainnet. The legend lists only tags that actually appear in the current list.

export default function App() {
  const [acked, setAcked] = useState<boolean>(() => disclaimerAcked());
  const [page, setPage] = useState<Page>(() => parsePath().page);
  const [swapPreload, setSwapPreload] = useState<{ address: string; symbol: string; name?: string; price?: number | null } | null>(null);
  const tradeToken = (t: { address: string; symbol: string; name?: string; price?: number | null }) => { setSwapPreload({ address: t.address, symbol: t.symbol, name: t.name, price: t.price }); setPage('swap'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const [tokens, setTokens] = useState<Token[]>([]);
  const [asOf, setAsOf] = useState<number | null>(null); // snapshot freshness
  const [market, setMarket] = useState<MarketPx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('liq');
  const [dir, setDir] = useState<'desc' | 'asc'>('desc');
  const [hideDupes, setHideDupes] = useState(true); // hide counterfeit/duplicate-ticker impersonators
  // The board's rules (thresholds, dup/quality gates, sorting, stats) live in src/lib/board.ts — shared with the VPS API.
  const [showInactive, setShowInactive] = useState(false);
  const [dashTab, setDashTab] = useState<'liq' | 'new' | 'movers'>('liq'); // home dashboard tab
  // Click a column header to sort by it; click again to flip direction (name defaults A→Z, numbers high→low).
  const clickSort = (k: SortKey) => {
    if (sort === k) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSort(k); setDir(k === 'name' ? 'asc' : 'desc'); }
  };
  // Sortable column header (click to sort, arrow shows active key + direction).
  const th = (k: SortKey, label: string) => (
    <span className={`num sortable${sort === k ? ' hot' : ''}`} onClick={() => clickSort(k)}>
      {label}{sort === k ? (dir === 'desc' ? ' ▾' : ' ▴') : ''}
    </span>
  );
  // Quick views = sort presets (independent of the all/new/eco subset filter).
  const setView = (s: SortKey, d: 'desc' | 'asc') => { setSort(s); setDir(d); };
  const activeView = sort === 'volume' && dir === 'desc' ? 'trending'
    : sort === 'change24h' && dir === 'desc' ? 'gainers'
    : sort === 'change24h' && dir === 'asc' ? 'losers' : '';
  const [pageNum, setPageNum] = useState(1);
  const [perPage, setPerPage] = useState(() => (typeof window !== 'undefined' && window.innerWidth <= 640 ? 50 : 100));
  const [selected, setSelected] = useState<string | null>(() => parsePath().selected);
  const [wallet, setWallet] = useState<string | null>(null);
  const onConnect = async () => { try { const a = await connectWallet(); if (a) setWallet(a); } catch {} };
  const onDisconnect = () => setWallet(null);
  const onSwitch = async () => {
    try {
      const eth = (window as any).ethereum;
      await eth?.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
      const a = await connectWallet(); if (a) setWallet(a);
    } catch {}
  };
  // Cinematic hero: one of the four lava scenes, chosen at random on each fresh load.
  const [heroVariant] = useState<number>(() => 1 + Math.floor(Math.random() * 4));

  // ── DATA: v2 (default) = the VPS API computes the board once for every visitor (server/statera-api.ts): the home page
  // reads ~10 KB, a screener page ~1 KB per 100 rows, and the browser makes no RPC calls for the lists. v1 = the old path
  // (the whole 1.14 MB list every 60 s + in-browser re-pricing), kept intact: ANY v2 failure drops this tab to v1 for good,
  // and ?data=v1 forces it (to compare). Same rules either way — src/lib/board.ts runs on both sides.
  const [mode, setMode] = useState<'v2' | 'v1'>(v2Enabled ? 'v2' : 'v1');
  const v2 = mode === 'v2';
  const [home, setHome] = useState<V2Home | null>(null);
  const [board, setBoard] = useState<V2Board | null>(null);
  const [swapList, setSwapList] = useState<Token[]>([]);
  // Hero: Arc-wide numbers from the Network page's data (money on Arc, lent, tx/s), refreshed every 30 s on the home page.
  const [netHero, setNetHero] = useState<{ money: number | null; lent: number | null; tps: number | null } | null>(null);
  useEffect(() => {
    if (page !== 'home') return;
    let alive = true;
    const load = () => Promise.all([v2Chain().catch(() => null), v2Lending().catch(() => null)]).then(([c, l]) => {
      if (!alive || (!c && !l)) return;
      const money = c?.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((a, k) => a + (c.supplyUsd?.[k] ?? 0), 0) : null;
      const lent = l ? l.aave.supplyUsd + (l.morpho.complete ? l.morpho.supplyUsd : 0) : null;
      setNetHero({ money, lent, tps: c?.m5?.tps ?? null });
    });
    load(); const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [page]);
  const fallBack = (why: unknown) => { console.warn('[statera] v2 data unavailable, using v1:', (why as any)?.message || why); setMode('v1'); };

  // v1: StateraArc is mainnet-only (Arc chain 5042). Tokens = the VPS indexer snapshot, re-priced live in the tab.
  async function loadV1(silent = false) {
    if (!silent) setLoading(true);
    setErr(null);
    try {
      const { tokens: list, asOf: ts } = await fetchScreenerTokens();
      setTokens(list); setAsOf(ts);
      // Merge curated V4 launchpad tokens (GLITCH etc.) that no aggregator indexes, so they're listed &
      // searchable now — priced on-chain. (Full chain-wide V4 discovery bake is the proper fix.)
      fetchCuratedV4Tokens().then((extra) => { if (extra.length) setTokens((prev) => Live.mergeCurated(prev, extra)); }).catch(() => {});
      // Live re-price the top ON-CHAIN rows (V3 slot0 / V4 extsload) so what's visible isn't ~15 min stale
      // between indexer bakes. RadarDEX rows get their own live overlay below.
      const ocTop = Live.topOnchainRows(list);
      if (ocTop.length) fetchOnchainScreenerPrices(ocTop).then((px) => { if (Object.keys(px).length) setTokens((prev) => Live.applyOnchainPrices(prev, px)); }).catch(() => {});
      // ⛔ REMOVED (09-24): the old "safety net" sampled only the last ~90 min of swaps and multiplied by ~15.6 for any
      // row whose volume was blank — cirBTC came out $1.98M vs $1.08M real 24h, so the dashboard total flipped
      // $6.1M <-> $8.2M from reload to reload. The on-chain builder's full-24h volume is the only volume shown now.
    } catch (e: any) { if (!silent) setErr(e.message || 'failed to load'); }
    finally { if (!silent) setLoading(false); }
  }
  // v1 LIVE FEED: the snapshot gives the full list instantly; then fresh RadarDEX price/change/volume/liq (via the relay)
  // every ~40s, merged in place by address; deep pools get their on-chain slot0 price.
  const refreshLive = async () => {
    try {
      // RadarDEX (~500 active tokens) + on-chain slot0 prices for the deep pools RadarDEX doesn't list.
      const [live, deep] = await Promise.all([fetchRadarTokens(500).catch(() => [] as Token[]), fetchDeepPoolPrices().catch(() => ({} as Record<string, number>))]);
      if (!live.length && !Object.keys(deep).length) return;
      setTokens((prev) => Live.applyLiveOverlay(prev, live, deep)); // on-chain primary; RadarDEX fills gaps (src/lib/live.ts)
      setAsOf(Date.now());
    } catch { /* keep snapshot values */ }
  };
  async function loadV2(silent = false) {
    if (!silent) setLoading(true);
    try { const h = await v2Home(); setHome(h); setAsOf(h.asOf); setErr(null); }
    catch (e) { fallBack(e); }
    finally { if (!silent) setLoading(false); }
  }
  const load = (silent = false) => { fetchMarket().then(setMarket).catch(() => {}); return mode === 'v2' ? loadV2(silent) : loadV1(silent); };
  useEffect(() => {
    load();
    if (mode === 'v1') {
      const a = setInterval(refreshLive, 40000); refreshLive();
      const b = setInterval(() => load(true), 60000); // silently refresh prices/mcap/liquidity (no loading flicker)
      return () => { clearInterval(a); clearInterval(b); };
    }
    // v2: the server re-prices every 40-60 s; the tab just re-reads the small summary.
    const c = setInterval(() => loadV2(true), 20000);
    const d = setInterval(() => fetchMarket().then(setMarket).catch(() => {}), 60000);
    return () => { clearInterval(c); clearInterval(d); };
  }, [mode]); // eslint-disable-line

  // v2 screener page: the server filters/sorts/paginates; a sequence number drops stale answers (fast typing, paging).
  const boardSeq = useRef(0);
  const onScreener = page === 'screener' && !selected;
  useEffect(() => {
    if (!v2 || !onScreener) return;
    const fetchPage = () => {
      const seq = ++boardSeq.current;
      v2Board({ filter, q, sort, dir, hideDupes, showInactive, page: pageNum, per: perPage })
        .then((b) => { if (seq === boardSeq.current) { setBoard(b); if (b.asOf) setAsOf(b.asOf); } })
        .catch((e) => { if (seq === boardSeq.current) fallBack(e); });
    };
    const t = setTimeout(fetchPage, q ? 250 : 0); // debounce typing
    const id = setInterval(fetchPage, 20000);
    return () => { clearTimeout(t); clearInterval(id); };
  }, [v2, onScreener, filter, q, sort, dir, hideDupes, showInactive, pageNum, perPage]); // eslint-disable-line
  // v2 swap picker + portfolio pricing: fetched when those pages open.
  useEffect(() => { if (v2 && page === 'swap') v2SwapTokens().then(setSwapList).catch(fallBack); }, [v2, page]); // eslint-disable-line
  useEffect(() => { if (v2 && page === 'portfolio' && !tokens.length) v2List().then((l) => setTokens(l.tokens)).catch(fallBack); }, [v2, page]); // eslint-disable-line
  // v2 token page: its screener row (carries the pool keys so the page skips pool discovery).
  const [seedRow, setSeedRow] = useState<{ addr: string; row: Token | null } | null>(null);
  useEffect(() => {
    if (!v2 || !selected) return;
    const a = selected.toLowerCase(); let alive = true;
    v2Token(a).then((row) => { if (alive) setSeedRow({ addr: a, row }); }).catch((e) => { if (alive) { setSeedRow({ addr: a, row: null }); fallBack(e); } });
    return () => { alive = false; };
  }, [v2, selected]); // eslint-disable-line

  // Everything below is src/lib/board.ts (A/B-proven identical to the v1 inline code: scripts/regress/board-ab.ts) —
  // computed here in v1, read from the server (same code) in v2.
  const ix = useMemo(() => Board.buildIndex(tokens, PINNED), [tokens]);
  const rowsV1 = useMemo(() => (v2 ? [] : Board.boardRows(tokens, ix, { filter, q, sort, dir, hideDupes, showInactive })), [v2, tokens, ix, filter, q, sort, dir, hideDupes, showInactive]);

  useEffect(() => { setPageNum(1); }, [filter, q, sort, dir, perPage, hideDupes]);
  const rowsTotal = v2 ? (board?.total ?? 0) : rowsV1.length;
  const totalPages = v2 ? Math.max(1, board?.pages ?? 1) : Math.max(1, Math.ceil(rowsV1.length / perPage));
  const pageRows = v2 ? (board?.rows ?? []) : rowsV1.slice((pageNum - 1) * perPage, pageNum * perPage);

  const v1 = useMemo(() => (v2 ? null : {
    dupCount: Board.dupCount(tokens, ix), ecoCount: Board.ecoCount(tokens), launchpadCount: Board.launchpadCount(tokens, ix),
    launchpadLegend: Board.launchpadLegend(tokens, ix), trending: Board.trending(tokens, ix), launches: Board.launches(tokens, ix),
    movers: Board.movers(tokens, ix), dashStats: Board.dashStats(tokens, ix),
  }), [v2, tokens, ix]);
  const NO_STATS: Board.DashStats = { count: 0, vol24: 0, newToday: 0, tracked: 0, tvl: 0 };
  const dupCount = v1 ? v1.dupCount : home?.counts.dup ?? 0;
  const ecoCount = v1 ? v1.ecoCount : home?.counts.eco ?? 0;
  const launchpadCount = v1 ? v1.launchpadCount : home?.counts.launchpad ?? 0;
  const launchpadLegend = v1 ? v1.launchpadLegend : home?.legend ?? [];
  const trending = v1 ? v1.trending : home?.trending ?? [];
  const launches = v1 ? v1.launches : home?.launches ?? [];
  const movers = v1 ? v1.movers : home?.movers ?? [];
  const dashStats = v1 ? v1.dashStats : home?.stats ?? NO_STATS;
  const swapTokens = useMemo(() => (v2 ? swapList : Board.swapTokens(tokens, ix)), [v2, swapList, tokens, ix]);
  const seed = v2 ? (seedRow && seedRow.addr === (selected || '').toLowerCase() ? seedRow.row ?? undefined : undefined)
    : tokens.find((t) => t.address.toLowerCase() === (selected || '').toLowerCase());
  const seedReady = v2 ? (!!seedRow && seedRow.addr === (selected || '').toLowerCase()) || !!err : tokens.length > 0 || !!err;

  const go = (p: Page) => { setPage(p); setSelected(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const openToken = (addr: string) => { setSelected(addr); setPage('screener'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const goScreener = (f: Filter = 'all') => { setFilter(f); setSort('liq'); setPage('screener'); setSelected(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  // Hero "search any token": a contract address opens that token page directly (works for ANY token,
  // even ones not in our list — e.g. V4 launchpad coins). A ticker/name jumps to the best match, else
  // opens the screener pre-filtered so they can pick it.
  const [heroQ, setHeroQ] = useState('');
  const [heroFocus, setHeroFocus] = useState(false);
  // Live typeahead: match the query against ticker/name (or address), prefer the REAL token per ticker,
  // rank exact > startsWith > contains, then by liquidity. Shows logo + price in the dropdown.
  const [heroV2, setHeroV2] = useState<{ q: string; rows: Token[] }>({ q: '', rows: [] });
  useEffect(() => {
    if (!v2) return;
    const s = heroQ.trim(); if (!s) { setHeroV2({ q: '', rows: [] }); return; }
    const t = setTimeout(() => v2Search(s).then((rows) => setHeroV2({ q: heroQ, rows })).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [v2, heroQ]);
  const heroMatches = useMemo(() => (v2 ? (heroQ.trim() ? heroV2.rows : []) : Board.heroMatches(tokens, ix, heroQ)), [v2, heroV2, heroQ, tokens, ix]);
  const heroSearch = () => {
    const s = heroQ.trim();
    if (!s) return;
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) { openToken(s.toLowerCase()); return; }
    const low = s.toLowerCase();
    const pool = v2 ? heroMatches : tokens; // v2: the server's ranked matches (real token per ticker first)
    const hit = pool.find((t) => (t.symbol || '').toLowerCase() === low)
      || pool.find((t) => (t.symbol || '').toLowerCase().startsWith(low) || (t.name || '').toLowerCase().startsWith(low));
    if (hit) { openToken(hit.address); return; }
    setQ(s); goScreener('all');
  };

  // URL <-> state: back/forward + direct-load sync, and push a shareable clean path on navigation.
  useEffect(() => {
    const apply = () => { const s = parsePath(); setPage(s.page); setSelected(s.selected); };
    window.addEventListener('popstate', apply);
    return () => { window.removeEventListener('popstate', apply); };
  }, []);
  // Tab title for every non-token page (a token page sets its own, live — PremainDetail). Without this, leaving a token
  // page kept that token's name + price in the browser tab.
  useEffect(() => {
    if (page === 'screener' && selected) return;
    const T: Record<Page, string> = { home: 'StateraArc — Arc token screener', screener: 'Screener — StateraArc', network: 'Arc Network — StateraArc', portfolio: 'Portfolio — StateraArc', swap: 'Swap — StateraArc', token: '$STR — StateraArc' };
    document.title = T[page] || T.home;
  }, [page, selected]);
  const navReady = useRef(false);
  useEffect(() => {
    const path = pathFor(page, selected);
    const cur = window.location.pathname.replace(/\/+$/, '') || '/';
    // ⛔ X caches a link's card against the EXACT url in the post, for days, and nothing server-side can refresh it
    // (owner 09-25: an ARGUS link unfurled at a days-old $0.0170; the emoji site learned the same — "a URL is burned by
    // its first crawl"). So a token page's address bar carries a fresh ?v= stamp: a url copied from the browser is one
    // X has never seen, and it crawls the live card. The router reads only the path; og:url stays the clean path.
    // ⛔ 09-26 (owner: "Post to X works, but a link copied from the browser didn't"): the stamp was set ONCE when the
    // page opened and then kept (reloads kept the old ?v= too) — so a link copied later was one X had already crawled
    // (possibly while that card was failing) and X served its cached, imageless card. Now every load gets a fresh
    // stamp, and the effect below keeps re-stamping the address bar, so what you copy is always ≤ 1 minute old.
    const isTok = path.startsWith('/token/');
    if (cur === path && !isTok) { navReady.current = true; return; }
    const want = isTok ? `${path}?v=${shareStamp()}` : path;
    if (navReady.current && cur !== path) window.history.pushState(null, '', want);
    else { window.history.replaceState(null, '', want); navReady.current = true; }
  }, [page, selected]);
  // Keep a token page's address-bar link fresh: re-stamp every minute and whenever the tab comes back into view.
  useEffect(() => {
    const path = pathFor(page, selected);
    if (!path.startsWith('/token/')) return;
    const restamp = () => {
      if ((window.location.pathname.replace(/\/+$/, '') || '/') !== path) return;
      const want = `${path}?v=${shareStamp()}`;
      if (window.location.pathname + window.location.search !== want) window.history.replaceState(window.history.state, '', want);
    };
    const id = window.setInterval(restamp, 60000);
    const onVis = () => { if (document.visibilityState === 'visible') restamp(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', restamp);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', restamp); };
  }, [page, selected]);

  return (
    <>
      {!acked && <Disclaimer onAccept={() => setAcked(true)} />}
      <div className="backdrop" />
      <div className="shell">
        {/* ticker — scrolling marquee */}
        <div className="ticker">
          <div className="tk-track">
            {[0, 1].map((dup) => (
              <div className="tk-seg" key={dup} aria-hidden={dup === 1}>
                {market.map((m) => (
                  <span className="t" key={m.sym + dup}>
                    {m.logo && <img className="tk-logo" src={m.logo} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
                    <span className="s">{m.sym}</span><span className="p">{price(m.price)}</span>
                  </span>
                ))}
                <span className="t arc"><span className="s">ARC</span><span className="p">GAS = USDC</span></span>
              </div>
            ))}
          </div>
        </div>

        {/* nav */}
        <div className="nav"><div className="wrap">
          <div className="logo" onClick={() => go('home')}>
            <img className="nav-logo" src="/statera-lockup.png" alt="StateraArc" />
          </div>
          <div className="nav-links">
            {NAV.map((n) => <button key={n.key} className={page === n.key ? 'on' : ''} onClick={() => go(n.key)}>{n.label}</button>)}
          </div>
          <div className="spacer" />
          <VisitCounter />
          <a className="nav-x" href="https://x.com/StateraArc" target="_blank" rel="noreferrer" title="StateraArc on X" aria-label="StateraArc on X"><IconX /></a>
          <span className="net-live" role="status" aria-label="Arc Mainnet"><span className="dot" /> Arc Mainnet</span>
          {(page === 'swap' || page === 'portfolio') && <WalletButton wallet={wallet} onConnect={onConnect} onDisconnect={onDisconnect} onSwitch={onSwitch} />}
        </div></div>

        {/* ============ HOME ============ */}
        {page === 'home' && (
          <>
            <section className="hero">
              <div className="hero-bg"><img src={`/hero-lava-${heroVariant}.jpg`} alt="Statera" /></div>
              <div className="wrap">
                <div className="hero-copy">
                  <span className="eyebrow"><span className="dot" /> Arc Hub · Web3 GameFi</span>
                  <h1>Track any <span className="r">launch</span><br />on Arc.</h1>
                  <p className="lede">The Statera hub for Circle's Arc chain — screener, live network stats, portfolio &amp; swap. And the studio building <span className="r">X1 City</span>: web3 <span className="r">GameFi</span> in Unreal Engine 5 — the first EVM-SVM game on Arc.</p>
                  <div className="hero-cta">
                    <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <IconArrowRight className="arw" /></button>
                    <button className="btn ghost" onClick={() => go('network')}>Arc Network</button>
                    <button className="btn ghost" onClick={() => goScreener('new')}>New Launches</button>
                  </div>
                  <form className="hero-search" onSubmit={(e) => { e.preventDefault(); heroSearch(); }}>
                    <div className="hs-wrap">
                      <input className="hs-in" value={heroQ} onChange={(e) => setHeroQ(e.target.value)}
                        onFocus={() => setHeroFocus(true)} onBlur={() => setTimeout(() => setHeroFocus(false), 150)}
                        placeholder="Search any token — ticker or contract address" aria-label="Search any token" spellCheck={false} autoComplete="off" />
                      {heroFocus && heroMatches.length > 0 && (
                        <div className="hs-drop">
                          {heroMatches.map((t) => (
                            <button type="button" className="hs-opt" key={t.address} onMouseDown={(e) => { e.preventDefault(); setHeroQ(''); openToken(t.address.toLowerCase()); }}>
                              <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
                              <span className="hs-opt-sym">{t.symbol}</span>
                              <span className="hs-opt-nm">{t.name}</span>
                              <span className="hs-opt-px">{t.price != null ? tprice(t.price) : '—'}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button type="submit" className="hs-go" aria-label="Search">Search <IconArrowRight className="arw" /></button>
                  </form>
                  <div className="hero-trust">
                    {/* Arc itself (the Network page's numbers) + the token market — owner 09-28: "update the new network page and stats in the hero" */}
                    <div className="ht ht-link" onClick={() => go('network')} title="Circle assets on Arc — see the Network page"><b className="r">{netHero?.money ? usd(netHero.money) : '—'}</b><span>Money on Arc</span></div>
                    <div className="div" />
                    <div className="ht ht-link" onClick={() => go('network')} title="Lent on Morpho + Aave"><b>{netHero?.lent ? usd(netHero.lent) : '—'}</b><span>Lent</span></div>
                    <div className="div" />
                    <div className="ht"><b>{dashStats.tvl > 0 ? usd(dashStats.tvl) : '—'}</b><span>DEX Liquidity</span></div>
                    <div className="div" />
                    <div className="ht"><b>{dashStats.vol24 > 0 ? usd(dashStats.vol24) : '—'}</b><span>24h Volume</span></div>
                    <div className="div" />
                    <div className="ht"><b>{dashStats.tracked ? dashStats.tracked.toLocaleString() : '—'}</b><span>Tokens Tracked</span></div>
                    <div className="div" />
                    <div className="ht ht-link" onClick={() => go('network')} title="Transactions per second, last 5 minutes"><b>{netHero?.tps != null ? `${Math.round(netHero.tps)}/s` : '—'}</b><span><span className="live-dot" /> Live TX</span></div>
                  </div>
                </div>
              </div>
            </section>

            <div className="wrap"><section className="section home">
              <Dashboard tab={dashTab} setTab={setDashTab}
                data={{ liq: trending, new: launches, movers }} stats={dashStats}
                onOpen={openToken} onAll={() => goScreener(dashTab === 'new' ? 'new' : 'all')} loading={loading} />

              {/* Arc itself — compact Network page (money on Arc, lending, bridge, validators), same live feeds */}
              <ArcLive onOpen={() => go('network')} />

              <div className="home-cta">
                <div>
                  <div className="kicker">The full board</div>
                  <h2>Every token on Arc, ranked.</h2>
                  <p>Sort {dashStats.tracked || 500}+ tokens by liquidity or market cap, filter launchpads &amp; ecosystem, and dive into per-token trades, holders &amp; pools.</p>
                </div>
                <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <IconArrowRight className="arw" /></button>
              </div>
            </section></div>

            {/* ── Unreal Engine 5 · X1 City showpiece — under the dashboard (our biggest marketing) ── */}
            <section className="ue5">
              <div className="ue5-bg"><img src="/hero-lava-3.jpg" alt="" /></div>
              <div className="wrap ue5-inner">
                <div className="ue5-badge"><span className="ue5-dot" /> Unreal Engine 5 · Web3 GameFi · In development</div>
                <h2 className="ue5-h">We’re building <span className="r">X1 City</span> — the first <span className="r">EVM-SVM</span> game.</h2>
                <p className="ue5-sub">A full open world in <b>Unreal Engine 5</b>, bridging Circle’s Arc (EVM) with X1 (SVM) in web3 gaming — the first to connect both. <b>$STR</b> is the token tied into X1 City — more than a chart, it’s your link to the world we’re building.</p>
                <div className="ue5-feats">
                  <div className="ue5-feat"><b>Open World</b><span>An explorable UE5 city</span></div>
                  <div className="ue5-feat"><b className="r">EVM-SVM</b><span>First to bridge both</span></div>
                  <div className="ue5-feat"><b>Web3 GameFi</b><span>An on-chain economy</span></div>
                </div>
                <div className="ue5-actions">
                  <a className="btn solid" href="https://x1city.io" target="_blank" rel="noreferrer">Explore X1 City <IconArrowRight className="arw" /></a>
                  <button className="btn ghost" onClick={() => go('token')}>The $STR token</button>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ============ SCREENER ============ */}
        {page === 'screener' && selected && (
          <PremainDetail
            address={selected}
            seed={seed}
            ready={seedReady}
            wallet={wallet}
            onConnect={onConnect}
            onBack={() => setSelected(null)}
            onTrade={(t) => tradeToken(t)}
          />
        )}

        {page === 'screener' && !selected && (
          <div className="wrap"><section className="section" id="screener">
            <div className="section-head">
              <div>
                <div className="kicker">Screener</div>
                <h2>Arc Tokens</h2>
                <p>Live prices, liquidity &amp; market cap from Arc mainnet pools (chain 5042) — WarpV2, Uniswap V3/V4 and Warp launchpad tokens. Click a token for its chart, holders &amp; trades.</p>
              </div>
              <button className="btn ghost" onClick={() => load()} disabled={loading} style={{ opacity: loading ? .5 : 1 }}>{loading ? 'Loading' : 'Refresh'}</button>
            </div>

            <div className="stats">
              <div className="stat"><div className="v">{dashStats.tracked ? dashStats.tracked.toLocaleString() : '—'}</div><div className="l">Tokens Tracked</div></div>
              <div className="stat" title="Tokens with $50+ of trading in the last 24h"><div className="v">{dashStats.count || '—'}</div><div className="l">Active 24h</div></div>
              <div className="stat"><div className="v">{dashStats.tvl > 0 ? usd(dashStats.tvl) : '—'}</div><div className="l">DEX Liquidity</div></div>
              <div className="stat"><div className="v">{dashStats.vol24 > 0 ? usd(dashStats.vol24) : '—'}</div><div className="l">24h Volume</div></div>
              <div className="stat"><div className="v">{dashStats.newToday || '—'}</div><div className="l">New Today</div></div>
              <div className="stat"><div className="v">{launchpadCount || '—'}</div><div className="l">Launchpad Tokens</div></div>
              <div className="stat"><div className="v">{ecoCount || '—'}</div><div className="l">Ecosystem</div></div>
              <div className="stat"><div className="v r">LIVE</div><div className="l">Mainnet · 5042</div></div>
            </div>

            <div className="controls">
              <div className="tabs">
                {FILTERS.map((f) => <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>)}
                <span className="tab-sep" />
                <button className={activeView === 'trending' ? 'on' : ''} onClick={() => setView('volume', 'desc')}>Trending</button>
                <button className={activeView === 'gainers' ? 'on' : ''} onClick={() => setView('change24h', 'desc')}>Gainers</button>
                <button className={activeView === 'losers' ? 'on' : ''} onClick={() => setView('change24h', 'asc')}>Losers</button>
              </div>
              <input className="search" placeholder="Search name, symbol, or address" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="sortby">
                <span className="sortby-l">Sort</span>
                <Dropdown value={sort} onChange={(v) => { setSort(v); setDir(v === 'name' ? 'asc' : 'desc'); }} align="right" options={[
                  { value: 'liq', label: 'Liquidity' },
                  { value: 'volume', label: 'Volume 24h' },
                  { value: 'change24h', label: '24h Change' },
                  { value: 'change1h', label: '1h Change' },
                  { value: 'mcap', label: 'Market Cap' },
                  { value: 'holders', label: 'Holders' },
                  { value: 'price', label: 'Price' },
                  { value: 'age', label: 'Newest' },
                  { value: 'name', label: 'Name' },
                ]} />
              </div>
              {!q.trim() && (
                <button className={`dupe-toggle${showInactive ? ' on' : ''}`} onClick={() => setShowInactive((v) => !v)}
                  title="Tokens with under $50 of trading in 24h — mostly dead or airdrop-spam pools">
                  {showInactive ? 'Hide inactive' : 'Show inactive'}
                </button>
              )}
              {dupCount > 0 && !q.trim() && (
                <button className={`dupe-toggle${hideDupes ? '' : ' on'}`} onClick={() => setHideDupes((v) => !v)}
                  title="Duplicate tickers on Arc are usually impersonators — only the most-liquid one is shown">
                  {hideDupes ? `Show ${dupCount} duplicate tickers` : 'Hide duplicate tickers'}
                </button>
              )}
              {asOf && (Date.now() - asOf < 90000
                ? <span className="asof live" title="Prices refresh live every ~40s"><span className="live-dot" /> Live</span>
                : <span className="asof" title="Live prices refresh every ~40s">Updated {agoStr(asOf)}</span>)}
            </div>

            {err && <div className="msg err">Error: {err}</div>}
            {loading && !pageRows.length && <div className="msg">Loading Arc tokens…</div>}

            {!!pageRows.length && (
              <div className="table-scroll">
              <div className="table wide">
                <div className="trow head sc">
                  <span>#</span><span /><span>Token</span>
                  {th('price', 'Price')}
                  {th('change1h', '1h')}
                  {th('change24h', '24h')}
                  {th('volume', 'Vol 24h')}
                  {th('mcap', 'Market Cap')}
                  {th('liq', 'Liquidity')}
                  {th('holders', 'Holders')}
                  {th('age', 'Age')}
                  <span className="num">Last 24h</span>
                  <span>Tags</span>
                </div>
                {pageRows.map((t, i) => (
                  <div className="trow tok sc" key={t.address} onClick={() => setSelected(t.address)}>
                    <span className="rank">{(pageNum - 1) * perPage + i + 1}</span>
                    <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
                    <span className="sc-name"><div className="tname">{t.name}</div><div className="tsym">{t.symbol}{(t.source || t.launchpad) && <span className="tsrc">{t.source || t.launchpad}</span>}</div></span>
                    <span className="num" data-l="Price">{tprice(t.price)}</span>
                    <span className={`num chg ${chgCls(t.change1h)}`} data-l="1h">{chgFmt(t.change1h)}</span>
                    <span className={`num chg ${chgCls(t.change24h)}`} data-l="24h">{chgFmt(t.change24h)}</span>
                    <span className="num" data-l="Vol 24h">{t.volume24h == null ? '—' : usd(t.volume24h)}{t.txns24 != null && <small className="sub">{fmt(t.txns24)} txns</small>}</span>
                    <span className={`num${sort === 'mcap' ? ' hot' : ''}`} data-l="Market Cap">{t.mcap == null ? '—' : usd(t.mcap)}{t.fdv != null && t.fdv !== t.mcap && <small className="sub">FDV {usd(t.fdv)}</small>}</span>
                    <span className={`num${sort === 'liq' ? ' hot' : ''}`} data-l="Liquidity">{t.liq == null ? '—' : usd(t.liq)}</span>
                    <span className="num" data-l="Holders">{fmt(t.holders)}</span>
                    <span className="num age" data-l="Age">{ageStr(t.createdAt)}</span>
                    <span className="num spark-cell" data-l="Last 24h"><Sparkline data={t.spark} price={t.price} change24h={t.change24h} /></span>
                    <span className="flags">
                      {(() => { const c = confScore(t); return c != null ? <span className={`badge conf ${c >= 70 ? 'good' : c >= 40 ? 'mid' : 'bad'}`} title="Confidence — liquidity depth, holders, stability">{c}</span> : null; })()}
                      {t.launchpad && <span className="badge b-lp" title={t.launchpad}>{t.launchpad}</span>}
                      {t.isEcosystem && <span className="badge b-gray">ECO</span>}
                    </span>
                  </div>
                ))}
              </div>
              </div>
            )}
            {!loading && (v2 ? !!board : !!tokens.length) && !rowsTotal && (
              /^0x[0-9a-fA-F]{40}$/.test(q.trim())
                ? <div className="msg" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <span>Not in the indexed list — open it directly from chain:</span>
                    <button className="btn solid" onClick={() => openToken(q.trim().toLowerCase())}>Open token {q.trim().slice(0, 8)}…{q.trim().slice(-6)} <IconArrowRight className="arw" /></button>
                  </div>
                : <div className="msg">No tokens match{q ? ` "${q}"` : ' this filter'}.</div>
            )}

            {rowsTotal > perPage && (
              <div className="pager">
                <div className="pager-info">
                  Showing <b>{(pageNum - 1) * perPage + 1}–{Math.min(pageNum * perPage, rowsTotal)}</b> of {rowsTotal}
                </div>
                <div className="pager-ctrls">
                  <button disabled={pageNum <= 1} onClick={() => { setPageNum((p) => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><IconArrowLeft className="i" /> Prev</button>
                  <span className="pager-num">Page {pageNum} / {totalPages}</span>
                  <button disabled={pageNum >= totalPages} onClick={() => { setPageNum((p) => Math.min(totalPages, p + 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Next <IconArrowRight className="i" /></button>
                  <div className="per">
                    {PER_PAGE_OPTS.map((n) => <button key={n} className={perPage === n ? 'on' : ''} onClick={() => setPerPage(n)}>{n}</button>)}
                  </div>
                </div>
              </div>
            )}

            {/* legend — what the tags mean + which launchpads we track */}
            <div className="legend">
              <div className="legend-head">
                <div className="kicker">Legend</div>
                <h3>What the tags mean</h3>
                <p>All data is read live from <b style={{ color: 'var(--white)' }}>Arc mainnet</b> (chain 5042) — on-chain pools, holders &amp; deployer clustering. Not affiliated with any other network's launchpads.</p>
              </div>
              <div className="legend-grid">
                <div className="legend-item"><span className="badge b-gray">ECO</span><span>Core ecosystem asset — Circle / Arc infra &amp; stablecoins (USDC, EURC, USDT…).</span></div>
                {launchpadLegend.map((l) => (
                  <div className="legend-item" key={l.label}><span className="badge b-red">{l.label}</span><span>{l.desc}</span></div>
                ))}
              </div>
              <div className="legend-foot">Each token is tagged by the contract that created it, read from chain.</div>
            </div>
          </section></div>
        )}

        {page === 'network' && <Network />}
        {page === 'token' && <TokenPage />}
        {page === 'portfolio' && <Portfolio tokens={tokens} wallet={wallet} onConnect={onConnect} onOpenToken={openToken} mainnet />}
        {page === 'swap' && <Swap tokens={swapTokens} wallet={wallet} onConnect={onConnect} preload={swapPreload} mainnet />}

        <footer><div className="wrap">
          <span className="fbrand">STATERA · ARC</span>
          <span>Read on-chain from Arc Mainnet (chain 5042) · own V3/V4 indexer + Uniswap V4 · arc-scan · Warp · RadarDEX</span>
          <span>
            <a className="flink" href="https://x.com/StateraArc" target="_blank" rel="noreferrer">@StateraArc on X</a>
            {' · '}<button className="flink" onClick={() => go('token')}>The $STR token</button>
            {' · '}Not financial advice · early launches are high-risk
          </span>
        </div></footer>
      </div>
    </>
  );
}

// ── home preview card (Trending / Launches / Ecosystem) ──
// The home Dashboard — one panel, three tabs (Top Liquidity / New / Movers), a live stats strip, and a
// ranked table. Replaces the old three separate cards (Trending / Latest Launches / Ecosystem).
function Dashboard({ tab, setTab, data, stats, onOpen, onAll, loading }: {
  tab: 'liq' | 'new' | 'movers'; setTab: (t: 'liq' | 'new' | 'movers') => void;
  data: { liq: Token[]; new: Token[]; movers: Token[] };
  stats: { count: number; vol24: number; newToday: number };
  onOpen: (a: string) => void; onAll: () => void; loading: boolean;
}) {
  const items = data[tab];
  const TABS: [typeof tab, string][] = [['liq', 'Top Liquidity'], ['new', 'New'], ['movers', 'Movers']];
  return (
    <div className="dash panel">
      <div className="dash-head">
        <div><div className="hcard-kick">Live on Arc</div><h3>Dashboard</h3></div>
        <div className="dash-stats">
          <span><b>{fmt(stats.count)}</b> tokens</span>
          <span><b>{usd(stats.vol24)}</b> 24h vol</span>
          <span><b>{stats.newToday}</b> new today</span>
        </div>
      </div>
      <div className="dash-tabs">
        {TABS.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        <button className="dash-all" onClick={onAll}>All <IconArrowRight className="i" /></button>
      </div>
      <div className="dash-table">
        <div className="dash-row dash-h">
          <span className="dash-rank">#</span><span className="dash-tok">Token</span>
          <span className="num">Price</span><span className="num dash-liq">Liquidity</span><span className="num">24h</span><span className="num dash-hld">Holders</span>
        </div>
        {loading && !items.length && <div className="hcard-empty">Loading…</div>}
        {!loading && !items.length && <div className="hcard-empty">Nothing here yet.</div>}
        {items.map((t, i) => (
          <div className="dash-row" key={t.address} onClick={() => onOpen(t.address)}>
            <span className="dash-rank">{i + 1}</span>
            <span className="dash-tok">
              <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
              <span className="dash-id"><span className="dash-name">{t.name}</span><span className="dash-sym">{t.symbol}{t.launchpad ? ` · ${t.launchpad}` : ''}</span></span>
            </span>
            <span className="num dash-px">{tprice(t.price)}</span>
            <span className="num dash-liq">{t.liq != null ? usd(t.liq) : '—'}</span>
            <span className={`num chg ${chgCls(t.change24h)}`}>{chgFmt(t.change24h)}</span>
            <span className="num dash-hld">{fmt(t.holders)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
