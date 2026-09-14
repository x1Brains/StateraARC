import { useEffect, useMemo, useState } from 'react';
import { fetchTokens, fetchMarket, fmt, price, tprice, usd, connectWallet, CHAIN, NET, type Token, type MarketPx } from './lib/arc';
import { TokenLogo } from './components/TokenLogo';
import { TokenDetail } from './components/TokenDetail';
import { Portfolio } from './components/Portfolio';
import { Swap } from './components/Swap';

type Page = 'home' | 'screener' | 'portfolio' | 'swap';
type Filter = 'all' | 'new' | 'eco' | 'ours';
type SortKey = 'liq' | 'mcap' | 'holders' | 'price' | 'name';

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
  { key: 'ours', label: 'Ours' },
];
const PER_PAGE_OPTS = [100, 250, 500];
const byLiq = (a: Token, b: Token) => (b.liq ?? -1) - (a.liq ?? -1);

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [market, setMarket] = useState<MarketPx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('liq');
  const [pageNum, setPageNum] = useState(1);
  const [perPage, setPerPage] = useState(100);
  const [selected, setSelected] = useState<string | null>(null);
  const [net, setNet] = useState<'testnet' | 'mainnet'>(() => {
    try { return (localStorage.getItem('statera-net') as 'testnet' | 'mainnet') || 'testnet'; } catch { return 'testnet'; }
  });
  const switchNet = (n: 'testnet' | 'mainnet') => { setNet(n); setSelected(null); try { localStorage.setItem('statera-net', n); } catch {} };
  const [wallet, setWallet] = useState<string | null>(null);
  const onConnect = async () => { try { const a = await connectWallet(); if (a) setWallet(a); } catch {} };
  // Cinematic hero: one of the four lava scenes, chosen at random on each fresh load.
  const [heroVariant] = useState<number>(() => 1 + Math.floor(Math.random() * 4));

  async function load() {
    setLoading(true); setErr(null);
    fetchMarket().then(setMarket).catch(() => {});
    try {
      const list = await fetchTokens(500);
      setTokens(list);
    } catch (e: any) { setErr(e.message || 'failed to load'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    let r = tokens;
    if (filter === 'new') r = r.filter((t) => t.launchpad);
    else if (filter === 'eco') r = r.filter((t) => t.isEcosystem);
    else if (filter === 'ours') r = r.filter((t) => t.isOurs);
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

  return (
    <>
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
          <div className="net-toggle" role="group" aria-label="network">
            <button className={net === 'testnet' ? 'on' : ''} onClick={() => switchNet('testnet')}>Testnet</button>
            <button className={net === 'mainnet' ? 'on' : ''} onClick={() => switchNet('mainnet')}>Mainnet</button>
          </div>
          {(page === 'portfolio' || page === 'swap') && <button className="connect" onClick={onConnect}>{wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : 'Connect Wallet'}</button>}
        </div></div>

        {/* mainnet gate (home + screener) */}
        {(page === 'home' || page === 'screener') && net === 'mainnet' && (
          <div className="wrap"><section className="section">
            <div className="soon">
              <span className="badge b-red">Not Live Yet</span>
              <h2>Arc Mainnet — launching soon</h2>
              <p>Circle's Arc mainnet isn't public yet. StateraArc flips to live mainnet data the moment it is — one switch, no redeploy. For now, flip back to <b style={{ color: 'var(--red-hi)', cursor: 'pointer' }} onClick={() => switchNet('testnet')}>Testnet</b> to explore real Arc tokens.</p>
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
                  <span className="eyebrow"><span className="dot" /> Live · {CHAIN.name}</span>
                  <h1>Track any <span className="r">launch</span><br />on Arc.</h1>
                  <p className="lede">The token screener for Circle's Arc chain. Every token, every launchpad, every pool — tracked in real time so you spot the plays before the crowd.</p>
                  <div className="hero-cta">
                    <button className="btn solid" onClick={() => goScreener('all')}>Open Screener <span className="arw">→</span></button>
                    <button className="btn ghost" onClick={() => goScreener('new')}>New Launches</button>
                  </div>
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

        {/* ============ SCREENER ============ */}
        {page === 'screener' && net === 'testnet' && selected && (
          <TokenDetail
            address={selected}
            price={tokens.find((t) => t.address === selected)?.price ?? null}
            liq={tokens.find((t) => t.address === selected)?.liq ?? null}
            onBack={() => setSelected(null)}
          />
        )}

        {page === 'screener' && net === 'testnet' && !selected && (
          <div className="wrap"><section className="section" id="screener">
            <div className="section-head">
              <div>
                <div className="kicker">Screener</div>
                <h2>Arc Tokens</h2>
                <p>Live prices, liquidity &amp; market cap from on-chain pools. Launchpad tokens flagged from deployer clustering.</p>
              </div>
              <button className="btn ghost" onClick={load} disabled={loading} style={{ opacity: loading ? .5 : 1 }}>{loading ? 'Loading' : 'Refresh'}</button>
            </div>

            <div className="stats">
              <div className="stat"><div className="v">{tokens.length || '—'}</div><div className="l">Tokens Tracked</div></div>
              <div className="stat"><div className="v">{launchpadCount || '—'}</div><div className="l">Launchpad Tokens</div></div>
              <div className="stat"><div className="v">{ecoCount || '—'}</div><div className="l">Ecosystem</div></div>
              <div className="stat"><div className="v">{CHAIN.name.includes('Testnet') ? 'TESTNET' : 'LIVE'}</div><div className="l">Chain {CHAIN.chainId}</div></div>
            </div>

            <div className="controls">
              <div className="tabs">
                {FILTERS.map((f) => <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>)}
              </div>
              <input className="search" placeholder="Search name, symbol, or address" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="sortby">
                <span className="sortby-l">Sort</span>
                <select className="sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="liq">Liquidity</option>
                  <option value="mcap">Market Cap</option>
                  <option value="holders">Holders</option>
                  <option value="price">Price</option>
                  <option value="name">Name</option>
                </select>
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
                  <div className={`trow tok sc${t.isOurs ? ' mine' : ''}`} key={t.address} onClick={() => setSelected(t.address)}>
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
                      {t.isOurs && <span className="badge b-white">OURS</span>}
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
          </section></div>
        )}

        {page === 'portfolio' && <Portfolio tokens={tokens} wallet={wallet} onConnect={onConnect} />}
        {page === 'swap' && <Swap tokens={tokens} wallet={wallet} onConnect={onConnect} />}

        <footer><div className="wrap">
          <span className="fbrand">STATERA · ARC</span>
          <span>Data via Arcscan · {NET === 'testnet' ? 'Testnet — flips to mainnet at launch' : 'Mainnet'}</span>
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
