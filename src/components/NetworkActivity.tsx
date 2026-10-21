import { useEffect, useMemo, useState } from 'react';
import { v2Activity, type V2Activity } from '../lib/v2';
import { usd } from '../lib/arc';

// Network page: what Arc is DOING right now (server/activity.ts) — the live block tape, USDC issued / burned / moved, active and
// brand-new wallets, and one card per protocol with its last-3-hours sparkline. Refreshed every 5 s.
const n0 = (n: number) => Math.round(n).toLocaleString();
const sgn = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;

// Mini bar chart (owner 10-21: the per-minute lines were "too colorful … super flat … weird"). Only the minutes the counter has
// actually covered are drawn (no flat run of zeros before it started), grouped into ≤ 30 bars; one muted tone with the newest
// bar in the brand accent — colour carries meaning only where it means something (signed: green up / red down).
function Bars({ v, from = 0, signed = false, h = 34 }: { v: number[]; from?: number; signed?: boolean; h?: number }) {
  const pts = v.slice(Math.max(0, from), -1); // the last minute is still filling — a half-counted bar read as a sudden drop
  // < 6 minutes counted: a couple of fat bars says nothing yet
  if (pts.length < 6) return <div className="na-bars-empty">collecting…</div>;
  if (pts.every((x) => x === 0)) return <div className="na-bars-empty">none in the last 3 h</div>;
  const per = Math.max(1, Math.ceil(pts.length / 30)), bars: number[] = [];
  // grouped from the NEWEST end, so every bar (the highlighted last one included) spans the same number of whole minutes
  for (let e = pts.length; e - per >= 0; e -= per) bars.unshift(pts.slice(e - per, e).reduce((a, b) => a + b, 0));
  if (!bars.length) return <div className="na-bars-empty">collecting…</div>;
  const max = Math.max(...bars.map(Math.abs)) || 1, W = 100, gap = bars.length > 20 ? 0.8 : 1.6, bw = (W - gap * (bars.length - 1)) / bars.length;
  const mid = signed ? h / 2 : h;
  return (
    <svg className="na-bars" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" aria-hidden>
      {signed && <line x1="0" x2={W} y1={mid} y2={mid} stroke="rgba(255,255,255,.12)" strokeWidth=".5" vectorEffect="non-scaling-stroke" />}
      {bars.map((x, i) => {
        const len = Math.max(x === 0 ? 0 : 1, (Math.abs(x) / max) * (signed ? mid - 1 : h - 1));
        const last = i === bars.length - 1;
        const fill = signed ? (x >= 0 ? (last ? '#5ad18a' : 'rgba(90,209,138,.45)') : (last ? '#ff5a5a' : 'rgba(255,90,90,.45)')) : last ? '#ff7a1a' : 'rgba(255,255,255,.22)';
        return <rect key={i} x={i * (bw + gap)} y={signed && x < 0 ? mid : mid - len} width={bw} height={len} rx=".6" fill={fill} />;
      })}
    </svg>
  );
}

