import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, ColorType, LineStyle, CrosshairMode, PriceScaleMode, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type Logical, type MouseEventParams } from 'lightweight-charts';
import { fetchWarpCandles, type Candle } from '../lib/warp';
import { fetchPoolCandles as fetchPoolCandlesInTab, usd, compact, type WalletTrade } from '../lib/arc';
import { v2Enabled, v2Candles, v2Bars, type V2Bars } from '../lib/v2';
import { sma, ema, bollinger, vwap, rsi, macd, heikinAshi } from '../lib/indicators';
import { Drawings, TOOL_POINTS, loadDrawings, saveDrawings, type Tool, type Drawing } from '../lib/chartDrawings';

// TradingView-style chart for an Arc token (lightweight-charts v5).
// Data: the swap store (server/swap-indexer.ts keeps every swap of every USDC pool on Arc since the first Uniswap block) → real
// history on every timeframe, older candles load as you scroll left, the newest candle updates every 5 s. If the store is
// unreachable the chart falls back to the old per-request pool scan (~5 days), and Warp's candles for a curve-only token.
// Toolbar: timeframes · Candles/Heikin-Ashi/Bars/Line/Area · Price/MCap · Linear/Log/% · indicators (MA, EMA, VWAP, Bollinger,
// Volume, RSI and MACD in their own panes) · UTC/local time · fullscreen · snapshot. Left rail: drawing tools, kept per token.
const RESES = [{ k: '1m', l: '1m', s: 60 }, { k: '5m', l: '5m', s: 300 }, { k: '15m', l: '15m', s: 900 }, { k: '1h', l: '1H', s: 3600 }, { k: '4h', l: '4H', s: 14400 }, { k: '1d', l: '1D', s: 86400 }, { k: '1w', l: '1W', s: 604800 }];
const SEC: Record<string, number> = Object.fromEntries(RESES.map((r) => [r.k, r.s]));
// the old scan's windows, for the fallback path only (it can't reach further back than ~5 days)
const LEGACY: Record<string, { sec: number; look: number; warp: string }> = {
  '1m': { sec: 60, look: 6 * 3600, warp: '1m' }, '5m': { sec: 300, look: 24 * 3600, warp: '5m' }, '15m': { sec: 900, look: 3 * 86400, warp: '5m' },
  '1h': { sec: 3600, look: 3 * 86400, warp: '1h' }, '4h': { sec: 14400, look: 12 * 86400, warp: '1h' }, '1d': { sec: 86400, look: 60 * 86400, warp: '1h' }, '1w': { sec: 43200, look: 3650 * 86400, warp: '1h' },
};
const legacyFetch = (a: string, dec: number, sec: number, look: number) =>
  v2Enabled ? v2Candles(a, sec, look).catch(() => fetchPoolCandlesInTab(a, dec, sec, look)) : fetchPoolCandlesInTab(a, dec, sec, look);
