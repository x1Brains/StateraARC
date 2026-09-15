import { useEffect, useMemo, useState } from 'react';
import { WATCHLIST, WATCH_CATS, fetchWatchStatus, type WatchCat, type WatchStatus } from '../lib/watchlist';
import { CHAIN } from '../lib/arc';
import { TokenLogo } from './TokenLogo';

export function Watchlist({ net }: { net: 'testnet' | 'mainnet' }) {
  const [filter, setFilter] = useState<WatchCat | 'all'>('all');
  const [status, setStatus] = useState<Record<string, WatchStatus>>({});
  const mainnetMode = net === 'mainnet';

  useEffect(() => {
    if (mainnetMode) return;
    let alive = true;
    (async () => {
      for (const p of WATCHLIST) {
        if (!p.contract) continue;
        const s = await fetchWatchStatus(p.contract);
        if (!alive) return;
        if (s) setStatus((prev) => ({ ...prev, [p.contract!]: s }));
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => { alive = false; };
  }, [mainnetMode]);

  const counts = useMemo(() => { const m: Record<string, number> = {}; WATCHLIST.forEach((p) => (m[p.cat] = (m[p.cat] || 0) + 1)); return m; }, []);
  const rows = useMemo(() => (filter === 'all' ? WATCHLIST : WATCHLIST.filter((p) => p.cat === filter)), [filter]);

  return (
    <div className="wrap"><section className="section">
      <div className="section-head">
        <div>
          <div className="kicker">Ecosystem Watchlist</div>
          <h2>Arc Projects Radar</h2>
          <p>The busiest protocols &amp; hottest launches on Arc — DEXes, bridges, NFT mints &amp; more, ranked by on-chain activity.</p>
        </div>
      </div>

      <div className={`wl-scan ${mainnetMode ? 'armed' : 'live'}`}>
        <span className="wl-dot" />
        {mainnetMode
          ? <span><b>MAINNET WATCH ARMED</b> — scanning for these projects the moment Arc mainnet goes live (Sept 16, 2026).</span>
          : <span><b>SCANNING ARC TESTNET</b> — live on-chain status for {WATCHLIST.length} tracked projects.</span>}
      </div>

      <div className="controls">
        <div className="tabs">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All {WATCHLIST.length}</button>
          {WATCH_CATS.filter((c) => counts[c]).map((c) => (
            <button key={c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>{c} {counts[c]}</button>
          ))}
        </div>
      </div>

      <div className="wl-grid">
        {rows.map((p) => {
          const st = p.contract ? status[p.contract] : undefined;
          return (
            <div className="wl-card panel" key={p.name}>
              <div className="wl-top">
                <TokenLogo symbol={p.symbol || p.name} seed={p.contract || p.name} url={null} />
                <div className="wl-id">
                  <div className="wl-name">{p.name}{p.note && <span className="wl-note">{p.note}</span>}</div>
                  <div className="wl-cat">{p.cat}{p.symbol ? ` · ${p.symbol}` : ''}</div>
                </div>
              </div>
              <p className="wl-desc">{p.desc}</p>
              <div className="wl-meta">
                {p.calls != null && p.calls > 0 && <span className="wl-stat"><b>{p.calls}</b> calls / scan</span>}
                {mainnetMode
                  ? <span className="wl-badge armed">Awaiting mainnet</span>
                  : (st ? <span className={`wl-badge ${st.verified ? 'ok' : ''}`}>{st.verified ? 'Verified' : 'Live'}</span>
                        : (p.contract ? <span className="wl-badge dim">Live</span> : <span className="wl-badge dim">Not on testnet</span>))}
              </div>
              <div className="wl-links">
                {p.contract && !mainnetMode && <a className="wl-link" href={`${CHAIN.scan}/address/${p.contract}`} target="_blank" rel="noreferrer">Contract ↗</a>}
                {p.site && <a className="wl-link" href={p.site} target="_blank" rel="noreferrer">Website ↗</a>}
                {p.x && <a className="wl-link x" href={`https://x.com/${p.x}`} target="_blank" rel="noreferrer">@{p.x}</a>}
                {!p.site && !p.x && <span className="wl-link dim">socials pending</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="td-disc" style={{ marginTop: 20 }}>Activity from our latest Arc testnet scan (busiest contracts by call volume). Not an endorsement — unverified contracts are flagged; DYOR before interacting. Socials shown only where verified.</div>
    </section></div>
  );
}
