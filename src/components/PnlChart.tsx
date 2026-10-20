import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, BaselineSeries, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { v2Bars, type V2WalletSwap } from '../lib/v2';
import { pnlSeries } from '../lib/pnl';
import { usd } from '../lib/arc';

// The wallet's total P&L over time (Portfolio): each day = realized so far + open positions marked to that day's close
// (daily candles from the swap store). Green above zero, red below; the dotted line is the realized part alone.
const RANGES = [{ k: 7, l: '7D' }, { k: 30, l: '30D' }, { k: 90, l: '90D' }, { k: 0, l: 'ALL' }];
export function PnlChart({ swaps, nowPx }: { swaps: V2WalletSwap[]; nowPx: Record<string, number> }) {
  const [closes, setCloses] = useState<Record<string, Map<number, number>> | null>(null);
  const [range, setRange] = useState(0);
  const [hover, setHover] = useState<{ time: number; value: number; realized: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const totRef = useRef<ISeriesApi<'Baseline'> | null>(null);
  const realRef = useRef<ISeriesApi<'Line'> | null>(null);

  // daily closes for the tokens that carry the most volume in this wallet (cap 16 requests)
  const tokens = useMemo(() => {
    const v = new Map<string, number>();
    for (const s of swaps) v.set(s.token.toLowerCase(), (v.get(s.token.toLowerCase()) || 0) + s.usd);
    return [...v.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t);
  }, [swaps]);
  useEffect(() => {
    let alive = true; setCloses(null);
    Promise.all(tokens.map((t) => v2Bars(t, '1d', 1000).then((r) => [t, new Map(r.candles.map((c) => [c.time, c.close]))] as const).catch(() => [t, new Map<number, number>()] as const)))
      .then((list) => { if (alive) setCloses(Object.fromEntries(list)); });
    return () => { alive = false; };
  }, [tokens.join(',')]); // eslint-disable-line

  const series = useMemo(() => (closes ? pnlSeries(swaps, closes, nowPx) : null), [swaps, closes, nowPx]);
  const shown = useMemo(() => (series && range ? series.slice(-range) : series), [series, range]);

  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth, height: 220,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8f8478', fontFamily: 'JetBrains Mono, monospace' },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.08)' }, timeScale: { borderColor: 'rgba(255,255,255,.08)' },
      handleScroll: false, handleScale: false,
      localization: { priceFormatter: (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}` },
    });
    totRef.current = chart.addSeries(BaselineSeries, { baseValue: { type: 'price', price: 0 }, topLineColor: '#5ad18a', topFillColor1: 'rgba(90,209,138,.28)', topFillColor2: 'rgba(90,209,138,.02)',
      bottomLineColor: '#ff5a5a', bottomFillColor1: 'rgba(255,90,90,.02)', bottomFillColor2: 'rgba(255,90,90,.28)', lineWidth: 2 });
    realRef.current = chart.addSeries(LineSeries, { color: 'rgba(255,210,122,.8)', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chart.subscribeCrosshairMove((p) => {
      const v = p.time != null && totRef.current ? (p.seriesData.get(totRef.current) as any) : null;
      const r = p.time != null && realRef.current ? (p.seriesData.get(realRef.current) as any) : null;
      setHover(v ? { time: p.time as number, value: v.value, realized: r?.value ?? 0 } : null);
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })); ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, []);
  useEffect(() => {
    if (!shown || !totRef.current || !realRef.current) return;
    totRef.current.setData(shown.map((p) => ({ time: p.time as Time, value: p.value })));
    realRef.current.setData(shown.map((p) => ({ time: p.time as Time, value: p.realized })));
    chartRef.current?.timeScale().fitContent();
  }, [shown]);

  const last = shown && shown.length ? shown[shown.length - 1] : null, k = hover ?? last;
  const first = shown && shown.length ? shown[0] : null;
  const delta = last && first && range ? last.value - first.value : null;
  return (
    <div className="panel pnl-chart">
      <div className="pnl-chart-h">
        <div>
          <div className="pnl-chart-l">P&amp;L over time{k ? ` · ${new Date(k.time * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })}` : ''}</div>
          {k && <div className={`pnl-chart-v ${k.value >= 0 ? 'up' : 'down'}`}>{k.value >= 0 ? '+' : '−'}{usd(Math.abs(k.value))}
            <span>realized {k.realized >= 0 ? '+' : '−'}{usd(Math.abs(k.realized))}</span>
            {delta != null && !hover && <span className={delta >= 0 ? 'up' : 'down'}>{delta >= 0 ? '+' : '−'}{usd(Math.abs(delta))} in {RANGES.find((r) => r.k === range)?.l}</span>}</div>}
        </div>
        <div className="chart-seg">{RANGES.map((r) => <button key={r.k} className={range === r.k ? 'on' : ''} onClick={() => setRange(r.k)}>{r.l}</button>)}</div>
      </div>
      <div ref={boxRef} className="pnl-chart-box" />
      {!series && <div className="side-note">Building your P&amp;L history…</div>}
      <div className="chart-src">Each day = realized profit so far + what you held, marked to that day's close (UTC). Dotted = realized only.</div>
    </div>
  );
}
