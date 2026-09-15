import { useEffect, useMemo, useState } from 'react';
import {
  fetchTokenDetail, fetchTransfers, fetchHolders, findPool, classifyTrades,
  compact, usd, tprice, ago, CHAIN,
  type TokenDetail as TD, type HolderRow, type PoolInfo,
} from '../lib/arc';
import { TokenLogo } from './TokenLogo';
import { PriceChart } from './PriceChart';

const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');

export function TokenDetail({ address, price, liq, onBack }: { address: string; price: number | null; liq: number | null; onBack: () => void }) {
  const [d, setD] = useState<TD | null>(null);
  const [txs, setTxs] = useState<Awaited<ReturnType<typeof fetchTransfers>>>([]);
  const [holders, setHolders] = useState<HolderRow[]>([]);
  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [calc, setCalc] = useState('');
  const [copied, setCopied] = useState(false);
  const copyAddr = () => {
    if (!d) return;
    navigator.clipboard?.writeText(d.address)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
      .catch(() => {});
  };

  useEffect(() => {
    let alive = true;
    setLoading(true); setD(null); setTxs([]); setHolders([]); setPoolInfo(null);
    (async () => {
      const det = await fetchTokenDetail(address).catch(() => null);
      if (!alive) return;
      setD(det);
      const [tr, hl] = await Promise.all([
        fetchTransfers(address, 60),
        det ? fetchHolders(address, det.decimals, det.totalSupply) : Promise.resolve([] as HolderRow[]),
      ]);
      if (!alive) return;
      setTxs(tr); setHolders(hl); setLoading(false);
      // pool discovery runs on RPC after the page paints, then trades reclassify.
      const pi = await findPool(hl);
      if (alive) setPoolInfo(pi);
    })();
    return () => { alive = false; };
  }, [address]);

  const pool = poolInfo?.pool ?? null;

  // On testnet circulating ≈ total supply, so market cap = FDV = price × supply.
  const mcap = useMemo(() => (price != null && d?.totalSupply ? price * d.totalSupply : null), [price, d]);
  const calcOut = useMemo(() => {
    const n = parseFloat(calc); if (!price || !n) return null; return n / price;
  }, [calc, price]);

  const trades = useMemo(() => classifyTrades(txs, pool, price), [txs, pool, price]);
  const flow = useMemo(() => {
    let buys = 0, sells = 0, bVol = 0, sVol = 0;
    for (const t of trades) {
      if (t.side === 'buy') { buys++; bVol += t.value || 0; }
      else if (t.side === 'sell') { sells++; sVol += t.value || 0; }
    }
    const tot = buys + sells;
    return { buys, sells, bVol, sVol, tot, pct: tot ? (buys / tot) * 100 : null };
  }, [trades]);
  const top10 = useMemo(() => holders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0), [holders]);

  if (loading) return <div className="wrap"><div className="section"><div className="load-box"><div className="spinner" /><div className="dim" style={{ fontFamily: 'var(--disp)', letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: 12 }}>Loading token</div></div></div></div>;
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
            <button className={`copy-addr ${copied ? 'ok' : ''}`} onClick={copyAddr} title="Copy contract address">
              <span className="ca-addr">{d.address}</span>
              <span className="ca-i">{copied ? '✓ Copied' : 'Copy ⧉'}</span>
            </button>
          </div>
          <div className="td-price">
            <div className="td-px">{tprice(price)}</div>
            <div className="td-px-l">price{price == null ? ' · no pool found' : liq != null ? ` · ${usd(liq)} liq` : ''}</div>
          </div>
        </div>

        {/* stat tiles */}
        <div className="stats td-stats">
          <div className="stat"><div className="v">{usd(mcap)}</div><div className="l">Market Cap</div></div>
          <div className="stat"><div className="v">{usd(mcap)}</div><div className="l">FDV</div></div>
          <div className="stat"><div className="v">{liq == null ? '—' : usd(liq)}</div><div className="l">Liquidity</div></div>
          <div className="stat"><div className="v">{compact(d.holders)}</div><div className="l">Holders</div></div>
          <div className="stat"><div className="v">{compact(d.totalSupply)}</div><div className="l">Total Supply</div></div>
          <div className="stat"><div className="v">{compact(d.transfersCount)}</div><div className="l">Transfers</div></div>
        </div>

        <PriceChart address={d.address} symbol={d.symbol} />

        <div className="td-grid">
          {/* trades */}
          <div>
            <div className="section-head" style={{ marginBottom: 12 }}>
              <div><div className="kicker">Activity</div><h2 style={{ fontSize: 20 }}>Trades</h2></div>
            </div>

            {/* buy pressure */}
            <div className="flow">
              <div className="flow-bar">
                <div className="b" style={{ width: `${flow.pct ?? 50}%` }} />
                <div className="s" style={{ width: `${100 - (flow.pct ?? 50)}%` }} />
              </div>
              <div className="flow-legend">
                <span className="buy">▲ {flow.buys} buys{flow.bVol ? ` · ${usd(flow.bVol)}` : ''}</span>
                <span className="dim">{flow.pct != null ? `${Math.round(flow.pct)}% buy pressure` : (pool ? 'no trades' : 'finding pool…')}</span>
                <span className="sell">{flow.sVol ? `${usd(flow.sVol)} · ` : ''}{flow.sells} sells ▼</span>
              </div>
            </div>

            <div className="table">
              <div className="trow tr-trade head">
                <span>Time</span><span>Type</span><span className="num">Amount</span><span className="num hidesm">Value</span><span className="hidesm">Tx</span>
              </div>
              {trades.map((t, i) => (
                <div className="trow tr-trade" key={t.tx + i}>
                  <span className="dim">{ago(t.t)}</span>
                  <span><span className={`side-b ${t.side}`}>{t.side === 'xfer' ? 'Transfer' : t.side}</span></span>
                  <span className={`num ${t.side === 'buy' ? 'amt-buy' : t.side === 'sell' ? 'amt-sell' : ''}`}>{compact(t.amount)}</span>
                  <span className="num hidesm">{t.value != null ? usd(t.value) : '—'}</span>
                  <a className="addr hidesm" href={`${CHAIN.scan}/tx/${t.tx}`} target="_blank" rel="noreferrer">{short(t.tx)}</a>
                </div>
              ))}
              {!trades.length && <div className="msg">No trades found.</div>}
            </div>
          </div>

          {/* side */}
          <aside className="td-side">
            <div className="panel side-card">
              <h3>Liquidity Pool</h3>
              {pool ? (
                <>
                  <Row k="Pool" v={<a className="addr" href={`${CHAIN.scan}/address/${pool}`} target="_blank" rel="noreferrer">{short(pool)}</a>} />
                  <Row k="Pair" v={`${d.symbol} / ${poolInfo?.quoteSym ?? 'USDC'}`} />
                  <Row k="Liquidity" v={liq != null ? usd(liq) : '—'} />
                  <Row k="Price" v={tprice(price)} />
                </>
              ) : <p className="side-note">No on-chain liquidity pool detected — trades can't be classified as buys/sells.</p>}
            </div>

            <div className="panel side-card">
              <h3>Top Holders</h3>
              {holders.slice(0, 8).map((h, i) => {
                const isPool = pool && h.address.toLowerCase() === pool;
                const isCreator = d.creator && h.address.toLowerCase() === d.creator.toLowerCase();
                return (
                  <div className="hold" key={h.address}>
                    <span className="hr">{i + 1}</span>
                    <span className="ha">
                      <a className="addr" href={`${CHAIN.scan}/address/${h.address}`} target="_blank" rel="noreferrer">{short(h.address)}</a>
                      {isPool && <span className="htag pool">Pool</span>}
                      {isCreator && !isPool && <span className="htag creator">Creator</span>}
                    </span>
                    <span className="hp">{h.pct != null ? h.pct.toFixed(1) + '%' : compact(h.balance)}</span>
                  </div>
                );
              })}
              {!!holders.length && <div className="side-note" style={{ marginTop: 10 }}>Top 10 hold <b style={{ color: 'var(--white)' }}>{top10.toFixed(1)}%</b> of supply.</div>}
              {!holders.length && <p className="side-note">No holder data.</p>}
            </div>

            <div className="panel side-card">
              <h3>Token Info</h3>
              <Row k="Contract" v={<span className="ir-copy"><a className="addr" href={`${CHAIN.scan}/token/${d.address}`} target="_blank" rel="noreferrer">{short(d.address)}</a><button className="ca-mini" onClick={copyAddr} title="Copy contract address">{copied ? '✓' : '⧉'}</button></span>} />
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
                <div className="calc-out">{calcOut != null ? compact(calcOut) + ' ' + d.symbol : (price == null ? 'no pool' : '—')}</div>
              </div>
            </div>
          </aside>
        </div>

        <div className="td-disc">Trades are classified by direction against the detected pool (tokens leaving the pool = a buy, entering = a sell); LP add/remove can appear as a trade. Price &amp; liquidity are read live from on-chain pool reserves. Supply, holders, transfers &amp; contract data are live from Arcscan.</div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="ir"><span className="ir-k">{k}</span><span className="ir-v">{v}</span></div>;
}
