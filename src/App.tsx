import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTokens, fetchPremainTokens, fetchMarket, fmt, price, tprice, usd, connectWallet, CHAIN, NET, LAUNCHPADS, MAINNET_LAUNCH_ISO, MAINNET_LIVE, type Token, type MarketPx, type PremainMeta } from './lib/arc';
import { TokenLogo } from './components/TokenLogo';
import { TokenDetail } from './components/TokenDetail';
import { Portfolio } from './components/Portfolio';
import { Swap } from './components/Swap';
import { Dropdown } from './components/Dropdown';
import { PremainDetail } from './components/PremainDetail';
import { TokenPage } from './components/TokenPage';
import { Watchlist } from './components/Watchlist';
import { ArcTrending } from './components/ArcTrending';
import type { WarpToken } from './lib/warp';
import { Disclaimer, disclaimerAcked } from './components/Disclaimer';
import { VisitCounter } from './components/VisitCounter';

type Page = 'home' | 'screener' | 'watchlist' | 'portfolio' | 'swap' | 'token';
type Filter = 'all' | 'new' | 'eco';
type SortKey = 'liq' | 'mcap' | 'holders' | 'price' | 'name';

// ── deep-linkable URLs (hash routing — shareable, refresh-safe, needs no server config) ──
const PATHS: Record<Page, string> = { home: '/', screener: '/screener', watchlist: '/watchlist', token: '/str', portfolio: '/portfolio', swap: '/swap' };
const hashFor = (pg: Page, sel: string | null): string =>
  pg === 'screener' && sel && /^0x[0-9a-fA-F]{40}$/.test(sel) ? `#/token/${sel}` : `#${PATHS[pg] || '/'}`;
