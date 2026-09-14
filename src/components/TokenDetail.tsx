import { useEffect, useMemo, useState } from 'react';
import { fetchTokenDetail, fetchTransfers, compact, usd, ago, CHAIN, type TokenDetail as TD, type Transfer } from '../lib/arc';
import { TokenLogo } from './TokenLogo';

const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');

export function TokenDetail({ address, onBack }: { address: string; onBack: () => void }) {
  const [d, setD] = useState<TD | null>(null);
  const [txs, setTxs] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [calc, setCalc] = useState('');

  useEffect(() => {
    setLoading(true); setD(null); setTxs([]);
    Promise.all([fetchTokenDetail(address), fetchTransfers(address, 60)])
      .then(([det, tr]) => { setD(det); setTxs(tr); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [address]);

  const fdv = useMemo(() => (d?.exchangeRate && d?.totalSupply ? d.exchangeRate * d.totalSupply : d?.marketCap ?? null), [d]);
  const calcOut = useMemo(() => {
    const n = parseFloat(calc); if (!d?.exchangeRate || !n) return null; return n / d.exchangeRate;
  }, [calc, d]);

  if (loading) return <div className="wrap"><div className="section"><div className="msg">Loading token…</div></div></div>;
  if (!d) return <div className="wrap"><div className="section"><div className="msg err">Could not load token.</div></div></div>;

  return (
    <div className="wrap">
      <div className="section td">
        <button className="back" onClick={onBack}>← Screener</button>

        {/* header */}
        <div className="td-head">
          <TokenLogo symbol={d.symbol} seed={d.address} url={d.iconUrl} />
          <div className="td-id">
            <div className="td-name">{d.name} <span className="td-sym">/{d.symbol}</span></div>
            <div className="td-flags">
              <span className={`badge ${d.isVerified ? 'b-live' : 'b-gray'}`}>{d.isVerified ? 'Verified' : 'Unverified'}</span>
              <span className="badge b-gray">ERC-20</span>
              <span className="badge b-gray">{d.decimals} dec</span>
            </div>
          </div>
          <div className="td-price">
            <div className="td-px">{d.exchangeRate != null ? '$' + d.exchangeRate.toPrecision(4) : '—'}</div>
            <div className="td-px-l">price {d.exchangeRate == null && '· via pools soon'}</div>
          </div>
        </div>

        {/* stat tiles */}
        <div className="stats td-stats">
          <div className="stat"><div className="v">{usd(d.marketCap)}</div><div className="l">Market Cap</div></div>
          <div className="stat"><div className="v">{usd(fdv)}</div><div className="l">FDV</div></div>
          <div className="stat"><div className="v">{usd(d.volume24h)}</div><div className="l">24h Volume</div></div>
          <div className="stat"><div className="v">{compact(d.holders)}</div><div className="l">Holders</div></div>
          <div className="stat"><div className="v">{compact(d.totalSupply)}</div><div className="l">Total Supply</div></div>
          <div className="stat"><div className="v">{compact(d.transfersCount)}</div><div className="l">Transfers</div></div>
        </div>

        <div className="td-grid">
          {/* transactions */}
          <div>
            <div className="section-head" style={{ marginBottom: 12 }}>
              <div><div className="kicker">Activity</div><h2 style={{ fontSize: 20 }}>Transfers</h2></div>
            </div>
            <div className="table">
              <div className="trow th">
                <span>Time</span><span>From → To</span><span className="num">Amount</span><span className="hidesm">Tx</span>
              </div>
              {txs.map((t, i) => (
                <div className="trow trow-tx" key={t.tx + i}>
                  <span className="dim">{ago(t.t)} ago</span>
                  <span className="td-route"><span className="mono">{short(t.from)}</span><span className="arrow">→</span><span className="mono">{short(t.to)}</span></span>
                  <span className="num">{compact(t.amount)}</span>
                  <a className="addr hidesm" href={`${CHAIN.scan}/tx/${t.tx}`} target="_blank" rel="noreferrer">{short(t.tx)}</a>
                </div>
              ))}
              {!txs.length && <div className="msg">No transfers found.</div>}
            </div>
          </div>

          {/* side */}
          <aside className="td-side">
            <div className="panel side-card">
              <h3>Token Info</h3>
              <Row k="Contract" v={<a className="addr" href={`${CHAIN.scan}/token/${d.address}`} target="_blank" rel="noreferrer">{short(d.address)}</a>} />
              <Row k="Creator" v={d.creator ? <a className="addr" href={`${CHAIN.scan}/address/${d.creator}`} target="_blank" rel="noreferrer">{short(d.creator)}</a> : '—'} />
              <Row k="Decimals" v={String(d.decimals)} />
              <Row k="Total Supply" v={compact(d.totalSupply)} />
              <Row k="Holders" v={compact(d.holders)} />
              <Row k="Verified" v={d.isVerified ? 'Yes' : 'No'} />
            </div>

            <div className="panel side-card">
              <h3>Calculator</h3>
              <div className="calc">
                <input className="search" placeholder="0.00" value={calc} onChange={(e) => setCalc(e.target.value)} />
                <span className="calc-eq">USD →</span>
                <div className="calc-out">{calcOut != null ? compact(calcOut) + ' ' + d.symbol : (d.exchangeRate == null ? 'price soon' : '—')}</div>
              </div>
            </div>

            <div className="panel side-card">
              <h3>Trade</h3>
              <p className="side-note">Swap {d.symbol} through Arc pool liquidity — wiring in the DEX layer next.</p>
              <button className="btn solid" style={{ width: '100%' }} disabled>Connect Wallet</button>
            </div>
          </aside>
        </div>

        <div className="td-disc">Price, liquidity, volume &amp; buy/sell classification come from the DEX-pool layer (phase 2). Supply, holders, transfers &amp; contract data are live from Arcscan.</div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="ir"><span className="ir-k">{k}</span><span className="ir-v">{v}</span></div>;
}
