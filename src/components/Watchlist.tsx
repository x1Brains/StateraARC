import { useEffect, useMemo, useState } from 'react';
import { WATCHLIST, MAINNET_WATCH, fetchWatchStatus, type WatchProject, type WatchCat, type WatchStatus } from '../lib/watchlist';
import { CHAIN } from '../lib/arc';
import { TokenLogo } from './TokenLogo';

const CONF_LABEL: Record<string, string> = {
  'at launch': 'Confirmed at launch',
  'private mainnet': 'On private mainnet',
  'confirmed partner': 'Confirmed partner',
  'validator': 'Founding validator',
};

// Filter groups — collapse granular cats into a handful of tabs that fit one clean row.
const GROUPS: { label: string; cats: WatchCat[] }[] = [
  { label: 'DEX', cats: ['DEX'] },
  { label: 'Lending', cats: ['Lending'] },
  { label: 'Bridge', cats: ['Bridge'] },
  { label: 'Oracle', cats: ['Oracle'] },
  { label: 'RWA', cats: ['RWA'] },
  { label: 'NFT', cats: ['NFT'] },
  { label: 'Wallet', cats: ['Wallet'] },
  { label: 'Infra', cats: ['Infra', 'Token', 'Social', 'Stablecoin', 'Payments', 'Exchange', 'MM'] },
];

