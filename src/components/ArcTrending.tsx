import { useEffect, useMemo, useState } from 'react';
import { fetchWarpTrending, fetchWarpToken, type WarpToken } from '../lib/warp';
import { usd, compact } from '../lib/arc';

const WARP_TOKEN = '0x384c60f98ecd4c26345499345c03d677e40f115e'; // pin the platform token

// Live Arc-mainnet trending, sourced from the Warp launchpad (circlewarp.fun) — the active
// Pump.fun-style venue on chain 5042. Read-only tracking: momentum, volume, holders, bonding-curve
// progress, and a one-tap copy of each contract so you can paste it straight into the Swap picker.
const pct = (n: number | null) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(0) + '%');
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

export function ArcTrending({ onPick }: { onPick?: (t: WarpToken) => void }) {
  const [toks, setToks] = useState<WarpToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sort, setSort] = useState<'hot' | 'mcap'>('hot');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [t, warp] = await Promise.all([fetchWarpTrending(), fetchWarpToken(WARP_TOKEN)]);
      if (!alive) return;
      // pin WARP (the platform token) if it isn't already in the momentum feed
      const merged = warp && !t.some((x) => x.address === warp.address) ? [...t, warp] : t;
      if (merged.length) { setToks(merged); setErr(false); } else if (!toks.length) setErr(true);
      setLoading(false);
    };
    load();
    const id = setInterval(load, 45000); // live refresh
    return () => { alive = false; clearInterval(id); };
  }, []); // eslint-disable-line

  const shown = useMemo(
    () => (sort === 'mcap' ? [...toks].sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0)) : toks),
    [toks, sort],
  );

  const copy = (addr: string) => {
    navigator.clipboard?.writeText(addr).then(() => { setCopied(addr); setTimeout(() => setCopied((c) => (c === addr ? null : c)), 1400); }).catch(() => {});
  };

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <div className="kicker">Live · Arc Mainnet</div>
          <h2>Trending on Arc <span className="atr-live"><span className="atr-dot" /> live</span></h2>
          <p>Real-time data from <b>Warp</b> (circlewarp.fun), the active launchpad on Arc mainnet (chain 5042). Tap a contract to copy it, or hit Trade to load it into Swap. Unofficial · pre-public chain · DYOR.</p>
        </div>
        <div className="atr-sort">
          <button className={sort === 'hot' ? 'on' : ''} onClick={() => setSort('hot')}>Hot</button>
          <button className={sort === 'mcap' ? 'on' : ''} onClick={() => setSort('mcap')}>Market Cap</button>
        </div>
      </div>

      {loading && !toks.length && <div className="load-box"><div className="spinner" /><div className="dim" style={{ fontFamily: 'var(--disp)', letterSpacing: 1.5, textTransform: 'uppercase', fontSize: 12 }}>Loading Arc trending</div></div>}
      {err && !toks.length && <div className="msg err">Couldn’t reach the Warp feed right now — it’s a pre-public endpoint and can be flaky. It’ll refresh automatically.</div>}

      <div className="atr-grid">
        {shown.slice(0, 24).map((t, i) => {
          const c1 = t.windows['1h']?.change ?? null;
          const c6 = t.windows['6h']?.change ?? t.change24h ?? null;
          const up = (c6 ?? 0) >= 0;
          return (
            <div className="atr-card panel" key={t.address}>
              <div className="atr-top">
                <span className="atr-rank">{i + 1}</span>
                {t.image
                  ? <img className="atr-logo" src={t.image} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
                  : <span className="atr-logo mono">{t.ticker.slice(0, 3).toUpperCase()}</span>}
                <div className="atr-id">
                  <div className="atr-tick">${t.ticker}</div>
                  <div className="atr-name">{t.name}</div>
                </div>
                <div className={`atr-chg ${up ? 'up' : 'down'}`}>{pct(c6)}<span className="atr-chg-l">6h</span></div>
              </div>

              <div className="atr-stats">
                <div><span>Price</span><b>{t.price != null ? (t.price < 0.01 ? '$' + t.price.toExponential(1) : usd(t.price)) : '—'}</b></div>
                <div><span>MCap</span><b>{usd(t.mcap)}</b></div>
                <div><span>Vol 24h</span><b>{usd(t.volume24h)}</b></div>
                <div><span>1h</span><b className={(c1 ?? 0) >= 0 ? 'up' : 'down'}>{pct(c1)}</b></div>
                <div><span>Liq</span><b>{usd(t.liquidity)}</b></div>
                <div><span>Holders</span><b>{compact(t.holders)}</b></div>
              </div>

              {t.graduated
                ? <div className="atr-grad">Graduated{t.v4 ? ' · Uniswap V4' : ''}</div>
                : t.progress != null && <div className="atr-prog" title={`${t.progress.toFixed(0)}% to graduation`}><div className="atr-prog-bar" style={{ width: `${Math.min(100, Math.max(0, t.progress))}%` }} /><span>{t.progress.toFixed(0)}% to graduate</span></div>}

              <div className="atr-actions">
                <button className={`atr-copy ${copied === t.address ? 'ok' : ''}`} onClick={() => copy(t.address)} title="Copy contract address">
                  <span className="mono">{short(t.address)}</span>{copied === t.address ? '✓ Copied' : 'Copy ⧉'}
                </button>
                {onPick && <button className="atr-trade" onClick={() => onPick(t)} title="Load into Swap">Trade</button>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
