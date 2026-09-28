import { useEffect, useState } from 'react';
import { usd } from '../lib/arc';
import { v2Chain, v2Lending, v2Where, type V2Chain, type V2Lending, type V2Where } from '../lib/v2';
import { VALIDATORS, WHERE_KEYS, ASSET_NAME } from './Network';
import { IconArrowRight } from './icons';

// "ARC, LIVE" — the landing page's compact version of the Network page (owner 09-28: "add more network information to the
// landing page"). Same /v2 feeds and the same definitions as Network.tsx, so both pages always show the same numbers.
const n0 = (v: number | null | undefined, d = 0) => (v == null || !isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));

export function ArcLive({ onOpen }: { onOpen: () => void }) {
  const [c, setC] = useState<V2Chain | null>(null);
  const [l, setL] = useState<V2Lending | null>(null);
  const [w, setW] = useState<V2Where | null>(null);
  useEffect(() => {
    let alive = true;
    const fast = () => v2Chain().then((x) => { if (alive) setC(x); }).catch(() => {});
    const slow = () => { v2Lending().then((x) => { if (alive) setL(x); }).catch(() => {}); v2Where().then((x) => { if (alive) setW(x); }).catch(() => {}); };
    fast(); slow();
    const a = setInterval(fast, 15_000), b = setInterval(slow, 120_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);
  if (!c) return null; // nothing half-drawn: the section appears once the chain data is in

  const fee = (21000 * c.baseFeeGwei * 1e9) / 1e18;
  const money = c.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((s, k) => s + (c.supplyUsd?.[k] ?? 0), 0) : null;
  const mOk = !!l?.morpho.complete;
  const lent = l ? l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0) : null, bor = l ? l.aave.borrowUsd + (mOk ? l.morpho.borrowUsd : 0) : null;
  const f = c.cctp.h1, net = f.in.usd - f.out.usd;
  const apps = l ? [{ n: 'Aave', s: l.aave.supplyUsd, b: l.aave.borrowUsd }, ...(mOk ? [{ n: 'Morpho', s: l.morpho.supplyUsd, b: l.morpho.borrowUsd }] : [])] : [];

  return (
    <section className="al">
      <div className="al-head">
        <div>
          <div className="kicker"><span className="live-dot" /> Arc, live</div>
          <h2>The chain behind the tokens.</h2>
          <p>Circle's Arc right now — read straight from the chain: the money on it, where it sits, lending, bridge flows and who runs it.</p>
        </div>
        <button className="btn ghost" onClick={onOpen}>Open Network <IconArrowRight className="arw" /></button>
      </div>

      <div className="al-pulse">
        <div><b>{c.h1 ? `${c.h1.blockTime.toFixed(2)}s` : '—'}</b><span>New block · final</span></div>
        <div><b>{c.m5 ? n0(c.m5.tps) : '—'}<small>/s</small></b><span>Transactions{c.h1 ? ` · ${n0(c.h1.txs)}/hr` : ''}</span></div>
        <div><b className="g">{fee < 0.01 ? `$${fee.toFixed(4)}` : usd(fee)}</b><span>To send money</span></div>
        <div><b>{c.validatorCount}</b><span>Validators</span></div>
      </div>

      <div className="al-grid">
        <div className="al-card" onClick={onOpen}>
          <div className="al-ch"><h3>Money on Arc</h3><span className="al-big">{usd(money)}</span></div>
          {(['USDC', 'cirBTC', 'EURC'] as const).map((k) => {
            const a = w?.assets.find((x) => x.sym === k);
            return (
              <div className="al-asset" key={k}>
                <div className="al-row"><span>{ASSET_NAME[k]}</span><b>{usd(c.supplyUsd?.[k] ?? null)}</b></div>
                {a && a.supply > 0 && <div className="nx-split sm">{WHERE_KEYS.map((bk) => { const p = (a.buckets[bk.k] / a.supply) * 100; return p >= 0.3 ? <span key={bk.k} className={`nx-seg ${bk.cls}`} style={{ width: `${p}%` }} /> : null; })}</div>}
              </div>
            );
          })}
          <div className="al-legend">{WHERE_KEYS.slice(0, 2).concat(WHERE_KEYS.slice(4)).map((bk) => <span key={bk.k}><i className={`nx-dot ${bk.cls}`} />{bk.label}</span>)}</div>
        </div>

        <div className="al-card" onClick={onOpen}>
          <div className="al-ch"><h3>Lending</h3><span className="al-big">{lent ? usd(lent) : '—'}</span></div>
          <div className="al-row"><span>Borrowed</span><b className="gold">{bor != null ? usd(bor) : '—'}{lent ? <small> · {Math.round(((bor ?? 0) / lent) * 100)}% used</small> : null}</b></div>
          {apps.map((a) => { const u = a.s > 0 ? a.b / a.s : 0; return (
            <div className="al-app" key={a.n}>
              <div className="al-row"><span>{a.n}</span><b>{usd(a.s)}<small> · {Math.round(u * 100)}% borrowed</small></b></div>
              <div className="al-util"><span style={{ width: `${Math.min(100, u * 100)}%` }} className={u >= 0.9 ? 'hot' : ''} /></div>
            </div>); })}
          {!mOk && l && <div className="al-note">Morpho: counting markets…</div>}
        </div>

        <div className="al-card" onClick={onOpen}>
          <div className="al-ch"><h3>Bridged · last hour</h3><span className={`al-big ${net >= 0 ? 'up' : 'down'}`}>{net >= 0 ? '+' : '−'}{usd(Math.abs(net))}</span></div>
          <div className="al-io">
            <div><b className="up">{usd(f.in.usd)}</b><span>came in · {f.in.count}</span></div>
            <div><b className="down">{usd(f.out.usd)}</b><span>went out · {f.out.count}</span></div>
          </div>
          <div className="al-chains">
            {f.in.byChain.slice(0, 2).map((x) => <span key={'i' + x.chain}>from {x.chain} <b className="up">{usd(x.usd)}</b></span>)}
            {f.out.byChain.slice(0, 2).map((x) => <span key={'o' + x.chain}>to {x.chain} <b className="down">{usd(x.usd)}</b></span>)}
          </div>
        </div>

        <div className="al-card" onClick={onOpen}>
          <div className="al-ch"><h3>Who runs Arc</h3><span className="al-sub">{c.validatorCount} producers · equal turns</span></div>
          <div className="al-vals">
            {VALIDATORS.map((v) => (
              <span className="al-val" key={v.name} title={v.name}>
                {v.logo ? <img src={`/validators/${v.logo}.png`} alt={v.name} /> : <i>{v.name.split(' ').map((x) => x[0]).join('').slice(0, 2)}</i>}
              </span>
            ))}
          </div>
          <div className="al-note">Circle, BlackRock, Visa, Mastercard, DTCC, ICE and more — permissioned institutions.</div>
        </div>
      </div>
    </section>
  );
}