export function NetworkActivity() {
  const [a, setA] = useState<V2Activity | null>(null);
  const [err, setErr] = useState(false);
  const [w, setW] = useState<'h1' | 'today' | 'h24'>('h24'); // owner 10-21: 24 h by default, enough data to read
  useEffect(() => {
    let alive = true;
    const load = () => v2Activity().then((x) => { if (alive) { setA(x); setErr(false); } }).catch(() => { if (alive) setErr(true); });
    load(); const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const color = useMemo(() => Object.fromEntries((a?.protocols || []).map((p) => [p.id, p.color])), [a?.protocols]);
  if (!a) return err ? null : <div className="nx-card"><div className="side-note">Reading the chain…</div></div>;
  const x = a[w];
  const from = Math.max(0, Math.round((a.since - a.series.start) / a.series.step)); // first covered minute (protocols / USDC)
  const fromLive = Math.max(from, Math.round(((a.liveSince ?? a.since) - a.series.start) / a.series.step)); // tx / wallet series
  const span = Math.round((a.now - Math.max(a.since, a.series.start)) / 60);
  const spanL = span >= 120 ? `last ${(span / 60).toFixed(span % 60 ? 1 : 0)} h` : `last ${span} min`;
  const winStart = w === 'h1' ? a.now - 3600 : w === 'h24' ? a.now - 86400 : Math.floor(a.now / 86400) * 86400;
  const covered = x.from > winStart + 120;                                   // protocol + USDC counts (backfilled 24 h)
  const liveOnly = x.liveFrom != null && x.liveFrom > winStart + 120; // tx / wallet counts
  const sinceL = (t: number) => `since ${new Date(t * 1000).toUTCString().slice(17, 22)} UTC`;
  const wl = w === 'h1' ? 'last hour' : w === 'today' ? 'today (UTC)' : 'last 24 hours';
  const maxTx = Math.max(1, ...a.tape.map((b) => b.txs));
  const protos = [...a.protocols].sort((p, q) => (x.protocols[q.id] || 0) - (x.protocols[p.id] || 0));
  const head = a.tape[a.tape.length - 1];
  return (<>
    <div className="nx-card na-card">
      <div className="nx-head"><h3>Live blocks</h3><span className="nx-when">{head ? `block ${head.n.toLocaleString()} · ${new Date(head.ts * 1000).toUTCString().slice(17, 25)} UTC` : ''}</span></div>
      <p className="nx-sub">One bar per block, newest right · height = transactions · colour = what they did.</p>
      <div className="na-tape" role="img" aria-label="Recent blocks">
        {a.tape.map((b) => {
          const parts = Object.entries(b.p).sort((p, q) => q[1] - p[1]);
          const tagged = parts.reduce((s, [, n]) => s + n, 0), scale = b.txs > 0 ? Math.max(b.txs, tagged) : 1;
          return (
            <div className="na-bar" key={b.n} style={{ height: `${Math.max(4, (b.txs / maxTx) * 100)}%` }} title={`Block ${b.n.toLocaleString()} · ${b.txs} tx${parts.length ? ' · ' + parts.map(([k, n]) => `${a.protocols.find((p) => p.id === k)?.name ?? k} ${n}`).join(', ') : ''}`}>
              {parts.map(([k, n]) => <i key={k} style={{ height: `${(n / scale) * 100}%`, background: color[k] }} />)}
            </div>
          );
        })}
      </div>
      <div className="na-legend">{a.protocols.filter((p) => a.tape.some((b) => b.p[p.id])).map((p) => <span key={p.id}><i style={{ background: p.color }} />{p.name}</span>)}<span><i className="na-other" />transfers & other</span></div>
    </div>

    <div className="nx-card na-card">
      <div className="nx-head"><h3>Activity</h3>
        <div className="nx-tabs">{([['h24', '24H'], ['today', 'Today'], ['h1', '1H']] as const).map(([k, l]) => <button key={k} type="button" className={w === k ? 'on' : ''} onClick={() => setW(k)}>{l}</button>)}</div></div>
      <p className="nx-sub">Counted from every block on Arc, {wl}{covered ? ` (${sinceL(x.from)})` : ''}. Bars: {spanL}, newest on the right.</p>
      <div className="na-kpis">
        <div className="na-kpi"><span>USDC net issued</span><b className={x.net >= 0 ? 'up' : 'down'}>{sgn(x.net)}</b><small>{usd(x.minted)} minted · {usd(x.burned)} burned</small><Bars v={a.series.net} from={from} signed /></div>
        <div className="na-kpi"><span>USDC moved</span><b>{usd(x.moved)}</b><small>all USDC transfers</small><Bars v={a.series.moved} from={from} /></div>
        <div className="na-kpi"><span>Transactions</span><b>{n0(x.txs)}</b><small>{liveOnly ? sinceL(x.liveFrom!) : `in every block, ${wl}`}</small><Bars v={a.series.txs} from={fromLive} /></div>
        <div className="na-kpi"><span>Active wallets</span><b>{n0(x.active)}</b><small>{liveOnly ? sinceL(x.liveFrom!) : 'different wallets that sent one'}</small><Bars v={a.series.active} from={fromLive} /></div>
        <div className="na-kpi"><span>New wallets</span><b>{n0(x.newWallets)}</b><small>{liveOnly ? sinceL(x.liveFrom!) : 'sent their first-ever transaction'}</small><Bars v={a.series.newWallets} from={fromLive} /></div>
      </div>
    </div>

    <div className="nx-card na-card">
      <div className="nx-head"><h3>Protocols, live</h3><span className="nx-when">{wl}</span></div>
      <p className="nx-sub">Transactions that used each app, from the events its contracts emitted{covered ? ` (${sinceL(x.from)})` : ''}. A swap through a smart wallet counts for both.</p>
      <div className="na-protos">
        {protos.map((p) => {
          const n = x.protocols[p.id] || 0;
          return (
            <div className={`na-proto${n ? '' : ' dim'}`} key={p.id} title={p.desc || p.name}>
              <div className="na-proto-h"><i style={{ background: p.color }} /><b>{p.name}</b><em>{p.cat}</em></div>
              <div className="na-proto-v">{n0(n)}<small> tx</small></div>
              <Bars v={a.series.protocols[p.id] || []} from={from} h={26} />
            </div>
          );
        })}
      </div>
    </div>
  </>);
}