function rebucket(cs: Candle[], sec: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of cs) {
    const b = Math.floor(c.time / sec) * sec, cur = m.get(b);
    if (!cur) m.set(b, { ...c, time: b }); else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume = (cur.volume || 0) + (c.volume || 0); }
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number; trades?: number };
type CType = 'candles' | 'heikin' | 'bars' | 'line' | 'area';
type Scale = 'linear' | 'log' | 'pct';
const IND = [
  { k: 'vol', l: 'Volume', pane: 0 }, { k: 'ma20', l: 'MA 20', pane: 0 }, { k: 'ma50', l: 'MA 50', pane: 0 }, { k: 'ema9', l: 'EMA 9', pane: 0 },
  { k: 'ema21', l: 'EMA 21', pane: 0 }, { k: 'vwap', l: 'VWAP', pane: 0 }, { k: 'bb', l: 'Bollinger 20,2', pane: 0 }, { k: 'rsi', l: 'RSI 14', pane: 1 }, { k: 'macd', l: 'MACD 12,26,9', pane: 1 },
] as const;
const IND_COL: Record<string, string> = { ma20: '#f5c451', ma50: '#6aa9ff', ema9: '#ff7ad9', ema21: '#4fd1c5', vwap: '#c9a0ff', bb: 'rgba(160,170,190,.75)', rsi: '#c9a0ff', macd: '#6aa9ff', signal: '#ff9a3c' };
const UPC = '#5ad18a', DNC = '#ff5a5a';
const TOOLS: { k: Tool; l: string; tip: string }[] = [
  { k: 'pointer', l: '↖', tip: 'Pointer — click a drawing to select it (Delete removes it)' }, { k: 'hline', l: '―', tip: 'Horizontal line (1 click)' },
  { k: 'trend', l: '╱', tip: 'Trend line (2 clicks)' }, { k: 'ray', l: '↗', tip: 'Ray (2 clicks)' }, { k: 'rect', l: '▭', tip: 'Rectangle (2 clicks)' },
  { k: 'fib', l: 'ƒ', tip: 'Fibonacci retracement (2 clicks: from, to)' }, { k: 'measure', l: '⇕', tip: 'Measure — % change, $ change and time between 2 clicks' },
];
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
// Axis / crosshair prices need more digits than the page's tprice (which rounds $0.009453 and $0.009447 to the same "$0.0095"):
// 5 significant digits, leading zeros compressed into a subscript like tprice does ($0.0₅12345).
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const priceFmt = (p: number) => {
  if (!isFinite(p) || Math.abs(p) < 1e-18) return '$0';
  const a = Math.abs(p), sgn = p < 0 ? '-' : '';
  if (a >= 1000) return sgn + '$' + a.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return sgn + '$' + a.toFixed(4);
  const zeros = Math.max(0, -Math.floor(Math.log10(a)) - 1);
  const digits = Math.round(a * 10 ** (zeros + 5)).toString().slice(0, 5).replace(/(\d)0+$/, '$1');
  return sgn + (zeros >= 4 ? `$0.0${String(zeros).split('').map((d) => SUB[+d]).join('')}${digits}` : `$0.${'0'.repeat(zeros)}${digits}`);
};
const mcapFmt = (p: number) => (!isFinite(p) ? '—' : '$' + compact(p));

