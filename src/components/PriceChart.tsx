import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { fetchWarpCandles, type Candle } from '../lib/warp';
import { fetchPoolCandles, tprice } from '../lib/arc';

// TradingView-style price chart for an Arc token. Data = candles rebuilt from the pool's on-chain swaps
// (chain 5042), Warp OHLC candles only as the fallback for coins with no pool swaps. DEX-style controls: timeframe, candles/line, lin/log.
// Arc mainnet launched 2026-09-16, so there are only a couple days of history — 1W/1M/ALL would just
// repeat the same ~2 days. These span from fine-grain to a multi-day view; longer ones become useful
// as the chain ages.
const TFS = [{ k: '1m', l: '1m' }, { k: '5m', l: '5m' }, { k: '15m', l: '15m' }, { k: '1h', l: '1H' }, { k: '4h', l: '4H' }, { k: '1d', l: '1D' }, { k: '1w', l: '1W' }, { k: 'all', l: 'ALL' }];
// Each timeframe = a DISTINCT candle bucket (sec) + visible window (look). ⛔ These MUST be unique — when
// 1H/1W/ALL all shared 3600s they returned byte-identical candles (same cache key) so switching them did
// nothing on screen. `warp` = the Warp interval to pull as the base (Warp only serves 1m/5m/1h); we then
// re-bucket that base up to `sec` so Warp tokens also change per timeframe.
const TF_CFG: Record<string, { sec: number; look: number; warp: string }> = {
  '1m':  { sec: 60,    look: 6 * 3600,      warp: '1m' },
  '5m':  { sec: 300,   look: 24 * 3600,     warp: '5m' },
  '15m': { sec: 900,   look: 3 * 86400,     warp: '5m' },
  '1h':  { sec: 3600,  look: 3 * 86400,     warp: '1h' },
  '4h':  { sec: 14400, look: 12 * 86400,    warp: '1h' },
  '1d':  { sec: 86400, look: 60 * 86400,    warp: '1h' },
  '1w':  { sec: 21600, look: 9 * 86400,     warp: '1h' },   // 6h candles
  'all': { sec: 43200, look: 3650 * 86400,  warp: '1h' },   // 12h candles, all history
};
// Aggregate finer candles up into `sec` buckets (OHLC). No-op when the base already matches `sec`.
function rebucket(cs: Candle[], sec: number): Candle[] {
  if (!cs.length) return cs;
  const m = new Map<number, Candle>();
  for (const c of cs) {
    const b = Math.floor(c.time / sec) * sec;
    const cur = m.get(b);
    if (!cur) m.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close });
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; }
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}
type ChartType = 'candles' | 'line';

// Shared DEX-style formatter (subscript zeros for tiny prices) — chart axis + labels match the header.
const priceFmt = (p: number) => (!isFinite(p) || Math.abs(p) < 1e-15 ? '$0' : tprice(p));

