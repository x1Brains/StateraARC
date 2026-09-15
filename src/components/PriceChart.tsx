import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { fetchWarpCandles, type Candle } from '../lib/warp';

// TradingView-style candlestick chart for an Arc token. Data = Warp's OHLC candles (chain 5042),
// which powers both the pre-public and mainnet views. Testnet tokens aren't on Warp, so the chart
// shows an honest empty state there rather than a fake line.
const TFS = [{ k: '1m', l: '1m' }, { k: '5m', l: '5m' }, { k: '1h', l: '1H' }];

const priceFmt = (p: number) =>
  p >= 1000 ? '$' + (p / 1000).toFixed(2) + 'K'
  : p >= 1 ? '$' + p.toFixed(3)
  : p >= 0.001 ? '$' + p.toFixed(5)
  : '$' + p.toExponential(2);

export function PriceChart({ address, symbol }: { address: string; symbol?: string }) {
  const [tf, setTf] = useState('5m');
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // fetch candles on address / timeframe change
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchWarpCandles(address, tf).then((c) => { if (alive) { setCandles(c); setLoading(false); } });
    return () => { alive = false; };
  }, [address, tf]);

  // create the chart once
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      width: boxRef.current.clientWidth, height: 340,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8f8478', fontFamily: 'JetBrains Mono, monospace' },
      grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: priceFmt },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#5ad18a', downColor: '#ff5a5a', borderVisible: false,
      wickUpColor: '#5ad18a', wickDownColor: '#ff5a5a',
    });
    chartRef.current = chart; seriesRef.current = series;
    const ro = new ResizeObserver(() => { if (boxRef.current) chart.applyOptions({ width: boxRef.current.clientWidth }); });
    ro.observe(boxRef.current);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // push data + auto-precision + fit
  useEffect(() => {
    if (!seriesRef.current || !candles) return;
    const max = candles.reduce((m, c) => Math.max(m, c.high), 0);
    const precision = max >= 100 ? 2 : max >= 1 ? 4 : max >= 0.01 ? 6 : 8;
    seriesRef.current.applyOptions({ priceFormat: { type: 'price', precision, minMove: Math.pow(10, -precision) } });
    seriesRef.current.setData(candles as any);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  const empty = !loading && candles != null && candles.length === 0;
  const last = candles && candles.length ? candles[candles.length - 1].close : null;
  const first = candles && candles.length ? candles[0].open : null;
  const chg = last != null && first ? ((last - first) / first) * 100 : null;

  return (
    <div className="chart-card panel">
      <div className="chart-head">
        <div className="chart-title">
          {symbol ? `$${symbol}` : 'Price'} <span className="chart-usdc">/ USDC</span>
          {last != null && <span className="chart-last">{priceFmt(last)}</span>}
          {chg != null && <span className={`chart-chg ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}%</span>}
        </div>
        <div className="chart-tfs">
          {TFS.map((t) => <button key={t.k} className={tf === t.k ? 'on' : ''} onClick={() => setTf(t.k)}>{t.l}</button>)}
        </div>
      </div>
      <div className="chart-box-wrap">
        <div className="chart-box" ref={boxRef} />
        {(loading || empty) && (
          <div className="chart-overlay">
            {loading ? <div className="spinner" /> : <span>No price history yet — this token isn’t indexed by Warp (charts are live for Arc mainnet tokens).</span>}
          </div>
        )}
      </div>
      <div className="chart-src">Chart: Warp · Arc (chain 5042) · unofficial · DYOR</div>
    </div>
  );
}