function parseHash(): { page: Page; selected: string | null } {
  const h = (window.location.hash.replace(/^#/, '') || '/').toLowerCase();
  const m = h.match(/^\/token\/(0x[0-9a-f]{40})/);
  if (m) return { page: 'screener', selected: m[1] };
  const found = (Object.keys(PATHS) as Page[]).find((k) => PATHS[k] === h);
  return { page: found || 'home', selected: null };
}

const NAV: { key: Page; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'screener', label: 'Screener' },
  { key: 'watchlist', label: 'Watchlist' },
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
  const [page, setPage] = useState<Page>(() => parseHash().page);
  const [swapPreload, setSwapPreload] = useState<{ address: string; symbol: string; name?: string; price?: number | null } | null>(null);
  const tradeWarp = (t: WarpToken) => { setSwapPreload({ address: t.address, symbol: t.ticker, name: t.name, price: t.price }); setPage('swap'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const [tokens, setTokens] = useState<Token[]>([]);
  const [market, setMarket] = useState<MarketPx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('liq');
  const [pageNum, setPageNum] = useState(1);
  const [perPage, setPerPage] = useState(100);
  const [selected, setSelected] = useState<string | null>(() => parseHash().selected);
  type Net3 = 'testnet' | 'premain' | 'mainnet';
  const [net, setNet] = useState<Net3>(() => {
    try { return (localStorage.getItem('statera-net') as Net3) || 'testnet'; } catch { return 'testnet'; }
  });
  const switchNet = (n: Net3) => { setNet(n); setSelected(null); try { localStorage.setItem('statera-net', n); } catch {} };
  const [premainMetaState, setPremainMetaState] = useState<PremainMeta | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const onConnect = async () => { try { const a = await connectWallet(); if (a) setWallet(a); } catch {} };
  // Cinematic hero: one of the four lava scenes, chosen at random on each fresh load.
  const [heroVariant] = useState<number>(() => 1 + Math.floor(Math.random() * 4));

  async function load() {
    setLoading(true); setErr(null);
    fetchMarket().then(setMarket).catch(() => {});
    try {
      if (net === 'premain') {
        const list = await fetchPremainTokens();
        setTokens(list);
        const { premainMeta } = await import('./lib/arc');
        setPremainMetaState(premainMeta);
      } else {
        const list = await fetchTokens(500);
        setTokens(list);
      }
    } catch (e: any) { setErr(e.message || 'failed to load'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [net]); // eslint-disable-line
  useEffect(() => { if (net === 'premain') setSort('holders'); }, [net]);

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
  const launches = useMemo(() => [...tokens].filter((t) => t.launchpad).sort(byLiq).slice(0, 6), [tokens]);
  const ecosystem = useMemo(() => [...tokens].filter((t) => t.isEcosystem).sort(byLiq).slice(0, 6), [tokens]);

  const go = (p: Page) => { setPage(p); setSelected(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const openToken = (addr: string) => { setSelected(addr); setPage('screener'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const goScreener = (f: Filter = 'all') => { setFilter(f); setSort('liq'); setPage('screener'); setSelected(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  // URL <-> state: back/forward + direct-load sync, and push a shareable hash on navigation.
  useEffect(() => {
    const apply = () => { const s = parseHash(); setPage(s.page); setSelected(s.selected); };
    window.addEventListener('popstate', apply);
    window.addEventListener('hashchange', apply);
    return () => { window.removeEventListener('popstate', apply); window.removeEventListener('hashchange', apply); };
  }, []);
  const navReady = useRef(false);
  useEffect(() => {
    const want = hashFor(page, selected);
    const cur = window.location.hash || '#/';
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
          <div className="net-toggle" role="group" aria-label="network">
            <button className={net === 'testnet' ? 'on' : ''} onClick={() => switchNet('testnet')}>Testnet</button>
            <button className={net === 'premain' ? 'on' : ''} onClick={() => switchNet('premain')} title="Chain 5042 · unofficial pre-public source">Pre-Public</button>
            <button className={net === 'mainnet' ? 'on' : ''} onClick={() => switchNet('mainnet')}>Mainnet</button>
          </div>
          {(page === 'portfolio' || page === 'swap') && <button className="connect" onClick={onConnect}>{wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : 'Connect Wallet'}</button>}
        </div></div>

        {/* mainnet gate (home + screener) — live countdown to Sept 16, 2026 */}
        {(page === 'home' || page === 'screener') && net === 'mainnet' && !MAINNET_LIVE && (
          <div className="wrap"><section className="section">
            <div className="soon cd-card">
              <span className="badge b-red">Mainnet · Sept 16, 2026</span>
              <h2>Arc Mainnet goes live in</h2>
              <Countdown iso={MAINNET_LAUNCH_ISO} />
              <p>Circle's Arc public mainnet launches <b style={{ color: 'var(--white)' }}>September 16, 2026</b>. StateraArc flips to live mainnet data automatically the moment it's on — no redeploy. For now, explore real tokens on <b style={{ color: 'var(--red-hi)', cursor: 'pointer' }} onClick={() => switchNet('testnet')}>Testnet</b>.</p>
            </div>
          </section></div>
        )}

        {/* ============ HOME ============ */}
        {page === 'home' && net === 'testnet' && (
          <>
            <section className="hero">
              <div className="hero-bg"><img src={`/hero-lava-${heroVariant}.jpg`} alt="Statera" /></div>
              <div className="wrap">
                <div className="hero-copy">
                  <span className="eyebrow"><span className="dot" /> Arc Hub · Web3 GameFi</span>
                  <h1>Track any <span className="r">launch</span><br />on Arc.</h1>
                  <p className="lede">The Statera hub for Circle's Arc chain — screener, portfolio &amp; swap. And the studio building <span className="r">X1 City</span>: web3 <span className="r">GameFi</span> in Unreal Engine 5 — the first EVM↔SVM game on Arc.</p>
                  <div className="hero-cta">
                    <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <span className="arw">→</span></button>
                    <button className="btn ghost" onClick={() => goScreener('new')}>New Launches</button>
                  </div>
                  <button className="hero-str-teaser" onClick={() => go('token')}>
                    <span className="hst-tag">New</span>
                    <span className="hst-txt">$STR — the token behind <b>X1 City</b>, our web3 GameFi world in UE5</span>
                    <span className="hst-arw">→</span>
                  </button>
                  <div className="hero-trust">
                    <div className="ht"><b>{tokens.length || '500'}</b><span>Tokens Tracked</span></div>
                    <div className="div" />
                    <div className="ht"><b>{launchpadCount || '—'}</b><span>Launchpad</span></div>
                    <div className="div" />
                    <div className="ht"><b className="r">Live</b><span>Arc Testnet</span></div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Unreal Engine 5 · X1 City showpiece (our biggest marketing) ── */}
            <section className="ue5">
              <div className="ue5-bg"><img src="/hero-lava-3.jpg" alt="" /></div>
              <div className="wrap ue5-inner">
                <div className="ue5-badge"><span className="ue5-dot" /> Unreal Engine 5 · Web3 GameFi · In development</div>
                <h2 className="ue5-h">We’re building <span className="r">X1 City</span> — the first <span className="r">EVM↔SVM</span> game.</h2>
                <p className="ue5-sub">A full open world in <b>Unreal Engine 5</b>, bridging Circle’s Arc (EVM) with X1 (SVM) in web3 gaming — the first to connect both. <b>$STR</b> is the token tied into X1 City — more than a chart, it’s your link to the world we’re building.</p>
                <div className="ue5-feats">
                  <div className="ue5-feat"><b>Open World</b><span>An explorable UE5 city</span></div>
                  <div className="ue5-feat"><b className="r">EVM↔SVM</b><span>First to bridge both</span></div>
                  <div className="ue5-feat"><b>Web3 GameFi</b><span>An on-chain economy</span></div>
                </div>
                <div className="ue5-actions">
                  <a className="btn solid" href="https://x1city.io" target="_blank" rel="noreferrer">Explore X1 City <span className="arw">→</span></a>
                  <button className="btn ghost" onClick={() => go('token')}>The $STR token</button>
                </div>
              </div>
            </section>

            {!MAINNET_LIVE && (
              <div className="wrap"><div className="cd-banner" onClick={() => switchNet('mainnet')}>
                <span className="cd-banner-l"><span className="dot" /> Arc Mainnet · Sept 16, 2026</span>
                <Countdown iso={MAINNET_LAUNCH_ISO} compact />
                <span className="cd-banner-cta">Countdown →</span>
              </div></div>
            )}

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
                <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <span className="arw">→</span></button>
              </div>
            </section></div>
          </>
        )}

        {/* premain (chain 5042) home — compact intro to the pre-public board */}
        {page === 'home' && net === 'premain' && (
          <div className="wrap"><section className="section">
            <div className="prepublic-banner big">
              <span className="pp-dot" />
              <div>
                <div className="kicker" style={{ marginBottom: 6 }}>Pre-Public · Chain 5042</div>
                <h2 style={{ margin: '0 0 8px' }}>Arc's live pre-public mainnet</h2>
                <p style={{ margin: '0 0 14px' }}>The real Arc mainnet chain (5042) is already producing blocks with a live token ecosystem — thousands of holders across stablecoins, wrapped assets and launchpad tokens. This is an <b>unofficial</b> view sourced from an independent indexer (arc-scan.org), <b>not Circle</b>. It becomes the official mainnet view the moment Circle opens the public RPC on Sept 16.</p>
                <button className="btn solid" onClick={() => goScreener('all')}>Open Pre-Public Board <span className="arw">→</span></button>
              </div>
            </div>
            <ArcTrending onPick={tradeWarp} />
          </section></div>
        )}

        {/* ============ SCREENER ============ */}
        {page === 'screener' && net === 'testnet' && selected && (
          <TokenDetail
            address={selected}
            price={tokens.find((t) => t.address === selected)?.price ?? null}
            liq={tokens.find((t) => t.address === selected)?.liq ?? null}
            onBack={() => setSelected(null)}
          />
        )}

        {page === 'screener' && net === 'premain' && selected && (
          <PremainDetail
            address={selected}
            seed={tokens.find((t) => t.address === selected)}
            onBack={() => setSelected(null)}
          />
        )}

        {page === 'screener' && (net === 'testnet' || net === 'premain') && !selected && (
          <div className="wrap"><section className="section" id="screener">
            {net === 'premain' && (
              <div className="prepublic-banner">
                <span className="pp-dot" />
                <div>
                  <b>PRE-PUBLIC · Arc mainnet (chain 5042)</b> — an <b>unofficial</b> view of the live pre-public chain, sourced from an independent indexer (<a href="https://arc-scan.org" target="_blank" rel="noreferrer">arc-scan.org</a>), not Circle. Ranked by holders. Aggregates are unverified; token symbols are impersonated freely, so lookalikes are flagged — DYOR.
                  {premainMetaState?.headBlock && <span className="pp-meta"> · block {Number(premainMetaState.headBlock).toLocaleString()} · {premainMetaState.tokenCount} tokens</span>}
                </div>
              </div>
            )}
            {net === 'premain' && <ArcTrending onPick={tradeWarp} />}
            <div className="section-head">
              <div>
                <div className="kicker">{net === 'premain' ? 'Pre-Public Board' : 'Screener'}</div>
                <h2>Arc Tokens</h2>
                <p>{net === 'premain'
                  ? 'The most-held tokens on Arc pre-public mainnet, ranked by holder count. Prices land once the Uniswap v4 quoter is wired. Click a token to view it on arc-scan.org.'
                  : 'Live prices, liquidity & market cap from on-chain pools. Launchpad tokens flagged from deployer clustering.'}</p>
              </div>
              <button className="btn ghost" onClick={load} disabled={loading} style={{ opacity: loading ? .5 : 1 }}>{loading ? 'Loading' : 'Refresh'}</button>
            </div>

            {net === 'premain' ? (
              <div className="stats">
                <div className="stat"><div className="v">{tokens.length || '—'}</div><div className="l">Tokens Indexed</div></div>
                <div className="stat"><div className="v">{tokens[0]?.symbol ?? '—'}</div><div className="l">Most Held</div></div>
                <div className="stat"><div className="v">{tokens.reduce((s, t) => s + (t.holders || 0), 0).toLocaleString()}</div><div className="l">Total Holders</div></div>
                <div className="stat"><div className="v r">PRE-PUBLIC</div><div className="l">Chain 5042</div></div>
              </div>
            ) : (
              <div className="stats">
                <div className="stat"><div className="v">{tokens.length || '—'}</div><div className="l">Tokens Tracked</div></div>
                <div className="stat"><div className="v">{launchpadCount || '—'}</div><div className="l">Launchpad Tokens</div></div>
                <div className="stat"><div className="v">{ecoCount || '—'}</div><div className="l">Ecosystem</div></div>
                <div className="stat"><div className="v">{CHAIN.name.includes('Testnet') ? 'TESTNET' : 'LIVE'}</div><div className="l">Chain {CHAIN.chainId}</div></div>
              </div>
            )}

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
              <div className="table">
                <div className="trow head sc">
                  <span>#</span><span /><span>Token</span>
                  <span className="num">Price</span>
                  <span className={`num hidesm${sort === 'mcap' ? ' hot' : ''}`}>Market Cap</span>
                  <span className={`num hidesm${sort === 'liq' ? ' hot' : ''}`}>Liquidity</span>
                  <span className="num hidesm">Holders</span>
                  <span className="hidesm">Tags</span>
                </div>
                {pageRows.map((t, i) => (
                  <div className="trow tok sc" key={t.address} onClick={() => setSelected(t.address)}>
                    <span className="rank">{(pageNum - 1) * perPage + i + 1}</span>
                    <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
                    <span><div className="tname">{t.name}</div><div className="tsym">{t.symbol}</div></span>
                    <span className="num">{tprice(t.price)}</span>
                    <span className={`num hidesm${sort === 'mcap' ? ' hot' : ''}`}>{t.mcap == null ? '—' : usd(t.mcap)}</span>
                    <span className={`num hidesm${sort === 'liq' ? ' hot' : ''}`}>{t.liq == null ? '—' : usd(t.liq)}</span>
                    <span className="num hidesm">{fmt(t.holders)}</span>
                    <span className="flags hidesm">
                      {t.launchpad && <span className="badge b-red">{t.launchpad}</span>}
                      {t.isEcosystem && <span className="badge b-gray">ECO</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!loading && !!tokens.length && !rows.length && <div className="msg">No tokens match{q ? ` "${q}"` : ' this filter'}.</div>}

            {rows.length > perPage && (
              <div className="pager">
                <div className="pager-info">
                  Showing <b>{(pageNum - 1) * perPage + 1}–{Math.min(pageNum * perPage, rows.length)}</b> of {rows.length}
                </div>
                <div className="pager-ctrls">
                  <button disabled={pageNum <= 1} onClick={() => { setPageNum((p) => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>← Prev</button>
                  <span className="pager-num">Page {pageNum} / {totalPages}</span>
                  <button disabled={pageNum >= totalPages} onClick={() => { setPageNum((p) => Math.min(totalPages, p + 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Next →</button>
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
                <p>All data is read live from the <b style={{ color: 'var(--white)' }}>Arc chain</b> ({CHAIN.name}) — on-chain pools, holders &amp; deployer clustering. Not affiliated with any other network's launchpads.</p>
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

        {page === 'watchlist' && <Watchlist net={net === 'mainnet' ? 'mainnet' : 'testnet'} />}
        {page === 'token' && <TokenPage />}
        {page === 'portfolio' && <Portfolio tokens={tokens} wallet={wallet} onConnect={onConnect} />}
        {page === 'swap' && <Swap tokens={tokens} wallet={wallet} onConnect={onConnect} preload={swapPreload} />}

        <footer><div className="wrap">
          <span className="fbrand">STATERA · ARC</span>
          <span>Data via Arcscan · {NET === 'testnet' ? 'Testnet — flips to mainnet at launch' : 'Mainnet'}</span>
          <span>Not financial advice · early launches are high-risk</span>
        </div></footer>
      </div>
    </>
  );
}

// ── live countdown to Arc mainnet ──
function useCountdown(iso: string) {
  const target = new Date(iso).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const ms = Math.max(0, target - now);
  return {
    d: Math.floor(ms / 86400000),
    h: Math.floor((ms % 86400000) / 3600000),
    m: Math.floor((ms % 3600000) / 60000),
    s: Math.floor((ms % 60000) / 1000),
    done: ms === 0,
  };
}
function Countdown({ iso, compact }: { iso: string; compact?: boolean }) {
  const { d, h, m, s, done } = useCountdown(iso);
  if (done) return <span className="cd-live">Mainnet is live</span>;
  if (compact) return <span className="cd-compact">{d}d {String(h).padStart(2, '0')}h {String(m).padStart(2, '0')}m {String(s).padStart(2, '0')}s</span>;
  const cell = (v: number, l: string) => <div className="cd-cell"><div className="cd-v">{String(v).padStart(2, '0')}</div><div className="cd-l">{l}</div></div>;
  return <div className="cd">{cell(d, 'Days')}<span className="cd-sep">:</span>{cell(h, 'Hrs')}<span className="cd-sep">:</span>{cell(m, 'Min')}<span className="cd-sep">:</span>{cell(s, 'Sec')}</div>;
}

// ── home preview card (Trending / Launches / Ecosystem) ──
function Preview({ title, kicker, items, onOpen, onAll, loading, badge }:
  { title: string; kicker: string; items: Token[]; onOpen: (a: string) => void; onAll: () => void; loading: boolean; badge?: 'launch' }) {
  return (
    <div className="hcard panel">
      <div className="hcard-head">
        <div><div className="hcard-kick">{kicker}</div><h3>{title}</h3></div>
        <button className="hcard-all" onClick={onAll}>All →</button>
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
              <span className="hrow-liq">{t.liq == null ? '—' : usd(t.liq) + ' liq'}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
