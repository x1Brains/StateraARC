import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { fetchWarpCandles, type Candle } from '../lib/warp';
import { fetchPoolCandles, tprice } from '../lib/arc';

// TradingView-style price chart for an Arc token. Data = Warp OHLC candles (chain 5042) with an
// on-chain pool-swap fallback for deep V3 tokens. DEX-style controls: timeframe, candles/line, lin/log.
// Arc mainnet launched 2026-09-16, so there are only a couple days of history — 1W/1M/ALL would just
// repeat the same ~2 days. These span from fine-grain to a multi-day view; longer ones become useful
// as the chain ages.
const TFS = [{ k: '1m', l: '1m' }, { k: '5m', l: '5m' }, { k: '15m', l: '15m' }, { k: '1h', l: '1H' }, { k: '4h', l: '4H' }, { k: '1d', l: '1D' }];
const TF_SEC: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
type ChartType = 'candles' | 'line';

// Shared DEX-style formatter (subscript zeros for tiny prices) — chart axis + labels match the header.
const priceFmt = (p: number) => (!isFinite(p) || Math.abs(p) < 1e-15 ? '$0' : tprice(p));

export function PriceChart({ address, symbol, decimals, priceScale = 1, change24h }: { address: string; symbol?: string; decimals?: number; priceScale?: number; change24h?: number | null }) {
  const [tf, setTf] = useState('5m');
  const [type, setType] = useState<ChartType>('candles');
  const [log, setLog] = useState(false);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  const seriesTypeRef = useRef<ChartType | null>(null);

  // fetch candles on address / timeframe change
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      let c = await fetchWarpCandles(address, tf).catch(() => [] as Candle[]);
      // Warp candles use Warp's price scale, which ignores token decimals — rescale to the real price
      // (priceScale = trusted seed price ÷ warp price; =1 for normal 18-dec tokens). Fixes cirBTC etc.
      if (c && c.length && priceScale && priceScale !== 1) {
        c = c.map((k) => ({ time: k.time, open: k.open * priceScale, high: k.high * priceScale, low: k.low * priceScale, close: k.close * priceScale }));
      }
      // Not on Warp (deep V3 tokens like ARGUS) → build candles from the pool's on-chain swaps (already
      // decimals-correct, so no rescale).
      if ((!c || c.length === 0)) {
        c = await fetchPoolCandles(address, decimals ?? 18, TF_SEC[tf] ?? 300).catch(() => [] as Candle[]);
      }
      if (alive) { setCandles(c); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [address, tf, priceScale]);

  // create the chart once
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      width: boxRef.current.clientWidth, height: 340,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8f8478', fontFamily: 'JetBrains Mono, monospace' },
      grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, horzLine: { labelBackgroundColor: '#ff5a5a' }, vertLine: { labelBackgroundColor: '#333', style: LineStyle.Dashed } },
      localization: { priceFormatter: priceFmt },
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => { if (boxRef.current) chart.applyOptions({ width: boxRef.current.clientWidth }); });
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
  const chg = change24h ?? null;

  return (
    <div className="chart-card panel">
      <div className="chart-head">
        <div className="chart-title">
          {symbol ? `$${symbol}` : 'Price'} <span className="chart-usdc">/ USDC</span>
          {last != null && <span className="chart-last">{priceFmt(last)}</span>}
          {chg != null && <span className={`chart-chg ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}% <span className="chart-chg-l">24h</span></span>}
        </div>
        <div className="chart-tfs">
          {TFS.map((t) => <button key={t.k} className={tf === t.k ? 'on' : ''} onClick={() => setTf(t.k)}>{t.l}</button>)}
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
            {loading ? <div className="spinner" /> : <span>No trades yet on this pool — the chart fills in as it trades.</span>}
          </div>
        )}
      </div>
      <div className="chart-src">Chart: Warp candles or on-chain pool swaps · Arc mainnet (5042) · unofficial · DYOR</div>
    </div>
  );
}
