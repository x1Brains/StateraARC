import { useEffect, useMemo, useState } from 'react';
import { v2Activity, type V2Activity } from '../lib/v2';
import { usd } from '../lib/arc';

// Network page: what Arc is DOING right now (server/activity.ts) — the live block tape, USDC issued / burned / moved, active and
// brand-new wallets, and one card per protocol with its last-3-hours sparkline. Refreshed every 5 s.
const n0 = (n: number) => Math.round(n).toLocaleString();
const sgn = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;

function Spark({ v, color = '#ff7a1a', h = 34, fill = true }: { v: number[]; color?: string; h?: number; fill?: boolean }) {
  const W = 180;
  if (!v.length) return <svg className="na-spark" viewBox={`0 0 ${W} ${h}`} />;
  const max = Math.max(...v), min = Math.min(0, ...v), rng = max - min || 1;
  const pts = v.map((x, i) => [(i / Math.max(1, v.length - 1)) * W, h - 2 - ((x - min) / rng) * (h - 4)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const zero = h - 2 - ((0 - min) / rng) * (h - 4);
  return (
    <svg className="na-spark" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" aria-hidden>
      {fill && <path d={`${d}L${W},${zero}L0,${zero}Z`} fill={color} opacity=".14" />}
      {min < 0 && <line x1="0" x2={W} y1={zero} y2={zero} stroke="rgba(255,255,255,.15)" strokeDasharray="3 3" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function NetworkActivity() {
  const [a, setA] = useState<V2Activity | null>(null);
  const [err, setErr] = useState(false);
  const [w, setW] = useState<'h1' | 'today' | 'h24'>('h1');
  useEffect(() => {
    let alive = true;
    const load = () => v2Activity().then((x) => { if (alive) { setA(x); setErr(false); } }).catch(() => { if (alive) setErr(true); });
    load(); const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const color = useMemo(() => Object.fromEntries((a?.protocols || []).map((p) => [p.id, p.color])), [a?.protocols]);
  if (!a) return err ? null : <div className="nx-card"><div className="side-note">Reading the chain…</div></div>;
  const x = a[w];
  const covered = x.from > (w === 'h1' ? a.now - 3600 : w === 'h24' ? a.now - 86400 : Math.floor(a.now / 86400) * 86400) + 120;
  const wl = w === 'h1' ? 'last hour' : w === 'today' ? 'today (UTC)' : 'last 24 hours';
  const maxTx = Math.max(1, ...a.tape.map((b) => b.txs));
  const protos = [...a.protocols].sort((p, q) => (x.protocols[q.id] || 0) - (x.protocols[p.id] || 0));
  const head = a.tape[a.tape.length - 1];
  return (<>
    <div className="nx-card na-card">
      <div className="nx-head"><h3>Live blocks</h3><span className="nx-when">{head ? `block ${head.n.toLocaleString()} · ${new Date(head.ts * 1000).toUTCString().slice(17, 25)} UTC` : ''}</span></div>
      <p className="nx-sub">Each bar is one block (newest on the right). Height = transactions in it; colour = what they did.</p>
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
        <div className="nx-tabs">{([['h1', '1H'], ['today', 'Today'], ['h24', '24H']] as const).map(([k, l]) => <button key={k} type="button" className={w === k ? 'on' : ''} onClick={() => setW(k)}>{l}</button>)}</div></div>
      <p className="nx-sub">Counted from every block on Arc, {wl}{covered ? ` — since ${new Date(x.from * 1000).toUTCString().slice(17, 22)} UTC, when this counter started` : ''}. Sparklines = last 3 hours, one point per minute.</p>
      <div className="na-kpis">
        <div className="na-kpi"><span>USDC net issued</span><b className={x.net >= 0 ? 'up' : 'down'}>{sgn(x.net)}</b><small>{usd(x.minted)} minted · {usd(x.burned)} burned</small><Spark v={a.series.net} color={x.net >= 0 ? '#5ad18a' : '#ff5a5a'} /></div>
        <div className="na-kpi"><span>USDC moved</span><b>{usd(x.moved)}</b><small>every USDC transfer, excluding mints & burns</small><Spark v={a.series.moved} color="#4fd1c5" /></div>
        <div className="na-kpi"><span>Transactions</span><b>{n0(x.txs)}</b><small>in every block, {wl}</small><Spark v={a.series.txs} /></div>
        <div className="na-kpi"><span>Active wallets</span><b>{n0(x.active)}</b><small>different wallets that sent a transaction</small><Spark v={a.series.active} color="#6aa9ff" /></div>
        <div className="na-kpi"><span>New wallets</span><b>{n0(x.newWallets)}</b><small>sent their first-ever transaction</small><Spark v={a.series.newWallets} color="#ffd27a" /></div>
      </div>
    </div>

    <div className="nx-card na-card">
      <div className="nx-head"><h3>Protocols, live</h3><span className="nx-when">{wl}</span></div>
      <p className="nx-sub">Transactions that used each app, read from the events its contracts emitted. One transaction can use several (a swap routed through a smart wallet counts for both).</p>
      <div className="na-protos">
        {protos.map((p) => {
          const n = x.protocols[p.id] || 0;
          return (
            <div className={`na-proto${n ? '' : ' dim'}`} key={p.id}>
              <div className="na-proto-h"><i style={{ background: p.color }} /><b>{p.name}</b><em>{p.cat}</em></div>
              <div className="na-proto-v">{n0(n)}<small> tx</small></div>
              <Spark v={a.series.protocols[p.id] || []} color={p.color} h={28} />
            </div>
          );
        })}
      </div>
    </div>
  </>);
}