export function Watchlist({ net }: { net: 'testnet' | 'mainnet' }) {
  const [filter, setFilter] = useState<string>('all'); // 'all' or a group label
  const [status, setStatus] = useState<Record<string, WatchStatus>>({});
  const mainnetMode = net === 'mainnet';
  const catsFor = (label: string) => GROUPS.find((g) => g.label === label)?.cats ?? [];
  const inFilter = (p: WatchProject) => filter === 'all' || catsFor(filter).includes(p.cat);

  useEffect(() => {
    if (mainnetMode) return;
    let alive = true;
    (async () => {
      for (const p of WATCHLIST) {
        if (!p.contract) continue;
        const s = await fetchWatchStatus(p.contract);
        if (!alive) return;
        if (s) setStatus((prev) => ({ ...prev, [p.contract!]: s }));
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return () => { alive = false; };
  }, [mainnetMode]);

  // counts per GROUP across both tiers for the category tabs
  const groupCounts = useMemo(() => {
    const all = [...WATCHLIST, ...MAINNET_WATCH];
    const m: Record<string, number> = {};
    GROUPS.forEach((g) => (m[g.label] = all.filter((p) => g.cats.includes(p.cat)).length));
    return m;
  }, []);

  const liveRows = useMemo(() => {
    const rows = [...WATCHLIST].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0));
    return rows.filter(inFilter);
  }, [filter]); // eslint-disable-line
  const mainnetRows = useMemo(() => MAINNET_WATCH.filter(inFilter), [filter]); // eslint-disable-line
  const maxCalls = useMemo(() => Math.max(1, ...WATCHLIST.map((p) => p.calls ?? 0)), []);

  const totalTracked = WATCHLIST.length + MAINNET_WATCH.length;

  return (
    <div className="wrap"><section className="section">
      <div className="section-head">
        <div>
          <div className="kicker">Ecosystem Watchlist</div>
          <h2>Arc Projects Radar</h2>
          <p>Every protocol worth watching on Arc — {WATCHLIST.length} live on testnet (ranked by real on-chain activity) plus {MAINNET_WATCH.length} confirmed mainnet launches. {totalTracked} tracked in total.</p>
        </div>
      </div>

      <div className={`wl-scan ${mainnetMode ? 'armed' : 'live'}`}>
        <span className="wl-dot" />
        {mainnetMode
          ? <span><b>MAINNET WATCH ARMED</b> — hunting for these protocols the moment Arc mainnet opens (Sept 16, 2026).</span>
          : <span><b>SCANNING ARC TESTNET</b> — live on-chain status &amp; activity ranking for {WATCHLIST.length} tracked protocols.</span>}
      </div>

      <div className="controls">
        <div className="tabs wl-tabs">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All {totalTracked}</button>
          {GROUPS.filter((g) => groupCounts[g.label]).map((g) => (
            <button key={g.label} className={filter === g.label ? 'on' : ''} onClick={() => setFilter(g.label)}>{g.label} {groupCounts[g.label]}</button>
          ))}
        </div>
      </div>

      {/* ── LIVE ON TESTNET ── */}
      {liveRows.length > 0 && (
        <>
          <div className="wl-tier-head">
            <h3>Live on Arc Testnet</h3>
            <span className="wl-tier-sub">Ranked by activity in the last ~3,000 on-chain transactions</span>
          </div>
          <div className="wl-grid">
            {liveRows.map((p, i) => {
              const st = p.contract ? status[p.contract] : undefined;
              const pct = Math.round(((p.calls ?? 0) / maxCalls) * 100);
              return (
                <div className="wl-card panel" key={p.name}>
                  <div className="wl-top">
                    {p.calls != null && <span className="wl-rank">#{i + 1}</span>}
                    <TokenLogo symbol={p.symbol || p.name} seed={p.contract || p.name} url={null} />
                    <div className="wl-id">
                      <div className="wl-name">{p.name}{p.note && <span className="wl-note">{p.note}</span>}</div>
                      <div className="wl-cat">{p.cat}{p.symbol ? ` · ${p.symbol}` : ''}</div>
                    </div>
                  </div>
                  <p className="wl-desc">{p.desc}</p>
                  {p.calls != null && (
                    <div className="wl-act">
                      <div className="wl-act-bar"><span style={{ width: `${Math.max(6, pct)}%` }} /></div>
                      <span className="wl-act-n">{p.calls} recent calls</span>
                    </div>
                  )}
                  <div className="wl-meta">
                    {st
                      ? <span className={`wl-badge ${st.verified ? 'ok' : 'dim'}`}>{st.verified ? 'Verified' : 'Live'}</span>
                      : (p.contract ? <span className="wl-badge dim">Live</span> : <span className="wl-badge dim">Mainnet-only</span>)}
                  </div>
                  <div className="wl-links">
                    {p.contract && <a className="wl-link" href={`${CHAIN.scan}/address/${p.contract}`} target="_blank" rel="noreferrer">Contract ↗</a>}
                    {p.site && <a className="wl-link" href={p.site} target="_blank" rel="noreferrer">Website ↗</a>}
                    {p.x && <a className="wl-link x" href={`https://x.com/${p.x}`} target="_blank" rel="noreferrer">@{p.x}</a>}
                    {!p.site && !p.x && !p.contract && <span className="wl-link dim">socials pending</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── MAINNET DAY-ONE ── */}
      {mainnetRows.length > 0 && (
        <>
          <div className="wl-tier-head mt">
            <h3>Mainnet Day-One</h3>
            <span className="wl-tier-sub">Confirmed protocols launching on Arc mainnet · Sept 16, 2026</span>
          </div>
          <div className="wl-grid">
            {mainnetRows.map((p: WatchProject) => (
              <div className="wl-card panel mainnet" key={p.name}>
                <div className="wl-top">
                  <TokenLogo symbol={p.symbol || p.name} seed={p.name} url={null} />
                  <div className="wl-id">
                    <div className="wl-name">{p.name}</div>
                    <div className="wl-cat">{p.cat}</div>
                  </div>
                </div>
                <p className="wl-desc">{p.desc}</p>
                <div className="wl-meta">
                  {p.conf && <span className={`wl-conf ${p.conf === 'at launch' ? 'hot' : ''}`}>{CONF_LABEL[p.conf]}</span>}
                </div>
                <div className="wl-links">
                  {p.site && <a className="wl-link" href={p.site} target="_blank" rel="noreferrer">Website ↗</a>}
                  {p.x && <a className="wl-link x" href={`https://x.com/${p.x}`} target="_blank" rel="noreferrer">@{p.x}</a>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="td-disc" style={{ marginTop: 20 }}>
        Testnet ranking = each contract's share of a live sample of the most recent Arc testnet transactions (a "hot right now" signal, not a lifetime total). Mainnet day-one = protocols Circle/arc.io have publicly confirmed; presence is not a live contract until launch. Not an endorsement — unverified contracts are flagged; DYOR before interacting.
      </div>
    </section></div>
  );
}
