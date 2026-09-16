// Tiny inline SVG sparkline for a token's recent price series. Green if the series ends up, red if down.
export function Sparkline({ data, width = 68, height = 24 }: { data?: number[] | null; width?: number; height?: number }) {
  if (!data || data.length < 2) return <span className="spark-empty" style={{ width, height }} />;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const up = data[data.length - 1] >= data[0];
  const color = up ? '#4ecb71' : '#ff5a5a';
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * (height - 3) - 1.5).toFixed(1)}`).join(' ');
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