export function PriceChart({ address, symbol, decimals, priceScale = 1, change24h, trades, supply }: { address: string; symbol?: string; decimals?: number; priceScale?: number; change24h?: number | null; trades?: WalletTrade[] | null; supply?: number | null }) {
  const [res, setRes] = useState(() => (SEC[lsGet('statera-chart-res', '5m')] ? lsGet('statera-chart-res', '5m') : '5m'));
  const [ctype, setCtype] = useState<CType>(() => lsGet('statera-chart-type', 'candles') as CType);
  const [mode, setMode] = useState<'price' | 'mcap'>('price');
  const [scale, setScale] = useState<Scale>('linear');
  const [ind, setInd] = useState<Set<string>>(() => new Set(lsGet('statera-chart-ind', 'vol').split(',').filter(Boolean)));
  const [utc, setUtc] = useState(() => lsGet('statera-chart-tz', 'local') === 'utc');
  const [indOpen, setIndOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('pointer');
  const [drawings, setDrawings] = useState<Drawing[]>(() => loadDrawings(address));
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [meta, setMeta] = useState<{ source: 'store' | 'legacy' | 'warp' | null; hasMore: boolean; pools: string[]; backTs: number | null }>({ source: null, hasMore: false, pools: [], backTs: null });
  const [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false);
  const [hover, setHover] = useState<Bar | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<any> | null>(null);
  const mainTypeRef = useRef<CType | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const indRef = useRef<ISeriesApi<any>[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawRef = useRef<Drawings>(new Drawings());
  const barsRef = useRef<Bar[]>([]);
  const metaRef = useRef(meta); metaRef.current = meta;
  const olderRef = useRef(false);
  const fitNext = useRef(true);    // next data push resets the view (new token / timeframe)
  const toolRef = useRef<Tool>('pointer'); toolRef.current = tool;
  const reqId = useRef(0);

  const mult = mode === 'mcap' && supply && supply > 0 ? supply : 1;
  const fmt = mult === 1 ? priceFmt : mcapFmt;
  const sec = SEC[res] ?? 300;

  useEffect(() => { lsSet('statera-chart-res', res); }, [res]);
  useEffect(() => { lsSet('statera-chart-type', ctype); }, [ctype]);
  useEffect(() => { lsSet('statera-chart-ind', [...ind].join(',')); }, [ind]);
  useEffect(() => { lsSet('statera-chart-tz', utc ? 'utc' : 'local'); }, [utc]);
  useEffect(() => { setDrawings(loadDrawings(address)); setSelected(null); setMode('price'); }, [address]);
  useEffect(() => { saveDrawings(address, drawings); }, [address, drawings]);

  // ── data: first window ─────────────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true); fitNext.current = true;
    (async () => {
      let got: Bar[] = [], m: typeof meta = { source: null, hasMore: false, pools: [], backTs: null };
      if (v2Enabled) {
        try {
          const r: V2Bars = await v2Bars(address, res, 1000);
          if (r.candles.length) { got = r.candles; m = { source: 'store', hasMore: r.hasMore, pools: r.pools.map((p) => p.venue), backTs: r.coverage?.backTs ?? null }; }
        } catch { /* store not reachable → the old scan below */ }
      }
      if (!got.length) {
        const cfg = LEGACY[res] ?? LEGACY['5m'];
        let c = await legacyFetch(address, decimals ?? 18, cfg.sec, cfg.look).catch(() => [] as Candle[]);
        let src: 'legacy' | 'warp' = 'legacy';
        if (!c.length) {
          let w = await fetchWarpCandles(address, cfg.warp).catch(() => [] as Candle[]);
          if (w.length && priceScale && priceScale !== 1) w = w.map((k) => ({ ...k, open: k.open * priceScale, high: k.high * priceScale, low: k.low * priceScale, close: k.close * priceScale }));
          c = w.length ? rebucket(w, cfg.sec) : w; src = 'warp';
        }
        got = c.map((k) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0 }));
        m = { source: got.length ? src : null, hasMore: false, pools: [], backTs: null };
      }
      if (id !== reqId.current) return;
      barsRef.current = got; setBars(got); setMeta(m); setLoading(false);
    })();
  }, [address, res, priceScale]); // eslint-disable-line

  // ── data: the newest candles every 5 s (store only), merged into the end of the series ─────────────────────────────────
  useEffect(() => {
    if (meta.source !== 'store') return;
    const t = setInterval(() => {
      if (document.hidden) return;
      const id = reqId.current;
      v2Bars(address, res, 3).then((r) => {
        if (id !== reqId.current || !r.candles.length) return;
        const cur = barsRef.current.slice();
        for (const b of r.candles) {
          const last = cur[cur.length - 1];
          if (!last || b.time > last.time) cur.push(b); else if (b.time === last.time) cur[cur.length - 1] = b;
          else { const i = cur.findIndex((x) => x.time === b.time); if (i >= 0) cur[i] = b; }
        }
        barsRef.current = cur; setBars(cur);
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [address, res, meta.source]);

  // ── data: older candles when the view nears the left edge ───────────────────────────────────────────────────────────
  const loadOlder = useCallback(() => {
    const cur = barsRef.current;
    if (olderRef.current || !metaRef.current.hasMore || metaRef.current.source !== 'store' || !cur.length) return;
    olderRef.current = true; setOlder(true);
    const id = reqId.current;
    v2Bars(address, res, 1000, cur[0].time).then((r) => {
      if (id !== reqId.current) return;
      const add = r.candles.filter((b) => b.time < cur[0].time);
      const chart = chartRef.current, range = chart?.timeScale().getVisibleLogicalRange();
      const next = [...add, ...barsRef.current];
      barsRef.current = next; setBars(next); setMeta((m) => ({ ...m, hasMore: r.hasMore && add.length > 0 }));
      // keep the view on the same candles (their logical index moved right by the number prepended)
      if (chart && range && add.length) requestAnimationFrame(() => chart.timeScale().setVisibleLogicalRange({ from: range.from + add.length, to: range.to + add.length }));
    }).catch(() => {}).finally(() => { olderRef.current = false; setOlder(false); });
  }, [address, res]);

  // ── chart: created once ───────────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight || 380,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8f8478', fontFamily: 'JetBrains Mono, monospace', panes: { separatorColor: 'rgba(255,255,255,.08)', separatorHoverColor: 'rgba(255,122,26,.25)' } },
      grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal, horzLine: { labelBackgroundColor: '#ff5a5a' }, vertLine: { labelBackgroundColor: '#333', style: LineStyle.Dashed } },
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight || 380 }));
    ro.observe(el);
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 40) loadOlderRef.current(); });
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; mainRef.current = null; mainTypeRef.current = null; volRef.current = null; indRef.current = []; markersRef.current = null; };
  }, []);
  const loadOlderRef = useRef(loadOlder); loadOlderRef.current = loadOlder;

  // time formatting (UTC or the viewer's local time) on the axis and the crosshair label
  useEffect(() => {
    const d = (t: Time) => new Date((t as number) * 1000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const parts = (t: Time) => { const x = d(t); return utc ? { Y: x.getUTCFullYear(), M: x.getUTCMonth(), D: x.getUTCDate(), h: x.getUTCHours(), m: x.getUTCMinutes() } : { Y: x.getFullYear(), M: x.getMonth(), D: x.getDate(), h: x.getHours(), m: x.getMinutes() }; };
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    chartRef.current?.applyOptions({
      localization: { timeFormatter: (t: Time) => { const q = parts(t); return `${q.D} ${MON[q.M]} '${String(q.Y).slice(2)} ${p2(q.h)}:${p2(q.m)}${utc ? ' UTC' : ''}`; } },
      timeScale: { tickMarkFormatter: (t: Time, type: number) => { const q = parts(t); return type === 0 ? String(q.Y) : type === 1 ? MON[q.M] : type === 2 ? String(q.D) : `${p2(q.h)}:${p2(q.m)}`; } },
    });
  }, [utc, fmt]);

  // ── series: main (by chart type) + volume + indicators, rebuilt when their set changes ──────────────────────────────
  const display = useMemo(() => {
    if (!bars) return null;
    const b = mult === 1 ? bars : bars.map((k) => ({ ...k, open: k.open * mult, high: k.high * mult, low: k.low * mult, close: k.close * mult }));
    return ctype === 'heikin' ? (heikinAshi(b) as Bar[]) : b;
  }, [bars, mult, ctype]);

  useEffect(() => {
    const chart = chartRef.current; if (!chart || !display) return;
    if (mainTypeRef.current !== ctype || !mainRef.current) {
      if (mainRef.current) { mainRef.current.detachPrimitive(drawRef.current); markersRef.current?.detach(); chart.removeSeries(mainRef.current); }
      const ohlc = { upColor: UPC, downColor: DNC, borderVisible: false, wickUpColor: UPC, wickDownColor: DNC };
      mainRef.current = ctype === 'line' ? chart.addSeries(LineSeries, { color: '#ff7a1a', lineWidth: 2 })
        : ctype === 'area' ? chart.addSeries(AreaSeries, { lineColor: '#ff7a1a', lineWidth: 2, topColor: 'rgba(255,122,26,.28)', bottomColor: 'rgba(255,122,26,0)' })
        : ctype === 'bars' ? chart.addSeries(BarSeries, { upColor: UPC, downColor: DNC, thinBars: false })
        : chart.addSeries(CandlestickSeries, ohlc);
      mainTypeRef.current = ctype;
      mainRef.current.attachPrimitive(drawRef.current);
      markersRef.current = createSeriesMarkers(mainRef.current, []);
      fitNext.current = true;
    }
    const main = mainRef.current!;
    const max = display.reduce((m, c) => Math.max(m, c.high), 0);
    // tick size ~5 significant digits below the top price (a 1e-9 token needs a far finer step than 1e-10 ⇢ "precision 10")
    const minMove = mult !== 1 ? 1 : max > 0 ? Math.pow(10, Math.floor(Math.log10(max)) - 5) : 1e-8;
    main.applyOptions({ priceFormat: { type: 'custom', formatter: fmt, minMove } });
    main.setData((ctype === 'line' || ctype === 'area' ? display.map((c) => ({ time: c.time as Time, value: c.close })) : display.map((c) => ({ ...c, time: c.time as Time }))) as any);

    // volume (overlay at the bottom of the price pane)
    if (ind.has('vol')) {
      if (!volRef.current) { volRef.current = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 0); chart.priceScale('vol', 0).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); }
      volRef.current.setData(display.map((c) => ({ time: c.time as Time, value: c.volume ?? 0, color: c.close >= c.open ? 'rgba(90,209,138,.35)' : 'rgba(255,90,90,.35)' })));
    } else if (volRef.current) { chart.removeSeries(volRef.current); volRef.current = null; }

    // indicators: drop and re-add (cheap; keeps pane order right when one is switched off)
    for (const s of indRef.current) chart.removeSeries(s);
    indRef.current = [];
    const closes = display.map((c) => c.close), times = display.map((c) => c.time as Time);
    const line = (vals: (number | null)[], color: string, pane = 0, opts: Record<string, unknown> = {}) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...(pane === 0 ? { priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-18 } } : {}), ...opts }, pane);
      s.setData(vals.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v })) as any); indRef.current.push(s); return s;
    };
    if (ind.has('ma20')) line(sma(closes, 20), IND_COL.ma20);
    if (ind.has('ma50')) line(sma(closes, 50), IND_COL.ma50);
    if (ind.has('ema9')) line(ema(closes, 9), IND_COL.ema9);
    if (ind.has('ema21')) line(ema(closes, 21), IND_COL.ema21);
    if (ind.has('vwap')) line(vwap(display), IND_COL.vwap, 0, { lineStyle: LineStyle.Dotted, lineWidth: 2 });
    if (ind.has('bb')) { const b = bollinger(closes); line(b.up, IND_COL.bb); line(b.mid, IND_COL.bb, 0, { lineStyle: LineStyle.Dashed }); line(b.lo, IND_COL.bb); }
    let pane = 1;
    if (ind.has('rsi')) {
      const s = line(rsi(closes), IND_COL.rsi, pane, { lastValueVisible: true, priceFormat: { type: 'custom', formatter: (v: number) => v.toFixed(0), minMove: 0.1 } });
      s.createPriceLine({ price: 70, color: 'rgba(255,90,90,.45)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      s.createPriceLine({ price: 30, color: 'rgba(90,209,138,.45)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      pane++;
    }
    if (ind.has('macd')) {
      const m = macd(closes), pf = { type: 'custom' as const, formatter: (v: number) => (v === 0 ? '0' : Math.abs(v) >= 1000 ? compact(v) : v.toPrecision(2)), minMove: 1e-12 };
      const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: pf }, pane);
      h.setData(m.hist.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v, color: v >= 0 ? 'rgba(90,209,138,.55)' : 'rgba(255,90,90,.55)' })) as any);
      indRef.current.push(h);
      line(m.macd, IND_COL.macd, pane, { priceFormat: pf }); line(m.signal, IND_COL.signal, pane, { priceFormat: pf });
      pane++;
    }
    const panes = chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 3.2 : 1));

    // first draw of a token / timeframe: open on the newest ~120 candles (older ones are a scroll away and load on demand)
    if (fitNext.current) {
      fitNext.current = false;
      const SHOW = window.innerWidth <= 640 ? 60 : 120;
      if (display.length > SHOW) chart.timeScale().setVisibleLogicalRange({ from: display.length - SHOW, to: display.length + 4 } as { from: Logical; to: Logical });
      else chart.timeScale().fitContent();
    }
  }, [display, ctype, ind, mult, fmt]);

  // price scale mode
  useEffect(() => { chartRef.current?.priceScale('right', 0).applyOptions({ mode: scale === 'log' ? PriceScaleMode.Logarithmic : scale === 'pct' ? PriceScaleMode.Percentage : PriceScaleMode.Normal }); }, [scale, display]);

  // the box grows with the indicator panes (and fills the screen in fullscreen)
  const extraPanes = (ind.has('rsi') ? 1 : 0) + (ind.has('macd') ? 1 : 0);
  const [vh, setVh] = useState(typeof window !== 'undefined' ? window.innerHeight : 800);
  useEffect(() => { const f = () => setVh(window.innerHeight); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const phone = typeof window !== 'undefined' && window.innerWidth <= 640;
  const boxH = full ? Math.max(300, vh - 130) : (phone ? 280 : 400) + extraPanes * (phone ? 90 : 120);

  // ── wallet markers: the connected wallet's buys (B, below) and sells (S, above) on the candle they happened in ────────
  useEffect(() => {
    if (!markersRef.current || !display || !display.length) return;
    const first = display[0].time, lastT = display[display.length - 1].time + sec;
    const bucket = (ts: number) => (sec === 604800 ? Math.floor((ts - 4 * 86400) / sec) * sec + 4 * 86400 : Math.floor(ts / sec) * sec);
    const marks = (trades || []).map((t) => ({ ...t, b: bucket(t.ts / 1000) })).filter((t) => t.b >= first && t.b < lastT).sort((a, b) => a.b - b.b)
      .map((t) => ({ time: t.b as Time, position: t.side === 'buy' ? 'belowBar' as const : 'aboveBar' as const, color: t.side === 'buy' ? '#4ecb71' : '#ff5a3c',
        shape: t.side === 'buy' ? 'arrowUp' as const : 'arrowDown' as const, text: `${t.side === 'buy' ? 'B' : 'S'} ${usd(t.usd)}` }));
    markersRef.current.setMarkers(marks);
  }, [trades, display, sec, ctype]);

  // ── drawings: time ↔ x over the loaded bars (interpolated inside, extrapolated past either end) ─────────────────────
  const timeToLogical = (t: number): number | null => {
    const b = barsRef.current; if (!b.length) return null;
    if (t <= b[0].time) return (t - b[0].time) / sec;
    const n = b.length - 1;
    if (t >= b[n].time) return n + (t - b[n].time) / sec;
    let lo = 0, hi = n; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (b[mid].time <= t) lo = mid; else hi = mid; }
    return lo + (t - b[lo].time) / Math.max(1, b[hi].time - b[lo].time);
  };
  const logicalToTime = (l: number): number | null => {
    const b = barsRef.current; if (!b.length) return null;
    const i = Math.floor(l), f = l - i;
    if (i < 0) return b[0].time + l * sec;
    if (i >= b.length - 1) return b[b.length - 1].time + (l - (b.length - 1)) * sec;
    return b[i].time + f * (b[i + 1].time - b[i].time);
  };
  useEffect(() => {
    const d = drawRef.current;
    d.items = drawings; d.selected = selected; d.scale = mult; d.fmt = fmt;
    d.timeToX = (t) => { const l = timeToLogical(t); if (l == null) return null; const x = chartRef.current?.timeScale().logicalToCoordinate(l as Logical); return x == null ? null : x; };
    d.redraw();
  }); // every render: cheap, keeps the primitive in sync with state

  const ptAt = (p: { point?: { x: number; y: number }; paneIndex?: number }): { t: number; p: number } | null => {
    if (!p.point || (p.paneIndex ?? 0) !== 0 || !mainRef.current) return null;
    const l = chartRef.current?.timeScale().coordinateToLogical(p.point.x); const price = mainRef.current.coordinateToPrice(p.point.y);
    if (l == null || price == null) return null;
    const t = logicalToTime(l); return t == null ? null : { t, p: (price as number) / (mult || 1) };
  };
  const ptAtRef = useRef(ptAt); ptAtRef.current = ptAt;
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const onClick = (p: { point?: { x: number; y: number }; paneIndex?: number }) => {
      const d = drawRef.current, tl = toolRef.current;
      if (tl === 'pointer') { if (p.point && (p.paneIndex ?? 0) === 0) setSelected(d.hit(p.point.x, p.point.y)); return; }
      const pt = ptAtRef.current(p); if (!pt) return;
      if (!d.draft) {
        d.draft = { id: Math.random().toString(36).slice(2), tool: tl as Drawing['tool'], pts: [pt, pt] };
        if (TOOL_POINTS[tl] === 1) { const done = { ...d.draft, pts: [pt] }; d.draft = null; setDrawings((x) => [...x, done]); setTool('pointer'); }
        d.redraw(); return;
      }
      const done = { ...d.draft, pts: [d.draft.pts[0], pt] }; d.draft = null;
      setDrawings((x) => [...x, done]); setTool('pointer');
    };
    const onMove = (p: MouseEventParams<Time>) => {
      const bar = p.time != null && mainRef.current ? (p.seriesData.get(mainRef.current) as any) : null;
      if (bar) { const v = volRef.current ? (p.seriesData.get(volRef.current) as any)?.value : undefined; const src = barsRef.current.find((b) => b.time === (p.time as number));
        setHover(bar.open != null ? { time: p.time as number, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: v ?? (src?.volume ?? 0) * 1, trades: src?.trades } : { time: p.time as number, open: bar.value, high: bar.value, low: bar.value, close: bar.value, volume: src?.volume ?? 0, trades: src?.trades }); }
      else setHover(null);
      const d = drawRef.current;
      if (d.draft) { const pt = ptAtRef.current(p); if (pt) { d.draft.pts[1] = pt; d.redraw(); } }
    };
    // ⛔ the chart's own subscribeClick drops a second click that follows the first within its double-click window (a 2-point
    // drawing never finished) — clicks are read from the DOM instead and mapped to the price pane by hand
    const el = boxRef.current!;
    const domClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const h0 = chart.paneSize(0).height, w0 = chart.paneSize(0).width;
      if (x < 0 || x > w0 || y < 0 || y > h0) return; // outside the price pane (price axis, time axis, indicator panes)
      onClick({ point: { x, y }, paneIndex: 0 });
    };
    el.addEventListener('click', domClick); chart.subscribeCrosshairMove(onMove);
    return () => { el.removeEventListener('click', domClick); chart.unsubscribeCrosshairMove(onMove); };
  }, []);
  useEffect(() => { const d = drawRef.current; if (d.draft && d.draft.tool !== tool) { d.draft = null; d.redraw(); } }, [tool]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable]')) return;
      if (e.key === 'Escape') { drawRef.current.draft = null; setTool('pointer'); setSelected(null); drawRef.current.redraw(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { setDrawings((x) => x.filter((d) => d.id !== selected)); setSelected(null); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [selected]);
  // the chart scrolls/zooms normally except while a drawing tool is armed (a drag would pan instead of placing points)
  useEffect(() => { chartRef.current?.applyOptions({ handleScroll: tool === 'pointer', handleScale: tool === 'pointer' }); }, [tool]);

  // ── fullscreen + snapshot ─────────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => { const f = () => setFull(document.fullscreenElement === cardRef.current); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else cardRef.current?.requestFullscreen?.().catch(() => {}); };
  const snapshot = () => {
    const c = chartRef.current?.takeScreenshot(); if (!c) return;
    c.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${symbol || 'token'}-${res}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
  };

  const empty = !loading && bars != null && bars.length === 0;
  const lastBar = display && display.length ? display[display.length - 1] : null;
  const chg = change24h != null && isFinite(change24h) && Math.abs(change24h) < 1e5 ? change24h : null;
  const k = hover ?? lastBar;
  const kChg = k && k.open > 0 ? ((k.close - k.open) / k.open) * 100 : null;
  const toggleInd = (key: string) => setInd((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const since = meta.backTs && meta.source === 'store' ? new Date(meta.backTs * 1000).toISOString().slice(0, 10) : null;

  return (
    <div className={`chart-card panel${full ? ' chart-full' : ''}`} ref={cardRef}>
      <div className="chart-head">
        <div className="chart-title">
          {symbol ? `$${symbol}` : 'Price'} <span className="chart-usdc">/ USDC{mode === 'mcap' ? ' · market cap' : ''}</span>
          {lastBar != null && <span className="chart-last">{fmt(lastBar.close)}</span>}
          {chg != null && <span className={`chart-chg ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}% <span className="chart-chg-l">24h</span></span>}
        </div>
        <div className="chart-tfs">
          {RESES.map((t) => <button key={t.k} className={res === t.k ? 'on' : ''} onClick={() => setRes(t.k)}>{t.l}</button>)}
        </div>
      </div>
      <div className="chart-tools">
        <div className="chart-seg">
          {([['candles', 'Candles'], ['heikin', 'Heikin'], ['bars', 'Bars'], ['line', 'Line'], ['area', 'Area']] as [CType, string][]).map(([v, l]) =>
            <button key={v} className={ctype === v ? 'on' : ''} onClick={() => setCtype(v)} title={v === 'heikin' ? 'Heikin-Ashi candles (smoothed trend)' : undefined}>{l}</button>)}
        </div>
        <div className="chart-seg">
          <button className={mode === 'price' ? 'on' : ''} onClick={() => setMode('price')}>Price</button>
          <button className={mode === 'mcap' ? 'on' : ''} onClick={() => setMode('mcap')} disabled={!supply} title={supply ? 'Market cap = price × supply' : 'Supply unknown'}>MCap</button>
        </div>
        <div className="chart-seg">
          {([['linear', 'Lin'], ['log', 'Log'], ['pct', '%']] as [Scale, string][]).map(([v, l]) => <button key={v} className={scale === v ? 'on' : ''} onClick={() => setScale(v)}>{l}</button>)}
        </div>
        <div className="chart-ind">
          <button className={`chart-btn${indOpen ? ' on' : ''}`} onClick={() => setIndOpen((o) => !o)}>ƒx Indicators{ind.size ? ` · ${ind.size}` : ''}</button>
          {indOpen && (
            <div className="chart-ind-pop" onMouseLeave={() => setIndOpen(false)}>
              {IND.map((i) => (
                <label key={i.k}><input type="checkbox" checked={ind.has(i.k)} onChange={() => toggleInd(i.k)} />
                  <i style={{ background: IND_COL[i.k] || 'rgba(255,255,255,.4)' }} />{i.l}{i.pane ? <em>own pane</em> : null}</label>
              ))}
            </div>
          )}
        </div>
        <div className="chart-tools-r">
          <button className="chart-btn" onClick={() => setUtc((u) => !u)} title="Time zone of the axis and crosshair">{utc ? 'UTC' : 'Local'}</button>
          <button className="chart-btn" onClick={snapshot} title="Download the chart as an image">⎙</button>
          <button className="chart-btn" onClick={toggleFull} title={full ? 'Exit fullscreen' : 'Fullscreen'}>{full ? '✕' : '⤢'}</button>
        </div>
      </div>
      <div className="chart-body">
        <div className="chart-rail" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map((t) => <button key={t.k} className={tool === t.k ? 'on' : ''} title={t.tip} onClick={() => setTool(t.k)}>{t.l}</button>)}
          <span className="chart-rail-sep" />
          <button title="Undo the last drawing" disabled={!drawings.length} onClick={() => setDrawings((x) => x.slice(0, -1))}>↶</button>
          <button title={selected ? 'Delete the selected drawing' : 'Delete all drawings'} disabled={!drawings.length}
            onClick={() => { if (selected) { setDrawings((x) => x.filter((d) => d.id !== selected)); setSelected(null); } else if (confirm('Delete all drawings on this chart?')) setDrawings([]); }}>🗑</button>
        </div>
        <div className="chart-box-wrap">
          {k && (
            <div className="chart-ohlc">
              <span>O <b>{fmt(k.open)}</b></span><span>H <b>{fmt(k.high)}</b></span><span>L <b>{fmt(k.low)}</b></span>
              <span>C <b className={k.close >= k.open ? 'up' : 'down'}>{fmt(k.close)}</b></span>
              {kChg != null && <span className={kChg >= 0 ? 'up' : 'down'}>{kChg >= 0 ? '+' : ''}{kChg.toFixed(2)}%</span>}
              <span>Vol <b>{usd(k.volume ?? 0)}</b></span>
              {k.trades != null && k.trades > 0 && <span>Trades <b>{k.trades}</b></span>}
              {!!trades?.length && <span className="chart-mine">Your trades <i className="b">B</i><i className="s">S</i></span>}
            </div>
          )}
          {tool !== 'pointer' && <div className="chart-hint">{TOOL_POINTS[tool] === 1 ? 'Click to place' : drawRef.current.draft ? 'Click the second point' : 'Click the first point'} · Esc cancels</div>}
          <div className="chart-box" ref={boxRef} style={{ height: boxH, cursor: tool !== 'pointer' ? 'crosshair' : undefined }} />
          {older && <div className="chart-older">loading older candles…</div>}
          {(loading || empty) && (
            <div className="chart-overlay">
              {loading ? <div className="spinner" /> : <span>No trades found for this token on Arc's USDC pools.</span>}
            </div>
          )}
        </div>
      </div>
      <div className="chart-src">
        {meta.source === 'store'
          ? <>Every swap on Arc's USDC pools{meta.pools.length ? ` (${[...new Set(meta.pools)].slice(0, 4).join(' · ')})` : ''}, indexed by Statera{since ? ` · history from ${since}` : ''}</>
          : meta.source === 'warp' ? 'Chart: Warp launchpad candles (no pool swaps yet)' : meta.source === 'legacy' ? 'Chart: recent on-chain pool swaps (full history temporarily unavailable)' : 'Chart: on-chain pool swaps'}
        {' '}· Arc mainnet · <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">charts by TradingView</a>
      </div>
    </div>
  );
}