export function PriceChart({ address, symbol, decimals, priceScale = 1, change24h }: { address: string; symbol?: string; decimals?: number; priceScale?: number; change24h?: number | null }) {
  const [tf, setTf] = useState('5m');
  // A quiet token (last trade > 24h ago) showed an empty 5m chart reading "No trades yet on this pool" — wrong, the pool HAS
  // traded, just not today; 1H/ALL had its history (owner 09-25: "charts are broken now on some"). Until the user picks a
  // timeframe, an empty default view switches to ALL once, and says why.
  const userPicked = useRef(false);
  const [autoWide, setAutoWide] = useState(false);
  useEffect(() => { userPicked.current = false; setAutoWide(false); setTf('5m'); }, [address]);
  const [type, setType] = useState<ChartType>('candles');
  const [log, setLog] = useState(false);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  const seriesTypeRef = useRef<ChartType | null>(null);

  // Warm the wide-timeframe swap cache in the background shortly after load, so the first click on
  // 4H/1D/1W/ALL (a ~900k-block scan) is instant instead of a few seconds.
  useEffect(() => {
    const t = setTimeout(() => { fetchPoolCandles(address, decimals ?? 18, 43200, 3650 * 86400).catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [address, decimals]);

  // fetch candles on address / timeframe change
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      const cfg = TF_CFG[tf] ?? TF_CFG['5m'];
      // ⛔ ON-CHAIN FIRST (owner, 09-24): candles are rebuilt from the token's own pool Swap events (V3/V2/V4 —
      // always current, decimals-correct). Warp's candle API is only the fallback for a coin with no pool swaps
      // (a pre-graduation curve token). Before 09-25 Warp came first and the chain only filled in when Warp was
      // stale or the timeframe was wide.
      const nowS = Math.floor(Date.now() / 1000);
      const inWindow = (cs: Candle[]) => cs.filter((k) => k.time >= nowS - cfg.look);
      const ocP = fetchPoolCandles(address, decimals ?? 18, cfg.sec, cfg.look).catch(() => [] as Candle[]);
      const warpP = fetchWarpCandles(address, cfg.warp).catch(() => [] as Candle[]).then((w) => {
        // Warp prices ignore token decimals — rescale (priceScale = trusted seed price ÷ warp price; 1 for 18-dec).
        if (w.length && priceScale && priceScale !== 1) w = w.map((k) => ({ time: k.time, open: k.open * priceScale, high: k.high * priceScale, low: k.low * priceScale, close: k.close * priceScale }));
        return w.length ? rebucket(w, cfg.sec) : w;
      });
      // Warp answers in well under a second, the on-chain scan takes a few: draw Warp's candles as a PLACEHOLDER
      // until the chain answers, then the chain's replace them. Warp stays on screen only if the chain has none.
      let chainDone = false;
      warpP.then((w) => { const v = inWindow(w); if (alive && !chainDone && v.length) { setCandles(v); setLoading(false); } });
      let c: Candle[] = await ocP;
      chainDone = true;
      if (!c.length) c = await warpP;
      // Show only this timeframe's window.
      c = inWindow(c);
      if (alive && !c.length && !userPicked.current && tf !== 'all') { setAutoWide(true); setTf('all'); return; } // quiet token → full history
      if (alive) { setCandles(c); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [address, tf, priceScale]);

  // create the chart once
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      width: boxRef.current.clientWidth, height: boxRef.current.clientHeight || 300, // height from CSS (.chart-box: 300 desktop / 230 phone)
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8f8478', fontFamily: 'JetBrains Mono, monospace' },
      grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, horzLine: { labelBackgroundColor: '#ff5a5a' }, vertLine: { labelBackgroundColor: '#333', style: LineStyle.Dashed } },
      localization: { priceFormatter: priceFmt },
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => { if (boxRef.current) chart.applyOptions({ width: boxRef.current.clientWidth, height: boxRef.current.clientHeight || 300 }); });
    ro.observe(boxRef.current);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; seriesTypeRef.current = null; };
  }, []);

  // (re)build the series when the chart type changes, then push data on any candle/type change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candles) return;
    if (seriesTypeRef.current !== type) {
      if (seriesRef.current) { chart.removeSeries(seriesRef.current); seriesRef.current = null; }
      seriesRef.current = type === 'candles'
        ? chart.addCandlestickSeries({ upColor: '#5ad18a', downColor: '#ff5a5a', borderVisible: false, wickUpColor: '#5ad18a', wickDownColor: '#ff5a5a' })
        : chart.addAreaSeries({ lineColor: '#ff7a1a', lineWidth: 2, topColor: 'rgba(255,122,26,.28)', bottomColor: 'rgba(255,122,26,0)' });
      seriesTypeRef.current = type;
    }
    const series = seriesRef.current;
    if (!series) return;
    const max = candles.reduce((m, c) => Math.max(m, c.high), 0);
    const precision = max >= 100 ? 2 : max >= 1 ? 4 : max >= 0.01 ? 6 : 8;
    series.applyOptions({ priceFormat: { type: 'price', precision, minMove: Math.pow(10, -precision) } });
    const data = type === 'candles' ? candles : candles.map((c) => ({ time: c.time, value: c.close }));
    series.setData(data as any);
    chart.timeScale().fitContent();
  }, [candles, type]);

  // linear / log price scale
  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: log ? 1 : 0 });
  }, [log]);

  const empty = !loading && candles != null && candles.length === 0;
  const last = candles && candles.length ? candles[candles.length - 1].close : null;
  // Header %: use the token's real 24h change (matches the stat cards) — NOT first-vs-last over the whole
  // visible window, which is a different period and blows up when the first candle is a near-zero outlier.
  const chg = change24h != null && isFinite(change24h) && Math.abs(change24h) < 1e5 ? change24h : null; // display hard rule

  return (
    <div className="chart-card panel">
      <div className="chart-head">
        <div className="chart-title">
          {symbol ? `$${symbol}` : 'Price'} <span className="chart-usdc">/ USDC</span>
          {last != null && <span className="chart-last">{priceFmt(last)}</span>}
          {chg != null && <span className={`chart-chg ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}% <span className="chart-chg-l">24h</span></span>}
        </div>
        <div className="chart-tfs">
          {TFS.map((t) => <button key={t.k} className={tf === t.k ? 'on' : ''} onClick={() => { userPicked.current = true; setAutoWide(false); setTf(t.k); }}>{t.l}</button>)}
        </div>
      </div>
      <div className="chart-tools">
        <div className="chart-seg">
          <button className={type === 'candles' ? 'on' : ''} onClick={() => setType('candles')}>Candles</button>
          <button className={type === 'line' ? 'on' : ''} onClick={() => setType('line')}>Line</button>
        </div>
        <div className="chart-seg">
          <button className={!log ? 'on' : ''} onClick={() => setLog(false)}>Linear</button>
          <button className={log ? 'on' : ''} onClick={() => setLog(true)}>Log</button>
        </div>
      </div>
      <div className="chart-box-wrap">
        <div className="chart-box" ref={boxRef} />
        {(loading || empty) && (
          <div className="chart-overlay">
            {loading ? <div className="spinner" /> : <span>{tf === 'all' ? 'No trades found on this pool in its recent on-chain history.' : 'No trades in this timeframe — try a wider one (1H · 1D · ALL).'}</span>}
          </div>
        )}
      </div>
      {autoWide && tf === 'all' && candles && candles.length > 0 && <div className="chart-note">No trades in the last 24h — showing full history.</div>}
      <div className="chart-src">Chart: on-chain pool swaps (Warp candles if none) · Arc mainnet (5042) · unofficial · DYOR</div>
    </div>
  );
}
