import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMainnetTokens, fetchMarket, fetchPoolVolume24h, fmt, price, tprice, usd, connectWallet, LAUNCHPADS, type Token, type MarketPx } from './lib/arc';
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
import { IconArrowRight, IconArrowLeft } from './components/icons';

type Page = 'home' | 'screener' | 'portfolio' | 'swap' | 'token';
type Filter = 'all' | 'new' | 'eco';
type SortKey = 'liq' | 'mcap' | 'holders' | 'price' | 'name';

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
  { key: 'token', label: '$STR' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'swap', label: 'Swap' },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'Launchpad' },
  { key: 'eco', label: 'Ecosystem' },
];
const PER_PAGE_OPTS = [100, 250, 500];
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

// Screener cell formatters
const chgCls = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const chgFmt = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`);
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
  const [market, setMarket] = useState<MarketPx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('liq');
  const [pageNum, setPageNum] = useState(1);
  const [perPage, setPerPage] = useState(100);
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
      const list = await fetchMainnetTokens();
      setTokens(list);
      // Background: fill the on-chain 24h volume for deep-pool tokens the indexers don't cover.
      enrichPoolVolumes(list, (addr, v) => setTokens((prev) => prev.map((x) => (x.address === addr ? { ...x, volume24h: v } : x))));
    } catch (e: any) { if (!silent) setErr(e.message || 'failed to load'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line
  // Live-ish: silently refresh prices/mcap/liquidity every 60s (no loading flicker).
  useEffect(() => { const id = setInterval(() => load(true), 60000); return () => clearInterval(id); }, []); // eslint-disable-line

  const rows = useMemo(() => {
    let r = tokens;
    if (filter === 'new') r = r.filter((t) => t.launchpad);
    else if (filter === 'eco') r = r.filter((t) => t.isEcosystem);
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((t) => t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s) || t.address.includes(s));
    }
    return [...r].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      const k = sort as 'liq' | 'mcap' | 'holders' | 'price';
      return (b[k] ?? -1) - (a[k] ?? -1);
    });
  }, [tokens, filter, q, sort]);

  useEffect(() => { setPageNum(1); }, [filter, q, sort, perPage]);
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
                  <button className="hero-str-teaser alert" onClick={() => go('token')}>
                    <span className="hst-tag warn">Not live</span>
                    <span className="hst-txt"><b>$STR is not launched yet</b> — no token, no presale. Any "$STR" out now is fake. Official launch announced here.</span>
                    <IconArrowRight className="hst-arw" />
                  </button>
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
              </div>
              <input className="search" placeholder="Search name, symbol, or address" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="sortby">
                <span className="sortby-l">Sort</span>
                <Dropdown value={sort} onChange={setSort} align="right" options={[
                  { value: 'liq', label: 'Liquidity' },
                  { value: 'mcap', label: 'Market Cap' },
                  { value: 'holders', label: 'Holders' },
                  { value: 'price', label: 'Price' },
                  { value: 'name', label: 'Name' },
                ]} />
              </div>
            </div>

            {err && <div className="msg err">Error: {err}</div>}
            {loading && !tokens.length && <div className="msg">Loading Arc tokens…</div>}

            {!!pageRows.length && (
              <div className="table-scroll">
              <div className="table wide">
                <div className="trow head sc">
                  <span>#</span><span /><span>Token</span>
                  <span className="num">Price</span>
                  <span className="num">1h</span>
                  <span className="num">24h</span>
                  <span className="num">Vol 24h</span>
                  <span className={`num${sort === 'mcap' ? ' hot' : ''}`}>Market Cap</span>
                  <span className={`num${sort === 'liq' ? ' hot' : ''}`}>Liquidity</span>
                  <span className="num">Holders</span>
                  <span className="num">Age</span>
                  <span className="num">Last 24h</span>
                  <span>Tags</span>
                </div>
                {pageRows.map((t, i) => (
                  <div className="trow tok sc" key={t.address} onClick={() => setSelected(t.address)}>
                    <span className="rank">{(pageNum - 1) * perPage + i + 1}</span>
                    <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
                    <span><div className="tname">{t.name}</div><div className="tsym">{t.symbol}</div></span>
                    <span className="num">{tprice(t.price)}</span>
                    <span className={`num chg ${chgCls(t.change1h)}`}>{chgFmt(t.change1h)}</span>
                    <span className={`num chg ${chgCls(t.change24h)}`}>{chgFmt(t.change24h)}</span>
                    <span className="num">{t.volume24h == null ? '—' : usd(t.volume24h)}</span>
                    <span className={`num${sort === 'mcap' ? ' hot' : ''}`}>{t.mcap == null ? '—' : usd(t.mcap)}</span>
                    <span className={`num${sort === 'liq' ? ' hot' : ''}`}>{t.liq == null ? '—' : usd(t.liq)}</span>
                    <span className="num">{fmt(t.holders)}</span>
                    <span className="num age">{ageStr(t.createdAt)}</span>
                    <span className="num spark-cell"><Sparkline data={t.spark} /></span>
                    <span className="flags">
                      {t.launchpad && <span className="badge b-lp">{t.launchpad}</span>}
                      {t.isEcosystem && <span className="badge b-gray">ECO</span>}
                    </span>
                  </div>
                ))}
              </div>
              </div>
            )}
            {!loading && !!tokens.length && !rows.length && <div className="msg">No tokens match{q ? ` "${q}"` : ' this filter'}.</div>}

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
          <span>Not financial advice · early launches are high-risk</span>
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
