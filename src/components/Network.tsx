import { useEffect, useState } from 'react';
import { usd } from '../lib/arc';
import { v2Chain, type V2Chain } from '../lib/v2';

// ARC NETWORK — the chain itself, read live by our follower on the VPS (server/chain.ts): every block's producer, tx count,
// gas and base fee; CCTP USDC flows; Circle asset supplies. Block producers are shown by ADDRESS — the chain does not say
// which institution runs which one, and we don't guess.
const n0 = (v: number | null | undefined, d = 0) => (v == null || !isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const short = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
const ago = (s: number) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export function Network() {
  const [c, setC] = useState<V2Chain | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => v2Chain().then((x) => { if (alive) { setC(x); setErr(false); } }).catch(() => { if (alive) setErr(true); });
    load(); const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const h1 = c?.h1, m5 = c?.m5, f = c?.cctp.h1;
  // Label the window we really have: right after a (re)start the follower holds < 1 h of blocks and fills in behind.
  const hw = c ? (c.coveredSeconds >= 3500 ? '1h' : ago(c.coveredSeconds)) : '1h';
  const net = f ? f.in.usd - f.out.usd : null;
  return (
    <div className="wrap"><section className="section" id="network">
      <div className="section-head">
        <div>
          <div className="kicker">Network</div>
          <h2>Arc Mainnet</h2>
          <p>Read live from the chain (5042) by our own node follower — every block, not a sample. Block producers, throughput, fees paid in USDC, CCTP bridge flows and Circle asset supplies.</p>
        </div>
        {c && <span className="asof live"><span className="live-dot" /> Block {n0(c.head)}</span>}
      </div>

      {!c && !err && <div className="msg">Reading the chain…</div>}
      {!c && err && <div className="msg">Network stats are warming up — try again in a minute.</div>}

      {c && <>
        <div className="stats">
          <div className="stat"><div className="v">{h1 ? `${h1.blockTime.toFixed(2)}s` : '—'}</div><div className="l">Block Time · {hw}</div></div>
          <div className="stat"><div className="v">{m5 ? n0(m5.tps, 1) : '—'}</div><div className="l">TPS · 5m</div></div>
          <div className="stat"><div className="v">{h1 ? n0(h1.txs) : '—'}</div><div className="l">Transactions · {hw}</div></div>
          <div className="stat"><div className="v">{h1 ? usd(h1.feesUsdc) : '—'}</div><div className="l">Base Fees Paid · {hw}</div></div>
          <div className="stat"><div className="v">{n0(c.baseFeeGwei, 0)} gwei</div><div className="l">Base Fee (USDC gas)</div></div>
          <div className="stat"><div className="v">{c.validatorCount}</div><div className="l">Block Producers · {hw}</div></div>
          <div className="stat"><div className="v r">FINAL</div><div className="l">&lt;1s Deterministic</div></div>
        </div>

        <div className="net-grid">
          <div className="net-card">
            <div className="net-card-head"><h3>Circle Assets on Arc</h3><span className="side-note">totalSupply() on chain</span></div>
            {(['USDC', 'EURC', 'cirBTC', 'USYC'] as const).map((k) => (
              <div className="net-row" key={k}><span>{k}</span><span className="num mono">{c.supplies[k] == null ? 'reading…' : n0(c.supplies[k], k === 'cirBTC' ? 2 : 0)}</span></div>
            ))}
          </div>
          <div className="net-card">
            <div className="net-card-head"><h3>CCTP Bridge · 1h</h3><span className="side-note">Circle burn / mint of native USDC</span></div>
            <div className="net-row"><span>USDC in</span><span className="num mono up">{f ? usd(f.in.usd) : '—'} <small className="sub">{f ? `${f.in.count} tx` : ''}</small></span></div>
            <div className="net-row"><span>USDC out</span><span className="num mono down">{f ? usd(f.out.usd) : '—'} <small className="sub">{f ? `${f.out.count} tx` : ''}</small></span></div>
            <div className="net-row"><span>Net</span><span className={`num mono ${net != null && net >= 0 ? 'up' : 'down'}`}>{net == null ? '—' : `${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`}</span></div>
            {f && (f.in.byChain.length > 0 || f.out.byChain.length > 0) && (
              <div className="net-chains">
                {f.in.byChain.slice(0, 5).map((x) => <span key={'i' + x.chain} className="badge b-gray">{x.chain} in {usd(x.usd)}</span>)}
                {f.out.byChain.slice(0, 5).map((x) => <span key={'o' + x.chain} className="badge b-gray">to {x.chain} {usd(x.usd)}</span>)}
              </div>
            )}
          </div>
        </div>

        <div className="net-card net-wide">
          <div className="net-card-head"><h3>Block Producers · last {hw === '1h' ? 'hour' : hw}</h3><span className="side-note">Permissioned validators take turns proposing blocks (Malachite BFT). Addresses as recorded on each block.</span></div>
          <div className="net-vals">
            <div className="net-val head"><span>#</span><span>Producer</span><span className="num">Blocks</span><span className="num">Share</span><span className="num">Last block</span></div>
            {c.validators.map((v, i) => (
              <div className="net-val" key={v.address}>
                <span className="rank">{i + 1}</span>
                <a className="mono" href={`https://explorer.arc.io/address/${v.address}`} target="_blank" rel="noreferrer" title={v.address}>{short(v.address)}</a>
                <span className="num mono">{n0(v.blocks)}</span>
                <span className="num mono"><span className="net-bar"><span style={{ width: `${Math.min(100, v.share * 100 * c.validatorCount / 2)}%` }} /></span>{(v.share * 100).toFixed(1)}%</span>
                <span className="num mono">{v.behind <= 0 ? 'now' : `${n0(v.behind)} ago`}</span>
              </div>
            ))}
          </div>
          <div className="legend-foot">Window: {ago(c.coveredSeconds)} of blocks read since our follower started (keeps 6h). Which institution runs each producer is not published on chain.</div>
        </div>
      </>}
    </section></div>
  );
}
