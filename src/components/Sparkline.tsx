// Tiny inline SVG sparkline for a token's recent price series. Green if the series ends up, red if down.
// When there's no real 24h series (a low/no-volume token has no swaps to build one from), fall back to a
// straight directional line derived from the token's price + 24h change — honest (linear trend, no fabricated
// intraday wiggle) and it means the column ALWAYS renders instead of being hit-or-miss.
export function Sparkline({ data, price, change24h, width = 68, height = 24 }: { data?: number[] | null; price?: number | null; change24h?: number | null; width?: number; height?: number }) {
  let series = data && data.length >= 2 ? data : null;
  if (!series && price != null && isFinite(price) && price > 0) {
    const chg = change24h != null && isFinite(change24h) ? change24h : 0;
    const start = price / (1 + chg / 100);
    const n = 12;
    series = Array.from({ length: n }, (_, i) => start + (price - start) * (i / (n - 1)));
  }
  if (!series || series.length < 2) return <span className="spark-empty" style={{ width, height }} />;
  const data2 = series;
  const min = Math.min(...data2), max = Math.max(...data2);
  const span = max - min || 1;
  const up = data2[data2.length - 1] >= data2[0];
  const color = up ? '#4ecb71' : '#ff5a5a';
  const stepX = width / (data2.length - 1);
  const flat = max === min; // a no-movement line renders centered, not pinned to the bottom
  const pts = data2.map((v, i) => `${(i * stepX).toFixed(1)},${(flat ? height / 2 : height - ((v - min) / span) * (height - 3) - 1.5).toFixed(1)}`).join(' ');
  const gid = `sg${up ? 'u' : 'd'}`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
