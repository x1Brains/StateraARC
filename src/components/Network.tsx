import { useEffect, useState } from 'react';
import { usd } from '../lib/arc';
import { v2Chain, v2Lending, type V2Chain, type V2Lending } from '../lib/v2';

// ARC NETWORK — the chain itself, in plain words. Everything is read live from Arc by our follower on the VPS
// (server/chain.ts, server/lending.ts): every block, Circle's asset supplies, CCTP bridge flows, Morpho + Aave lending.
// Written for someone who has never heard "gwei" or "CCTP" (owner, 09-28: "im lost and confused… make it look and read
// better"): one idea per section, a one-line explanation under each number, the technical detail (validator addresses)
// folded away. Validators are shown by address only — the chain doesn't say who runs which, and we don't guess.
const n0 = (v: number | null | undefined, d = 0) => (v == null || !isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const short = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
const span = (s: number) => (s < 90 ? `${Math.round(s)} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`);
const ASSET_NAME: Record<string, string> = { USDC: 'US dollars (USDC)', EURC: 'Euros (EURC)', cirBTC: 'Bitcoin (cirBTC)', USYC: 'Yield dollars (USYC)' };

export function Network() {
  const [c, setC] = useState<V2Chain | null>(null);
  const [err, setErr] = useState(false);
  const [lend, setLend] = useState<V2Lending | null>(null);
  const [showVals, setShowVals] = useState(false);
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

  const h1 = c?.h1, m5 = c?.m5, flows = c?.cctp.h1;
  const hourLabel = c && c.coveredSeconds < 3500 ? `last ${span(c.coveredSeconds)}` : 'last hour';
  // A plain USDC transfer is ~21,000 gas at the base fee; gas is paid in USDC (18-decimal native units).
  const transferFee = c ? (21000 * c.baseFeeGwei * 1e9) / 1e18 : null;
  const assets = c ? (['USDC', 'EURC', 'cirBTC', 'USYC'] as const).filter((k) => (c.supplies[k] ?? 0) > 0) : [];
  const assetsUsd = c?.supplyUsd ? assets.reduce((s, k) => s + (c.supplyUsd?.[k] ?? 0), 0) : null;
  const net = flows ? flows.in.usd - flows.out.usd : null;
  const morphoReady = !!lend?.morpho.complete;
  const lentTotal = lend ? lend.aave.supplyUsd + (morphoReady ? lend.morpho.supplyUsd : 0) : null;
  const borrowedTotal = lend ? lend.aave.borrowUsd + (morphoReady ? lend.morpho.borrowUsd : 0) : null;
  const vals = c?.validators ?? [];
  const even = vals.length > 1 && Math.max(...vals.map((v) => v.share)) - Math.min(...vals.map((v) => v.share)) < 0.01;

  return (
    <div className="wrap"><section className="section" id="network">
      <div className="section-head">
        <div>
          <div className="kicker">Network</div>
          <h2>Arc, live</h2>
          <p>What is happening on the Arc blockchain right now — read straight from the chain, updated every few seconds.</p>
        </div>
        {c && <span className="asof live"><span className="live-dot" /> Live · block {n0(c.head)}</span>}
      </div>

      {!c && !err && <div className="msg">Reading the chain…</div>}
      {!c && err && <div className="msg">Network stats are starting up — try again in a minute.</div>}

      {c && <>
        {/* 1 · The pulse */}
        <div className="nx-pulse">
          <div className="nx-big"><div className="v">{h1 ? `${h1.blockTime.toFixed(2)}s` : '—'}</div><div className="t">New block</div><div className="d">A new block of transactions every half second. Once in a block, a payment is final — it can't be reversed.</div></div>
          <div className="nx-big"><div className="v">{m5 ? n0(m5.tps, 0) : '—'}</div><div className="t">Transactions per second</div><div className="d">{h1 ? `${n0(h1.txs)} transactions in the ${hourLabel}.` : 'Counting…'}</div></div>
          <div className="nx-big"><div className="v">{transferFee == null ? '—' : transferFee < 0.01 ? `$${transferFee.toFixed(4)}` : usd(transferFee)}</div><div className="t">To send money</div><div className="d">Typical fee for a transfer. Fees on Arc are paid in dollars (USDC), not a separate gas coin.</div></div>
          <div className="nx-big"><div className="v">{vals.length || '—'}</div><div className="t">Validators</div><div className="d">Approved institutions take turns confirming blocks{even ? ', each an equal share' : ''}.</div></div>
        </div>

        {/* 2 · Money on Arc */}
        <div className="nx-card">
          <div className="nx-head"><h3>Money on Arc</h3>{assetsUsd != null && assetsUsd > 0 && <span className="nx-total">{usd(assetsUsd)}</span>}</div>
          <p className="nx-sub">Circle's own digital money that exists on Arc today.</p>
          {assets.map((k) => (
            <div className="nx-row" key={k}>
              <span>{ASSET_NAME[k]}</span>
              <span className="num mono">{c.supplyUsd?.[k] != null ? usd(c.supplyUsd[k]!) : '—'}<small className="sub">{n0(c.supplies[k], k === 'cirBTC' ? 2 : 0)} {k}</small></span>
            </div>
          ))}
        </div>

        {/* 3 · Money moving */}
        {flows && <div className="nx-card">
          <div className="nx-head"><h3>Money moving in and out</h3><span className="nx-when">{hourLabel}</span></div>
          <p className="nx-sub">Dollars bridged between Arc and other blockchains through Circle's official bridge.</p>
          <div className="nx-flow">
            <div className="nx-flow-side in"><div className="v">{usd(flows.in.usd)}</div><div className="t">came in · {flows.in.count} transfers</div></div>
            <div className="nx-flow-side out"><div className="v">{usd(flows.out.usd)}</div><div className="t">went out · {flows.out.count} transfers</div></div>
            <div className={`nx-flow-side net ${net != null && net >= 0 ? 'in' : 'out'}`}><div className="v">{net == null ? '—' : `${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`}</div><div className="t">{net != null && net >= 0 ? 'more came in' : 'more went out'}</div></div>
          </div>
          <div className="nx-cols">
            <div><div className="nx-mini">Came in from</div>{flows.in.byChain.slice(0, 5).map((x) => <div className="nx-row sm" key={x.chain}><span>{x.chain}</span><span className="num mono up">{usd(x.usd)}</span></div>)}{!flows.in.byChain.length && <div className="nx-row sm"><span>—</span></div>}</div>
            <div><div className="nx-mini">Went out to</div>{flows.out.byChain.slice(0, 5).map((x) => <div className="nx-row sm" key={x.chain}><span>{x.chain}</span><span className="num mono down">{usd(x.usd)}</span></div>)}{!flows.out.byChain.length && <div className="nx-row sm"><span>—</span></div>}</div>
          </div>
        </div>}

        {/* 4 · Lending */}
        {lend && <div className="nx-card">
          <div className="nx-head"><h3>Lending</h3>{lentTotal != null && lentTotal > 0 && <span className="nx-total">{usd(lentTotal)} lent</span>}</div>
          <p className="nx-sub">People deposit dollars to earn interest; others borrow them against collateral like Bitcoin.{borrowedTotal != null && lentTotal ? ` Right now ${usd(borrowedTotal)} is borrowed — ${Math.round((borrowedTotal / lentTotal) * 100)}% of what is lent.` : ''}</p>
          <div className="nx-row"><span>Aave <small className="sub">lending app</small></span><span className="num mono">{usd(lend.aave.supplyUsd)}<small className="sub">{usd(lend.aave.borrowUsd)} borrowed</small></span></div>
          <div className="nx-row"><span>Morpho <small className="sub">lending app</small></span>
            {morphoReady
              ? <span className="num mono">{usd(lend.morpho.supplyUsd)}<small className="sub">{usd(lend.morpho.borrowUsd)} borrowed</small></span>
              : <span className="num mono nx-dim">counting markets… {Math.round((lend.morpho.progress ?? 0) * 100)}%</span>}
          </div>
          <div className="nx-note">Why the biggest "holders" of Bitcoin on Arc are Morpho and Aave: that Bitcoin is collateral people posted to borrow dollars.</div>
        </div>}

        {/* 5 · Who runs it */}
        <div className="nx-card">
          <div className="nx-head"><h3>Who runs the chain</h3><button className="btn ghost nx-toggle" onClick={() => setShowVals((v) => !v)}>{showVals ? 'Hide' : 'Show'} the {vals.length}</button></div>
          <p className="nx-sub">Arc is run by {vals.length} approved validators — Circle and regulated institutions. They take turns producing blocks{even ? `, each about ${(100 / vals.length).toFixed(1)}% of them` : ''}. The chain records each one's address; it doesn't publish which institution runs which.</p>
          {showVals && <div className="net-vals">
            <div className="net-val head"><span>#</span><span>Validator address</span><span className="num">Blocks</span><span className="num">Share</span><span className="num">Last block</span></div>
            {vals.map((v, i) => (
              <div className="net-val" key={v.address}>
                <span className="rank">{i + 1}</span>
                <a className="mono" href={`https://explorer.arc.io/address/${v.address}`} target="_blank" rel="noreferrer" title={v.address}>{short(v.address)}</a>
                <span className="num mono">{n0(v.blocks)}</span>
                <span className="num mono">{(v.share * 100).toFixed(1)}%</span>
                <span className="num mono">{v.behind <= 0 ? 'just now' : `${n0(v.behind)} blocks ago`}</span>
              </div>
            ))}
          </div>}
        </div>
      </>}
    </section></div>
  );
}
