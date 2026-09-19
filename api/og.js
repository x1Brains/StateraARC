import { ImageResponse } from '@vercel/og';
import React from 'react';

// Node runtime (default, same as api/radar.js) — the edge runtime wasn't building on this Vite project.
const h = (type, style, ...children) => React.createElement(type, { style }, ...children);

// Dynamic social card for a token: paste stateraarc.com/token/0x… anywhere and it unfurls into this.
// Written without JSX (React.createElement) so Vercel builds it as an edge function on this Vite project.
const fmtUsd = (n) => {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  return '$' + n.toFixed(12).replace(/0+$/, '');
};
const fmtNum = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));

export default async function handler(req) {
  const { searchParams, origin } = new URL(req.url);
  const addr = (searchParams.get('token') || '').toLowerCase();
  let t = null;
  try {
    const snap = await fetch(`${origin}/tokens-snapshot.json`, { cache: 'no-store' }).then((r) => r.json());
    t = (snap.tokens || []).find((x) => (x.address || '').toLowerCase() === addr) || null;
  } catch { /* no data */ }
  const font = await fetch(`${origin}/og-font.ttf`).then((r) => r.arrayBuffer());

  const sym = t?.symbol || 'TOKEN';
  const name = t?.name || 'Arc token';
  const ch = t?.change24h;
  const chStr = ch == null ? '' : `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h`;
  const chColor = ch == null ? '#8f8478' : ch >= 0 ? '#4ecb71' : '#ff5a5a';
  const logo = t?.iconUrl || (addr ? `https://api.tollylabs.com/token-image/${addr}.png` : '');
  const stat = (label, value) => h('div', { display: 'flex', flexDirection: 'column', gap: 4 },
    h('div', { fontSize: 22, color: '#8f8478', textTransform: 'uppercase', letterSpacing: 2 }, label),
    h('div', { fontSize: 40, color: '#fff' }, value));

  const card = h('div', { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#0a0806', backgroundImage: 'radial-gradient(1200px 500px at 85% 0%, rgba(255,122,30,0.22), transparent 60%)', padding: 64, fontFamily: 'S' },
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
      h('div', { fontSize: 30, letterSpacing: 6, color: '#ff7a1e' }, 'STATERA · ARC'),
      h('div', { fontSize: 26, color: '#8f8478' }, 'Arc Mainnet · USDC')),
    h('div', { display: 'flex', alignItems: 'center', gap: 36 },
      logo ? React.createElement('img', { src: logo, width: 150, height: 150, style: { borderRadius: 24, background: '#161310' } }) : h('div', {}),
      h('div', { display: 'flex', flexDirection: 'column' },
        h('div', { fontSize: 92, color: '#fff', lineHeight: 1 }, '$' + sym),
        h('div', { fontSize: 34, color: '#8f8478', marginTop: 6 }, name))),
    h('div', { display: 'flex', alignItems: 'flex-end', gap: 28 },
      h('div', { fontSize: 96, color: '#fff', lineHeight: 1 }, fmtUsd(t?.price)),
      chStr ? h('div', { fontSize: 44, color: chColor, paddingBottom: 8 }, chStr) : h('div', {})),
    h('div', { display: 'flex', gap: 72 },
      stat('Market Cap', fmtUsd(t?.mcap)), stat('Liquidity', fmtUsd(t?.liq)), stat('Vol 24h', fmtUsd(t?.volume24h)), stat('Holders', fmtNum(t?.holders))),
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 26, color: '#6a635a' },
      h('div', {}, 'stateraarc.com'), h('div', {}, 'Screener · Swap · Portfolio')));

  return new ImageResponse(card, { width: 1200, height: 630, fonts: [{ name: 'S', data: font, style: 'normal', weight: 700 }] });
}
