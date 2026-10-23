import { useEffect, useMemo, useRef, useState } from 'react';
import { v2Flow, v2Traders, v2Profit, v2History, type V2FlowWin, type V2Trader, type V2Profit, type V2HistTrade } from '../lib/v2';
import { usd, compact, tprice } from '../lib/arc';
import { useNames, displayName } from '../lib/names';
import { IconExternal } from './icons';

// Token page panels fed by the swap store (server/swap-store.ts): money flow, holder profitability, top traders, and the live
// trades feed with filters. `onMaker` = show that wallet's trades on the chart (and filter the feed to it).
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
const ago = (ms: number) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };

export function MoneyFlowCard({ address, onMaker }: { address: string; onMaker?: (w: string) => void }) {
  const [d, setD] = useState<V2FlowWin[] | null>(null);
  const [w, setW] = useState('24h');
  useEffect(() => {
    let alive = true; setD(null);
    const load = () => v2Flow(address).then((r) => { if (alive) setD(r.windows); }).catch(() => { if (alive) setD((x) => x ?? []); });
    load(); const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [address]);
  const x = d?.find((k) => k.window === w) ?? null;
  const names = useNames([x?.topBuyer?.wallet, x?.topSeller?.wallet]);
  if (d && !d.length) return null;
  const tot = x ? x.buyUsd + x.sellUsd : 0, bp = tot > 0 ? (x!.buyUsd / tot) * 100 : 50;
  return (
    <div className="panel side-card mf-card">
      <div className="mf-h"><h3>Money Flow</h3>
        <div className="mf-w">{['1h', '24h', '7d'].map((k) => <button key={k} className={w === k ? 'on' : ''} onClick={() => setW(k)}>{k.toUpperCase()}</button>)}</div></div>
      {!x ? <div className="side-note">Loading…</div> : (<>
        <div className={`mf-net ${x.net >= 0 ? 'up' : 'down'}`}>{signed(x.net)} <span>net {x.net >= 0 ? 'inflow' : 'outflow'}</span></div>
        <div className="bs-bar"><div className="bs-buy" style={{ width: `${bp}%` }} /><div className="bs-sell" style={{ width: `${100 - bp}%` }} /></div>
        <div className="bs-legend"><span className="bs-b">Bought {usd(x.buyUsd)}</span><span className="bs-s">Sold {usd(x.sellUsd)}</span></div>
        <div className="ta-grid">
          <div className="ta-cell"><div className="ta-v">{x.buys.toLocaleString()}</div><div className="ta-l">Buys</div></div>
          <div className="ta-cell"><div className="ta-v">{x.sells.toLocaleString()}</div><div className="ta-l">Sells</div></div>
          <div className="ta-cell"><div className="ta-v">{x.makersKnown ? x.buyers.toLocaleString() : '—'}</div><div className="ta-l">Buyers</div></div>
          <div className="ta-cell"><div className="ta-v">{x.makersKnown ? x.sellers.toLocaleString() : '—'}</div><div className="ta-l">Sellers</div></div>
          <div className="ta-cell"><div className="ta-v">{usd(x.biggestBuy)}</div><div className="ta-l">Biggest buy</div></div>
          <div className="ta-cell"><div className="ta-v">{usd(x.biggestSell)}</div><div className="ta-l">Biggest sell</div></div>
        </div>
        {(x.topBuyer || x.topSeller) && <div className="mf-top">
          {x.topBuyer && <button onClick={() => onMaker?.(x.topBuyer!.wallet)} title="Show this wallet's trades on the chart"><span>Top buyer</span><b>{displayName(x.topBuyer.wallet, names, short)}</b><i className="up">{signed(x.topBuyer.net)}</i></button>}
          {x.topSeller && <button onClick={() => onMaker?.(x.topSeller!.wallet)} title="Show this wallet's trades on the chart"><span>Top seller</span><b>{displayName(x.topSeller.wallet, names, short)}</b><i className="down">{signed(x.topSeller.net)}</i></button>}
        </div>}
        {!!x.makersKnown && x.makersKnown < 0.97 && <div className="side-note">Wallet figures cover {Math.round(x.makersKnown * 100)}% of trades — the rest are still being matched to their wallets.</div>}
      </>)}
    </div>
  );
}

// what the card counts, and why the other holders aren't in it (owner 10-23: "be more clear about all of those things")
function profitNote(d: V2Profit) {
  const n = (x: number) => x.toLocaleString();
  let t = `Wallets holding over $0.10, each compared with its own average buy price${d.owned ? ' (buys through routers, bots and smart wallets count for the wallet that got the tokens)' : ''}.`;
  if (d.untracked) {
    const w = d.why;
    if (w) {
      const parts = [w.airdrop && `${n(w.airdrop)} got an airdrop`, w.sent && `${n(w.sent)} were sent tokens by another wallet`, w.share && `${n(w.share)} got a cut of someone else's trade`,
        w.mint && `${n(w.mint)} got tokens when it was created`, w.other && `${n(w.other)} other`].filter(Boolean) as string[];
      t += ` Not counted, because they never bought: ${parts.join(', ')}.`;
    } else t += ` ${n(d.untracked)} more holders are not counted because their buy price can't be matched to them: their tokens came through a smart wallet, bot or router${d.preLaunch ? ', were bought before Sep 16,' : ''} or arrived by transfer.`;
  }
  if (d.coverage != null && d.coverage < 0.97) t += ` ${Math.round(d.coverage * 100)}% of trades matched to wallets so far.`;
  return t;
}
// the server's bands, in words (≤ −50% … > +100% read as noise — owner 10-23)
const PR_BANDS = ['Down over 50%', 'Down 20 to 50%', 'Down under 20%', 'Up under 25%', 'Up 25 to 100%', 'More than 2x'];
export function ProfitCard({ address }: { address: string }) {
  const [d, setD] = useState<V2Profit | null>(null);
  useEffect(() => { let alive = true; setD(null); v2Profit(address).then((r) => { if (alive) setD(r); }).catch(() => { if (alive) setD({ price: null, coverage: null, holders: 0 }); }); return () => { alive = false; }; }, [address]);
  // only once most of the token's trades are matched to wallets (10-21: "100% of 72 buyers in profit" was the last hour's buyers)
  if (!d || !d.holders || d.holders < 10 || d.pctHolders == null || d.coverage == null || d.coverage < 0.5) return null;
  return (
    <div className="panel side-card pr-card">
      <h3>Holder Profitability</h3>
      <div className="pr-big"><b className={d.pctHolders >= 50 ? 'up' : 'down'}>{d.pctHolders.toFixed(0)}%</b><span>of {d.holders.toLocaleString()} holders are in profit right now</span></div>
      <div className="ta-grid">
        <div className="ta-cell"><div className="ta-v">{d.pctSupply != null ? d.pctSupply.toFixed(0) + '%' : '—'}</div><div className="ta-l">Of held tokens in profit</div></div>
        <div className="ta-cell"><div className="ta-v">{d.medianEntry != null ? tprice(d.medianEntry) : '—'}</div><div className="ta-l">Typical buy price</div></div>
        <div className="ta-cell"><div className="ta-v">{d.avgEntry != null ? tprice(d.avgEntry) : '—'}</div><div className="ta-l">Avg buy price</div></div>
        <div className="ta-cell"><div className="ta-v">{d.price != null ? tprice(d.price) : '—'}</div><div className="ta-l">Price now</div></div>
      </div>
      <div className="pr-sub">Holders by how far they are up or down since they bought</div>
      <div className="pr-dist">{d.dist!.map((b, i) => (
        <div key={b.label} className="pr-row"><span>{PR_BANDS[i] ?? b.label}</span><div className="pr-bar"><i className={i < 3 ? 'down' : 'up'} style={{ width: `${Math.max(1, b.pct)}%` }} /></div><em>{b.holders.toLocaleString()}<small>{b.holders && b.pct < 1 ? '<1' : b.pct.toFixed(0)}%</small></em></div>
      ))}</div>
      <div className="side-note">{profitNote(d)}</div>
    </div>
  );
}

export function TopTraders({ address, sym, onMaker }: { address: string; sym: string; onMaker?: (w: string) => void }) {
  const [sort, setSort] = useState<'pnl' | 'volume' | 'loss'>('pnl');
  const [d, setD] = useState<{ rows: V2Trader[]; traders: number; coverage: number | null } | null | false>(null);
  useEffect(() => { let alive = true; setD(null); v2Traders(address, sort).then((r) => { if (alive) setD(r); }).catch(() => { if (alive) setD(false); }); return () => { alive = false; }; }, [address, sort]);
  const names = useNames(d ? d.rows.map((r) => r.wallet) : []);
  return (
    <div className="td-tabbody">
      <div className="txf">{([['pnl', 'Most profit'], ['loss', 'Most loss'], ['volume', 'Most volume']] as const).map(([k, l]) => <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>)}</div>
      {d === null ? <div className="side-note">Ranking every wallet that traded {sym}…</div> : d === false ? <div className="side-note">Top traders are unavailable right now.</div> : !d.rows.length ? <div className="side-note">No wallets matched yet.</div> : (<>
        <div className="txpg-info">{d.traders.toLocaleString()} wallets traded {sym}{d.coverage != null && d.coverage < 0.97 ? ` · ${Math.round(d.coverage * 100)}% of trades matched to wallets so far` : ''} · click a wallet to see its trades on the chart</div>
        <div className="tt-table">
          <div className="tt-row tt-head"><span>#</span><span>Wallet</span><span className="num">Bought</span><span className="num">Sold</span><span className="num hidesm">Avg buy</span><span className="num hidesm">Holding</span><span className="num">P&amp;L</span></div>
          {d.rows.map((r, i) => (
            <div className="tt-row" key={r.wallet}>
              <span className="tt-n">{i + 1}</span>
              <button className="tt-w mono" onClick={() => onMaker?.(r.wallet)} title={r.wallet}>{displayName(r.wallet, names, short)}</button>
              <span className="num mono">{usd(r.bought)}<small>{r.buys} tx</small></span>
              <span className="num mono">{usd(r.sold)}<small>{r.sells} tx</small></span>
              <span className="num mono hidesm">{r.avgBuy != null ? tprice(r.avgBuy) : '—'}</span>
              <span className="num mono hidesm">{r.held > 0 ? compact(r.held) : '—'}</span>
              <span className={`num mono tt-pnl ${r.pnl >= 0 ? 'up' : 'down'}`}>{signed(r.pnl)}{r.roi != null && <small>{r.roi >= 0 ? '+' : ''}{Math.max(-100, Math.min(99999, r.roi)).toFixed(0)}%</small>}</span>
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}

// Live trades: newest first, refreshed every 4 s while you're at the top; filters for side, min $ and one wallet; older pages
// load on demand (any age). Calls onUnavailable when the store can't answer, so the page keeps its old 24h table.
export function LiveTrades({ address, sym, maker, onMaker, onUnavailable }: { address: string; sym: string; maker: string | null; onMaker: (w: string | null) => void; onUnavailable: () => void }) {
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [minIn, setMinIn] = useState('');
  const min = Math.max(0, Number(minIn) || 0);
  const [rows, setRows] = useState<V2HistTrade[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const fresh = useRef(new Set<string>());
  const atTop = useRef(true);
  const key = `${address}|${side}|${min}|${maker ?? ''}`;
  const q = (before?: number, limit = 100) => v2History(address, { before, limit, side: side === 'all' ? undefined : side, minUsd: min || undefined, maker: maker ?? undefined });
  useEffect(() => {
    let alive = true; setRows(null); fresh.current = new Set();
    q().then((r) => { if (!alive) return; setRows(r.trades); setMore(r.hasMore); }).catch(() => { if (alive) onUnavailable(); });
    const t = setInterval(() => {
      if (document.hidden || !atTop.current) return;
      q(undefined, 40).then((r) => {
        if (!alive) return;
        setRows((cur) => {
          if (!cur) return r.trades;
          const have = new Set(cur.map((x) => x.tx + x.logIndex));
          const add = r.trades.filter((x) => !have.has(x.tx + x.logIndex));
          add.forEach((x) => fresh.current.add(x.tx + x.logIndex));
          // makers resolve a few seconds after a trade: refresh the trader column of rows already shown
          const upd = new Map(r.trades.map((x) => [x.tx + x.logIndex, x.trader]));
          const merged = cur.map((x) => (x.trader ? x : { ...x, trader: upd.get(x.tx + x.logIndex) ?? x.trader }));
          return add.length ? [...add, ...merged] : merged;
        });
      }).catch(() => {});
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [key]); // eslint-disable-line
  const loadMore = () => {
    if (!rows?.length) return; setBusy(true);
    q(Math.floor(rows[rows.length - 1].time / 1000)).then((r) => { setRows((cur) => [...(cur || []), ...r.trades]); setMore(r.hasMore); }).catch(() => {}).finally(() => setBusy(false));
  };
  const names = useNames(useMemo(() => [...new Set((rows || []).slice(0, 150).map((r) => r.trader).filter(Boolean))] as string[], [rows]));
  const [, tick] = useState(0); useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(t); }, []);
  return (
    <div className="td-tabbody" onScroll={(e) => { atTop.current = (e.currentTarget as HTMLDivElement).scrollTop < 40; }}>
      <div className="txf lt-f">
        {(['all', 'buy', 'sell'] as const).map((f) => <button key={f} className={side === f ? 'on' : ''} onClick={() => setSide(f)}>{f === 'all' ? 'All' : f === 'buy' ? 'Buys' : 'Sells'}</button>)}
        <label className="lt-min">Min $<input inputMode="decimal" value={minIn} onChange={(e) => setMinIn(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></label>
        {maker && <span className="lt-chip" title={maker}>Wallet {displayName(maker, names, short)}<button onClick={() => onMaker(null)} aria-label="Clear wallet filter">✕</button></span>}
        <span className="lt-live"><i />Live</span>
      </div>
      {rows == null ? <div className="side-note">Loading trades…</div> : !rows.length ? <div className="side-note">No trades match.</div> : (
        <div className="tr-table">
          <div className="tr-row tr-head"><span>Age</span><span>Type</span><span className="num">USD</span><span className="num">{sym}</span><span className="num">Price</span><span>Maker</span><span className="num tx">Tx</span></div>
          {rows.map((s) => (
            <div className={`tr-row${fresh.current.has(s.tx + s.logIndex) ? ' lt-new' : ''}`} key={s.tx + s.logIndex}>
              <span className="tr-age" title={new Date(s.time).toLocaleString()}>{ago(s.time)}</span>
              <span className={`tr-side ${s.side}`}>{s.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span className={`num mono tr-usd ${s.side}`}>{usd(s.usd)}</span>
              <span className="num mono">{compact(s.amount)}</span>
              <span className="num mono tr-px">{tprice(s.price)}</span>
              {s.trader ? <button className="tr-mk mono lt-mk" onClick={() => onMaker(s.trader!)} title={`${s.trader} — show this wallet's trades on the chart`}>{displayName(s.trader, names, short)}</button> : <span className="tr-mk mono">…</span>}
              <a className="tr-tx num tx" href={`https://explorer.arc.io/tx/${s.tx}`} target="_blank" rel="noreferrer"><IconExternal className="i" /></a>
            </div>
          ))}
        </div>
      )}
      {more && <div className="tr-more"><button className="btn ghost" disabled={busy} onClick={loadMore}>{busy ? 'Loading…' : 'Load older trades'}</button></div>}
    </div>
  );
}
