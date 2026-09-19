import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

// Dynamic social card for a token: paste stateraarc.com/token/0x… anywhere and it unfurls into this.
// Self-contained (no src imports) so the edge bundle stays tiny. Data from the static snapshot.
const fmtUsd = (n: number | null): string => {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  // plain decimals (no subscript — keep it font-safe for the image)
  const s = n.toFixed(12).replace(/0+$/, '');
  return '$' + s;
};
const fmtNum = (n: number | null): string => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));

export default async function handler(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const addr = (searchParams.get('token') || '').toLowerCase();
  let t: any = null;
  try {
    const snap = await fetch(`${origin}/tokens-snapshot.json`, { cache: 'no-store' }).then((r) => r.json());
    t = (snap.tokens || []).find((x: any) => (x.address || '').toLowerCase() === addr) || null;
  } catch { /* no data */ }
  const font = await fetch(`${origin}/og-font.ttf`).then((r) => r.arrayBuffer());

  const sym = t?.symbol || 'TOKEN';
  const name = t?.name || 'Arc token';
  const price = fmtUsd(t?.price ?? null);
  const ch = t?.change24h as number | null;
  const chStr = ch == null ? '' : `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h`;
  const chColor = ch == null ? '#8f8478' : ch >= 0 ? '#4ecb71' : '#ff5a5a';
  const logo = t?.iconUrl || (addr ? `https://api.tollylabs.com/token-image/${addr}.png` : '');
  const stat = (label: string, value: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 22, color: '#8f8478', textTransform: 'uppercase', letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 40, color: '#fff' }}>{value}</div>
    </div>
  );

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#0a0806', backgroundImage: 'radial-gradient(1200px 500px at 85% 0%, rgba(255,122,30,0.22), transparent 60%)', padding: 64, fontFamily: 'S' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 30, letterSpacing: 6, color: '#ff7a1e' }}>STATERA · ARC</div>
          <div style={{ fontSize: 26, color: '#8f8478' }}>Arc Mainnet · USDC</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          {logo ? <img src={logo} width={150} height={150} style={{ borderRadius: 24, background: '#161310' }} /> : null}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 92, color: '#fff', lineHeight: 1 }}>${sym}</div>
            <div style={{ fontSize: 34, color: '#8f8478', marginTop: 6 }}>{name}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28 }}>
          <div style={{ fontSize: 96, color: '#fff', lineHeight: 1 }}>{price}</div>
          {chStr ? <div style={{ fontSize: 44, color: chColor, paddingBottom: 8 }}>{chStr}</div> : null}
        </div>
        <div style={{ display: 'flex', gap: 72 }}>
          {stat('Market Cap', fmtUsd(t?.mcap ?? null))}
          {stat('Liquidity', fmtUsd(t?.liq ?? null))}
          {stat('Vol 24h', fmtUsd(t?.volume24h ?? null))}
          {stat('Holders', fmtNum(t?.holders ?? null))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 26, color: '#6a635a' }}>
          <div>stateraarc.com</div>
          <div>Screener · Swap · Portfolio</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts: [{ name: 'S', data: font, style: 'normal', weight: 700 }] },
  );
}
