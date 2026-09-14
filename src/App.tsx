import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTokens, fetchMarket, fmt, price, CHAIN, NET, type Token, type MarketPx } from './lib/arc';
import { TokenLogo } from './components/TokenLogo';
import { TokenDetail } from './components/TokenDetail';

type Page = 'screener' | 'portfolio' | 'swap';
type Filter = 'all' | 'new' | 'eco' | 'ours';
type SortKey = 'holders' | 'name';

const NAV: { key: Page; label: string }[] = [
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

export default function App() {
  const [page, setPage] = useState<Page>('screener');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [market, setMarket] = useState<MarketPx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('holders');
  const [selected, setSelected] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    fetchMarket().then(setMarket).catch(() => {});
    try {
      // Loads instantly from the pre-baked snapshot (launchpad flags already computed).
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
    return [...r].sort((a, b) => (sort === 'holders' ? (b.holders ?? -1) - (a.holders ?? -1) : a.name.localeCompare(b.name)));
  }, [tokens, filter, q, sort]);

  const launchpadCount = tokens.filter((t) => t.launchpad).length;
  const ecoCount = tokens.filter((t) => t.isEcosystem).length;

  const go = (p: Page) => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  // Interactive hero: the S tilts in 3D toward the cursor.
  const stage = useRef<HTMLDivElement>(null);
  const onMove = (e: React.MouseEvent) => {
    const el = stage.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty('--ry', (px * 30).toFixed(1) + 'deg');
    el.style.setProperty('--rx', (-py * 22).toFixed(1) + 'deg');
  };
  const onLeave = () => { const el = stage.current; if (el) { el.style.setProperty('--ry', '0deg'); el.style.setProperty('--rx', '0deg'); } };

  return (
    <>
      <div className="backdrop" />
      <div className="shell">
        {/* ticker */}
        <div className="ticker"><div className="wrap">
          {market.map((m) => (
            <span className="t" key={m.sym}><span className="s">{m.sym}</span><span className="p">{price(m.price)}</span></span>
          ))}
          <span className="t"><span className="s" style={{ color: 'var(--red)' }}>ARC</span><span className="p">GAS = USDC</span></span>
        </div></div>

        {/* nav */}
        <div className="nav"><div className="wrap">
          <div className="logo" onClick={() => go('screener')}>
            <img className="nav-logo" src="/statera-lockup.png" alt="StateraArc" />
          </div>
          <div className="nav-links">
            {NAV.map((n) => <button key={n.key} className={page === n.key ? 'on' : ''} onClick={() => go(n.key)}>{n.label}</button>)}
          </div>
          <div className="spacer" />
          {page !== 'screener' && <button className="connect">Connect Wallet</button>}
        </div></div>

        {page === 'screener' && selected && (
          <TokenDetail address={selected} onBack={() => setSelected(null)} />
        )}

        {page === 'screener' && !selected && (
          <>
            {/* hero */}
            <section className="hero"><div className="wrap">
              <div>
                <span className="eyebrow"><span className="dot" /> Live · {CHAIN.name}</span>
                <h1>See every <span className="r">launch</span><br />on Arc first.</h1>
                <p className="lede">The token screener for Circle's Arc chain. Every token, every launchpad, every pool — tracked in real time so you spot the plays before the crowd.</p>
                <div className="hero-cta">
                  <button className="btn solid" onClick={() => { setFilter('all'); document.getElementById('screener')?.scrollIntoView({ behavior: 'smooth' }); }}>Open Screener</button>
                  <button className="btn ghost" onClick={() => { setFilter('new'); document.getElementById('screener')?.scrollIntoView({ behavior: 'smooth' }); }}>New Launches</button>
                </div>
              </div>
              <div className="hero-visual" ref={stage} onMouseMove={onMove} onMouseLeave={onLeave}>
                <img className="hero-s" src="/statera-hero.png" alt="Statera" draggable={false} />
              </div>
            </div></section>

            {/* screener */}
            <div className="wrap"><section className="section" id="screener">
              <div className="section-head">
                <div>
                  <div className="kicker">Screener</div>
                  <h2>Arc Tokens</h2>
                  <p>Ranked by holders. Launchpad tokens flagged from on-chain deployer clustering.</p>
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
                <select className="sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="holders">Holders</option>
                  <option value="name">Name</option>
                </select>
              </div>

              {err && <div className="msg err">Error: {err}</div>}
              {loading && !tokens.length && <div className="msg">Loading Arc tokens…</div>}

              {!!rows.length && (
                <div className="table">
                  <div className="trow head">
                    <span>#</span><span /><span>Token</span>
                    <span className="num hidesm">Holders</span>
                    <span className="hidesm">Tags</span>
                    <span className="hidesm">Contract</span>
                  </div>
                  {rows.map((t, i) => (
                    <div className={`trow tok${t.isOurs ? ' mine' : ''}`} key={t.address} onClick={() => setSelected(t.address)}>
                      <span className="rank">{i + 1}</span>
                      <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
                      <span><div className="tname">{t.name}</div><div className="tsym">{t.symbol}</div></span>
                      <span className="num hidesm">{fmt(t.holders)}</span>
                      <span className="flags hidesm">
                        {t.launchpad && <span className="badge b-red">{t.launchpad}</span>}
                        {t.isEcosystem && <span className="badge b-gray">ECO</span>}
                        {t.isOurs && <span className="badge b-white">OURS</span>}
                      </span>
                      <a className="addr hidesm" href={`${CHAIN.scan}/token/${t.address}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t.address.slice(0, 6)}…{t.address.slice(-4)}</a>
                    </div>
                  ))}
                </div>
              )}
            </section></div>
          </>
        )}

        {page === 'portfolio' && (
          <div className="wrap"><section className="section">
            <div className="soon">
              <span className="badge b-red">Coming Soon</span>
              <h2>Portfolio</h2>
              <p>Connect your Arc wallet to track holdings, P&amp;L, and LP positions in real time — the x1brains portfolio tracker, rebuilt for Arc.</p>
            </div>
          </section></div>
        )}
        {page === 'swap' && (
          <div className="wrap"><section className="section">
            <div className="soon">
              <span className="badge b-red">Coming Soon</span>
              <h2>Swap</h2>
              <p>Swap USDC, EURC, and Arc tokens routed through on-chain pool liquidity, with slippage protection.</p>
            </div>
          </section></div>
        )}

        <footer><div className="wrap">
          <span className="fbrand">STATERA · ARC</span>
          <span>Data via Arcscan · {NET === 'testnet' ? 'Testnet — flips to mainnet at launch' : 'Mainnet'}</span>
          <span>Not financial advice · early launches are high-risk</span>
        </div></footer>
      </div>
    </>
  );
}
