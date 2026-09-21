import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchScreenerTokens, fetchRadarTokens, fetchDeepPoolPrices, fetchMarket, fetchPoolVolume24h, fetchCuratedV4Tokens, fmt, price, tprice, usd, connectWallet, LAUNCHPADS, type Token, type MarketPx } from './lib/arc';
import { TokenLogo } from './components/TokenLogo';
import { Sparkline } from './components/Sparkline';
import { Portfolio } from './components/Portfolio';
import { Swap } from './components/Swap';
import { Dropdown } from './components/Dropdown';
import { PremainDetail } from './components/PremainDetail';
import { TokenPage } from './components/TokenPage';
import { Disclaimer, disclaimerAcked } from './components/Disclaimer';
import { VisitCounter } from './components/VisitCounter';
import { WalletButton } from './components/WalletButton';
import { IconArrowRight, IconArrowLeft, IconX } from './components/icons';

type Page = 'home' | 'screener' | 'portfolio' | 'swap' | 'token';
type Filter = 'all' | 'new' | 'eco';
type SortKey = 'liq' | 'mcap' | 'holders' | 'price' | 'name' | 'volume' | 'change24h' | 'change1h' | 'age';

// ── deep-linkable URLs (clean path routing, e.g. stateraarc.com/swap). Vercel serves index.html for
//    any non-file/non-/api path (SPA fallback rewrite in vercel.json), so refresh/direct-load work. ──
const PATHS: Record<Page, string> = { home: '/', screener: '/screener', token: '/str', portfolio: '/portfolio', swap: '/swap' };
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
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'swap', label: 'Swap' },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'Launchpad' },
  { key: 'eco', label: 'Ecosystem' },
];
const PER_PAGE_OPTS = [50, 100, 250, 500];
const byLiq = (a: Token, b: Token) => (b.liq ?? -1) - (a.liq ?? -1);
// The deepest Arc tokens (Argus/Tolly/Long/Architects…) trade only on Uniswap V3, which no indexer
// (Warp/RadarDEX) tracks activity for — so their 24h volume column is blank. We compute it on-chain
// from their pool's Swap events (bounded, cached 5 min) and fill it in without blocking the screener.
const poolVolCache = new Map<string, { v: number; ts: number }>();
function enrichPoolVolumes(list: Token[], apply: (addr: string, v: number) => void) {
  const now = Date.now();
  const targets = list
    .filter((t) => t.volume24h == null && (t.liq ?? 0) > 1000)
    .sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0))
    .slice(0, 14);
  for (const t of targets) {
    const c = poolVolCache.get(t.address);
    if (c && now - c.ts < 5 * 60 * 1000) { apply(t.address, c.v); continue; }
    fetchPoolVolume24h(t.address)
      .then((v) => { if (v != null) { poolVolCache.set(t.address, { v, ts: Date.now() }); apply(t.address, v); } })
      .catch(() => {});
  }
}

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

