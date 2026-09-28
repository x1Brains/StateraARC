import { useEffect, useState } from 'react';
import { usd } from '../lib/arc';
import { v2Chain, v2Lending, type V2Chain, type V2Lending } from '../lib/v2';

// ARC NETWORK — the chain itself, read live by our follower on the VPS (server/chain.ts): every block's producer, tx count,
// gas and base fee; CCTP USDC flows; Circle asset supplies. Block producers are shown by ADDRESS — the chain does not say
// which institution runs which one, and we don't guess.
const n0 = (v: number | null | undefined, d = 0) => (v == null || !isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const short = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
// Spelled out: the labels render in capitals, and '2m' read as '2M' (2 million).
const ago = (s: number) => (s < 90 ? `${Math.round(s)} sec` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function Network() {
  const [c, setC] = useState<V2Chain | null>(null);
  const [err, setErr] = useState(false);
  const [lend, setLend] = useState<V2Lending | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => v2Lending().then((x) => { if (alive) setLend(x); }).catch(() => {});
    load(); const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
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


        {lend && (lend.morpho.markets.length > 0 || lend.aave.assets.length > 0) && <>
          <div className="net-card net-wide">
            <div className="net-card-head"><h3>Lending on Arc</h3><span className="side-note">Morpho Blue + Aave V4, read from their contracts</span></div>
            <div className="stats" style={{ marginBottom: 0 }}>
              <div className="stat"><div className="v">{usd(lend.morpho.supplyUsd + lend.aave.supplyUsd)}</div><div className="l">Supplied</div></div>
              <div className="stat"><div className="v">{usd(lend.morpho.borrowUsd + lend.aave.borrowUsd)}</div><div className="l">Borrowed</div></div>
              <div className="stat"><div className="v">{usd(lend.morpho.supplyUsd)}</div><div className="l">Morpho Blue</div></div>
              <div className="stat"><div className="v">{usd(lend.aave.supplyUsd)}</div><div className="l">Aave V4</div></div>
            </div>
          </div>
          <div className="net-grid" style={{ marginTop: 12 }}>
            <div className="net-card">
              <div className="net-card-head"><h3>Morpho Blue · Markets</h3><span className="side-note">lend · against collateral</span></div>
              <div className="net-lend head"><span>Market</span><span className="num">Supplied</span><span className="num">Borrowed</span><span className="num">Used</span></div>
              {lend.morpho.markets.filter((m) => (m.supplyUsd ?? 0) >= 1).slice(0, 12).map((m) => (
                <div className="net-lend" key={m.id}>
                  <span>{m.loanSymbol || short(m.loan)} <small className="sub">vs {m.collateralSymbol || (m.collateral === '0x0000000000000000000000000000000000000000' ? 'idle' : short(m.collateral))} · LLTV {(m.lltv * 100).toFixed(0)}%</small></span>
                  <span className="num mono">{m.supplyUsd == null ? '—' : usd(m.supplyUsd)}</span>
                  <span className="num mono">{m.borrowUsd == null ? '—' : usd(m.borrowUsd)}</span>
                  <span className="num mono">{m.utilization == null ? '—' : `${(m.utilization * 100).toFixed(0)}%`}</span>
                </div>
              ))}
            </div>
            <div className="net-card">
              <div className="net-card-head"><h3>Aave V4 · Hub Assets</h3><span className="side-note">supplied · borrowed per asset</span></div>
              <div className="net-lend head"><span>Asset</span><span className="num">Supplied</span><span className="num">Borrowed</span><span className="num">Used</span></div>
              {lend.aave.assets.map((a) => (
                <div className="net-lend" key={a.assetId}>
                  <span>{a.symbol || short(a.token)} <small className="sub">{n0(a.supply, a.supply < 10000 ? 2 : 0)}</small></span>
                  <span className="num mono">{a.supplyUsd == null ? '—' : usd(a.supplyUsd)}</span>
                  <span className="num mono">{a.borrowUsd == null ? '—' : usd(a.borrowUsd)}</span>
                  <span className="num mono">{a.utilization == null ? '—' : `${(a.utilization * 100).toFixed(0)}%`}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="legend-foot">Why cirBTC's top two holders look like whales: they are these two lending contracts — Morpho Blue and the Aave V4 Hub hold the cirBTC posted as collateral.</div>
        </>}
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
                <span className="num mono">{v.behind <= 0 ? 'now' : `${n0(v.behind)} blocks ago`}</span>
              </div>
            ))}
          </div>
          <div className="legend-foot">Window: {ago(c.coveredSeconds)} of blocks read since our follower started (keeps 6h). Which institution runs each producer is not published on chain.</div>
        </div>
      </>}
    </section></div>
  );
}