// Legend for the launchpad/factory tags we detect on Arc (from LAUNCHPADS deployer clustering).
const LP_DESC: Record<string, string> = {
  'Memepad': 'Memecoin launchpad — fresh degen mints.',
  'Launcher': 'Generic token launcher.',
  'LP factory': 'Liquidity-pool factory — usually an LP / pool token.',
  'Curve factory': 'Curve-style stableswap factory — usually an LP / pool token.',
};
const LAUNCHPAD_LEGEND = [...new Set(Object.values(LAUNCHPADS))].map((l) => ({ label: l, desc: LP_DESC[l] || `Tokens minted by the ${l} contract on Arc.` }));

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

  // StateraArc is mainnet-only (Arc chain 5042). Tokens = tracked deep pools (real on-chain price +
  // liquidity) merged with live Warp launchpad tokens.
  async function load(silent = false) {
    if (!silent) setLoading(true);
    setErr(null);
    fetchMarket().then(setMarket).catch(() => {});
    try {
      const { tokens: list, asOf: ts } = await fetchScreenerTokens();
      setTokens(list); setAsOf(ts);
      // Merge curated V4 launchpad tokens (GLITCH etc.) that no aggregator indexes, so they're listed &
      // searchable now — priced on-chain. (Full chain-wide V4 discovery bake is the proper fix.)
      fetchCuratedV4Tokens().then((extra) => {
        if (extra.length) setTokens((prev) => { const have = new Set(prev.map((t) => t.address.toLowerCase())); return [...prev, ...extra.filter((e) => !have.has(e.address.toLowerCase()))]; });
      }).catch(() => {});
      // Safety net: if the snapshot ever lacks volume for a deep pool, fill it on-chain (usually a no-op
      // now that the snapshot bakes it).
      enrichPoolVolumes(list, (addr, v) => setTokens((prev) => prev.map((x) => (x.address === addr ? { ...x, volume24h: v } : x))));
    } catch (e: any) { if (!silent) setErr(e.message || 'failed to load'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line
  // LIVE FEED: the snapshot gives the full list instantly; then we overlay fresh RadarDEX price/change/
  // volume/liq (via the relay — live, not the 30-min bake) every ~40s and merge in place by address, so
  // the active tokens update near-live and "Updated" reflects the live pull. Deep pools not on RadarDEX
  // keep their snapshot values until the next bake.
  const refreshLive = async () => {
    try {
      // RadarDEX (~500 active tokens) + on-chain slot0 prices for the deep pools RadarDEX doesn't list.
      const [live, deep] = await Promise.all([fetchRadarTokens(500).catch(() => [] as Token[]), fetchDeepPoolPrices().catch(() => ({} as Record<string, number>))]);
      if (!live.length && !Object.keys(deep).length) return;
      const m = new Map(live.map((t) => [t.address.toLowerCase(), t]));
      setTokens((prev) => prev.map((t) => {
        const a = t.address.toLowerCase();
        const l = m.get(a);
        let n = l ? { ...t, price: l.price ?? t.price, change24h: l.change24h ?? t.change24h, change1h: l.change1h ?? t.change1h, volume24h: l.volume24h ?? t.volume24h, liq: l.liq ?? t.liq, mcap: l.mcap ?? t.mcap } : t;
        if (deep[a] != null) n = { ...n, price: deep[a] }; // deep-pool live price wins (correct slot0)
        return n;
      }));
      setAsOf(Date.now());
    } catch { /* keep snapshot values */ }
  };
  useEffect(() => { const id = setInterval(refreshLive, 40000); refreshLive(); return () => clearInterval(id); }, []); // eslint-disable-line
  // Live-ish: silently refresh prices/mcap/liquidity every 60s (no loading flicker).
  useEffect(() => { const id = setInterval(() => load(true), 60000); return () => clearInterval(id); }, []); // eslint-disable-line

  // Ticker impersonation: Arc has 100+ duplicate tickers (11 fake "USDC", etc.). For each ticker we keep
  // the CANONICAL token (most liquid, holders as tiebreak); the rest are flagged as likely impersonators.
  const { canonical, tickerCount } = useMemo(() => {
    const best = new Map<string, { addr: string; score: number }>();
    const count = new Map<string, number>();
    for (const t of tokens) {
      const s = (t.symbol || '').toUpperCase(); if (!s) continue;
      count.set(s, (count.get(s) || 0) + 1);
      // Ecosystem/core tokens (native USDC, Animus…) are always the real one for their ticker. Otherwise
      // HOLDERS decide (an impersonator has ~0 holders; the real token has thousands) — ranking by liquidity
      // let a fake with a wash-traded pool win. Liquidity is only the tiebreak when holders are equal/unknown.
      const score = (t.isEcosystem ? 1e18 : 0) + (t.holders ?? 0) * 1e9 + (t.liq ?? 0);
      const cur = best.get(s);
      if (!cur || score > cur.score) best.set(s, { addr: t.address.toLowerCase(), score });
    }
    return { canonical: new Set([...best.values()].map((v) => v.addr)), tickerCount: count };
  }, [tokens]);
  const isDup = (t: Token) => (tickerCount.get((t.symbol || '').toUpperCase()) ?? 0) > 1 && !canonical.has(t.address.toLowerCase());
  const dupCount = useMemo(() => tokens.filter(isDup).length, [tokens, canonical, tickerCount]); // eslint-disable-line

  const rows = useMemo(() => {
    let r = tokens;
    if (filter === 'new') r = r.filter((t) => t.launchpad);
    else if (filter === 'eco') r = r.filter((t) => t.isEcosystem);
    const s = q.trim().toLowerCase();
    if (s) {
      // While searching, show EVERY match (incl. duplicates) so a specific token is findable.
      r = r.filter((t) => t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s) || t.address.toLowerCase().includes(s));
      const rank = (t: Token) => {
        const sym = t.symbol.toLowerCase(), nm = t.name.toLowerCase();
        if (sym === s || t.address.toLowerCase() === s) return 0;
        if (sym.startsWith(s)) return 1;
        if (nm.startsWith(s)) return 2;
        return 3;
      };
      // Exact/prefix matches first, then by liquidity — real USDC beats 11 lookalikes.
      return [...r].sort((a, b) => (rank(a) - rank(b)) || ((b.liq ?? -1) - (a.liq ?? -1)));
    }
    // Default view: drop fully-dead tokens (no price/liq/holders/volume) and, unless toggled, impersonators.
    r = r.filter((t) => t.price != null || t.liq != null || (t.holders ?? 0) > 0 || t.volume24h != null);
    if (hideDupes) r = r.filter((t) => !isDup(t));
    // Value a token exposes for the active sort key (null = "no data", always sorts last).
    const val = (t: Token): number | null => (
      sort === 'volume' ? t.volume24h
      : sort === 'change24h' ? t.change24h
      : sort === 'change1h' ? t.change1h
      : sort === 'age' ? t.createdAt
      : (t as any)[sort]) ?? null; // liq | mcap | holders | price
    return [...r].sort((a, b) => {
      if (sort === 'name') { const c = a.name.localeCompare(b.name); return dir === 'asc' ? c : -c; }
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls last, regardless of direction
      if (bv == null) return -1;
      return dir === 'desc' ? bv - av : av - bv;
    });
  }, [tokens, filter, q, sort, dir, hideDupes, canonical, tickerCount]);

  useEffect(() => { setPageNum(1); }, [filter, q, sort, dir, perPage, hideDupes]);
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const pageRows = rows.slice((pageNum - 1) * perPage, pageNum * perPage);

  const launchpadCount = tokens.filter((t) => t.launchpad).length;
  const ecoCount = tokens.filter((t) => t.isEcosystem).length;

  // Home preview lists.
  const trending = useMemo(() => [...tokens].filter((t) => t.liq != null).sort(byLiq).slice(0, 6), [tokens]);
  // Recent launches across ALL launchpads (Argus, Tolly, Long, DYOR, O1, Warp…) — newest first.
  const launches = useMemo(() => [...tokens].filter((t) => t.launchpad && t.createdAt != null)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 6), [tokens]);
  // Ecosystem card: USDC (the native gas token) is always first, then the rest by holders.
  const ecosystem = useMemo(() => {
    const USDC_ADDR = '0x3600000000000000000000000000000000000000';
    return [...tokens].filter((t) => t.isEcosystem).sort((a, b) => {
      const au = a.address.toLowerCase() === USDC_ADDR, bu = b.address.toLowerCase() === USDC_ADDR;
      if (au !== bu) return au ? -1 : 1;
      return (b.holders ?? -1) - (a.holders ?? -1);
    }).slice(0, 6);
  }, [tokens]);

  const go = (p: Page) => { setPage(p); setSelected(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const openToken = (addr: string) => { setSelected(addr); setPage('screener'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const goScreener = (f: Filter = 'all') => { setFilter(f); setSort('liq'); setPage('screener'); setSelected(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  // Hero "search any token": a contract address opens that token page directly (works for ANY token,
  // even ones not in our list — e.g. V4 launchpad coins). A ticker/name jumps to the best match, else
  // opens the screener pre-filtered so they can pick it.
  const [heroQ, setHeroQ] = useState('');
  const heroSearch = () => {
    const s = heroQ.trim();
    if (!s) return;
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) { openToken(s.toLowerCase()); return; }
    const low = s.toLowerCase();
    const hit = tokens.find((t) => (t.symbol || '').toLowerCase() === low)
      || tokens.find((t) => (t.symbol || '').toLowerCase().startsWith(low) || (t.name || '').toLowerCase().startsWith(low));
    if (hit) { openToken(hit.address); return; }
    setQ(s); goScreener('all');
  };

  // URL <-> state: back/forward + direct-load sync, and push a shareable clean path on navigation.
  useEffect(() => {
    const apply = () => { const s = parsePath(); setPage(s.page); setSelected(s.selected); };
    window.addEventListener('popstate', apply);
    return () => { window.removeEventListener('popstate', apply); };
  }, []);
  const navReady = useRef(false);
  useEffect(() => {
    const want = pathFor(page, selected);
    const cur = window.location.pathname.replace(/\/+$/, '') || '/';
    if (cur === want) { navReady.current = true; return; }
    if (navReady.current) window.history.pushState(null, '', want);
    else { window.history.replaceState(null, '', want); navReady.current = true; }
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
                  <p className="lede">The Statera hub for Circle's Arc chain — screener, portfolio &amp; swap. And the studio building <span className="r">X1 City</span>: web3 <span className="r">GameFi</span> in Unreal Engine 5 — the first EVM-SVM game on Arc.</p>
                  <div className="hero-cta">
                    <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <IconArrowRight className="arw" /></button>
                    <button className="btn ghost" onClick={() => goScreener('new')}>New Launches</button>
                  </div>
                  <form className="hero-search" onSubmit={(e) => { e.preventDefault(); heroSearch(); }}>
                    <input className="hs-in" value={heroQ} onChange={(e) => setHeroQ(e.target.value)}
                      placeholder="Search any token — ticker or contract address" aria-label="Search any token" spellCheck={false} />
                    <button type="submit" className="hs-go" aria-label="Search">Search <IconArrowRight className="arw" /></button>
                  </form>
                  <div className="hero-trust">
                    <div className="ht"><b>{tokens.length || '—'}</b><span>Tokens Tracked</span></div>
                    <div className="div" />
                    <div className="ht"><b>{launchpadCount || '—'}</b><span>Launchpad</span></div>
                    <div className="div" />
                    <div className="ht"><b className="r">Live</b><span>Arc Mainnet</span></div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Unreal Engine 5 · X1 City showpiece (our biggest marketing) ── */}
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

            <div className="wrap"><section className="section home">
              <div className="home-cards">
                <Preview title="Trending" kicker="Most liquidity" items={trending} onOpen={openToken} onAll={() => goScreener('all')} loading={loading} />
                <Preview title="Latest Launches" kicker="From launchpads" items={launches} onOpen={openToken} onAll={() => goScreener('new')} loading={loading} badge="launch" />
                <Preview title="Ecosystem" kicker="Circle & Arc core" items={ecosystem} onOpen={openToken} onAll={() => goScreener('eco')} loading={loading} />
              </div>

              <div className="home-cta">
                <div>
                  <div className="kicker">The full board</div>
                  <h2>Every token on Arc, ranked.</h2>
                  <p>Sort {tokens.length || 500}+ tokens by liquidity or market cap, filter launchpads &amp; ecosystem, and dive into per-token trades, holders &amp; pools.</p>
                </div>
                <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <IconArrowRight className="arw" /></button>
              </div>
            </section></div>
          </>
        )}

        {/* ============ SCREENER ============ */}
        {page === 'screener' && selected && (
          <PremainDetail
            address={selected}
            seed={tokens.find((t) => t.address === selected)}
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
              <div className="stat"><div className="v">{tokens.length || '—'}</div><div className="l">Tokens Tracked</div></div>
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
            {loading && !tokens.length && <div className="msg">Loading Arc tokens…</div>}

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
                    <span className="num spark-cell" data-l="Last 24h"><Sparkline data={t.spark} /></span>
                    <span className="flags">
                      {(() => { const c = confScore(t); return c != null ? <span className={`badge conf ${c >= 70 ? 'good' : c >= 40 ? 'mid' : 'bad'}`} title="Confidence — liquidity depth, holders, stability">{c}</span> : null; })()}
                      {t.launchpad && <span className="badge b-lp">{t.launchpad}</span>}
                      {t.isEcosystem && <span className="badge b-gray">ECO</span>}
                    </span>
                  </div>
                ))}
              </div>
              </div>
            )}
            {!loading && !!tokens.length && !rows.length && (
              /^0x[0-9a-fA-F]{40}$/.test(q.trim())
                ? <div className="msg" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                    <span>Not in the indexed list — open it directly from chain:</span>
                    <button className="btn solid" onClick={() => openToken(q.trim().toLowerCase())}>Open token {q.trim().slice(0, 8)}…{q.trim().slice(-6)} <IconArrowRight className="arw" /></button>
                  </div>
                : <div className="msg">No tokens match{q ? ` "${q}"` : ' this filter'}.</div>
            )}

            {rows.length > perPage && (
              <div className="pager">
                <div className="pager-info">
                  Showing <b>{(pageNum - 1) * perPage + 1}–{Math.min(pageNum * perPage, rows.length)}</b> of {rows.length}
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
                {LAUNCHPAD_LEGEND.map((l) => (
                  <div className="legend-item" key={l.label}><span className="badge b-red">{l.label}</span><span>{l.desc}</span></div>
                ))}
              </div>
              <div className="legend-foot">Tracking <b>{LAUNCHPAD_LEGEND.length}</b> launchpads / factories on Arc — each token flagged by the deployer contract that minted it.</div>
            </div>
          </section></div>
        )}

        {page === 'token' && <TokenPage />}
        {page === 'portfolio' && <Portfolio tokens={tokens} wallet={wallet} onConnect={onConnect} onOpenToken={openToken} mainnet />}
        {page === 'swap' && <Swap tokens={tokens} wallet={wallet} onConnect={onConnect} preload={swapPreload} mainnet />}

        <footer><div className="wrap">
          <span className="fbrand">STATERA · ARC</span>
          <span>Data via RadarDEX · Warp · ArcExplorer · Arc Mainnet · chain 5042</span>
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
function Preview({ title, kicker, items, onOpen, onAll, loading, badge }:
  { title: string; kicker: string; items: Token[]; onOpen: (a: string) => void; onAll: () => void; loading: boolean; badge?: 'launch' }) {
  return (
    <div className="hcard panel">
      <div className="hcard-head">
        <div><div className="hcard-kick">{kicker}</div><h3>{title}</h3></div>
        <button className="hcard-all" onClick={onAll}>All <IconArrowRight className="i" /></button>
      </div>
      <div className="hcard-list">
        {loading && !items.length && <div className="hcard-empty">Loading…</div>}
        {!loading && !items.length && <div className="hcard-empty">Nothing here yet.</div>}
        {items.map((t, i) => (
          <div className="hrow" key={t.address} onClick={() => onOpen(t.address)}>
            <span className="hrow-rank">{i + 1}</span>
            <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
            <span className="hrow-id">
              <span className="hrow-name">{t.name}</span>
              <span className="hrow-sym">{t.symbol}{badge === 'launch' && t.launchpad ? ` · ${t.launchpad}` : ''}</span>
            </span>
            <span className="hrow-px">
              <span className="hrow-price">{tprice(t.price)}</span>
              <span className="hrow-liq">{t.liq != null ? usd(t.liq) + ' liq' : t.holders != null ? fmt(t.holders) + ' holders' : '—'}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
