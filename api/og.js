import { Resvg } from '@resvg/resvg-js';
import FONT_B64 from '../lib/ogfont.js';

// Dynamic social card for a token: paste stateraarc.com/token/0x… anywhere and it unfurls into this.
// Built as an SVG and rasterised to PNG with @resvg/resvg-js (ships its own native binary — robust on
// Vercel's Node runtime, unlike @vercel/og whose harfbuzz wasm isn't traced into a bare Vite /api fn).

// Font is base64-embedded (lib/ogfont.js, OUT of /api so it isn't compiled as its own function):
// a lambda fetching its OWN public/ asset returned blank text, and public/ isn't in the lambda fs.
const OG_VER = 'v3-embed';
const FONT = Buffer.from(FONT_B64, 'base64');

const fmtUsd = (n) => {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  return '$' + n.toFixed(12).replace(/0+$/, '');
};
const fmtNum = (n) => (n == null || !isFinite(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function logoDataUri(t, addr) {
  const tries = [t?.iconUrl, addr ? `https://api.tollylabs.com/token-image/${addr}.png` : null].filter(Boolean);
  for (const u of tries) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) continue;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('svg') || ct.includes('html')) continue; // resvg <image> needs raster
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length < 64) continue;
      return `data:${ct.startsWith('image/') ? ct.split(';')[0] : 'image/png'};base64,${b.toString('base64')}`;
    } catch { /* next */ }
  }
  return '';
}

export default async function handler(req, res) {
  try {
    const origin = `https://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const addr = (url.searchParams.get('token') || '').toLowerCase();
    res.setHeader('x-og-ver', OG_VER);

    if (url.searchParams.get('debug')) {
      let selftest = 'skip';
      try {
        const t0 = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="4" y="44" font-family="S" font-size="40" fill="#fff">Ag9</text></svg>',
          { font: { fontBuffers: [FONT], defaultFontFamily: 'S', loadSystemFonts: false }, fitTo: { mode: 'width', value: 200 } });
        selftest = 'png:' + t0.render().asPng().length;
      } catch (e) { selftest = 'ERR:' + (e?.message || e); }
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ ver: OG_VER, node: process.version, fontLen: FONT.length, fontB64Len: (FONT_B64 || '').length, selftest }));
    }

    let t = null;
    try {
      const snap = await fetch(`${origin}/tokens-snapshot.json`, { cache: 'no-store' }).then((r) => r.json());
      t = (snap.tokens || []).find((x) => (x.address || '').toLowerCase() === addr) || null;
    } catch { /* no data */ }

    const sym = esc(t?.symbol || 'TOKEN');
    const name = esc((t?.name || 'Arc token').slice(0, 42));
    const ch = t?.change24h;
    const chStr = ch == null ? '' : `${ch >= 0 ? '▲ +' : '▼ '}${Math.abs(ch).toFixed(1)}% 24h`;
    const chColor = ch == null ? '#8f8478' : ch >= 0 ? '#4ecb71' : '#ff5a5a';
    const logo = await logoDataUri(t, addr);
    const symX = logo ? 244 : 64;

    const stat = (x, label, value) => `
      <text x="${x}" y="502" font-family="S" font-size="22" fill="#8f8478" letter-spacing="2">${label}</text>
      <text x="${x}" y="552" font-family="S" font-size="42" fill="#ffffff">${value}</text>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630">
      <defs>
        <radialGradient id="glow" cx="82%" cy="0%" r="70%">
          <stop offset="0%" stop-color="#ff7a1e" stop-opacity="0.28"/>
          <stop offset="60%" stop-color="#ff7a1e" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="lc"><rect x="64" y="150" width="150" height="150" rx="28"/></clipPath>
      </defs>
      <rect width="1200" height="630" fill="#0a0806"/>
      <rect width="1200" height="630" fill="url(#glow)"/>
      <rect x="0" y="0" width="1200" height="6" fill="#ff7a1e"/>

      <text x="64" y="98" font-family="S" font-size="30" fill="#ff7a1e" letter-spacing="6">STATERA · ARC</text>
      <text x="1136" y="98" text-anchor="end" font-family="S" font-size="26" fill="#8f8478">Arc Mainnet · USDC</text>

      ${logo ? `<rect x="64" y="150" width="150" height="150" rx="28" fill="#161310"/><image x="64" y="150" width="150" height="150" clip-path="url(#lc)" preserveAspectRatio="xMidYMid slice" xlink:href="${logo}"/>` : ''}
      <text x="${symX}" y="238" font-family="S" font-size="88" fill="#ffffff">$${sym}</text>
      <text x="${symX}" y="288" font-family="S" font-size="32" fill="#8f8478">${name}</text>

      <text x="64" y="418" font-family="S" font-size="96" fill="#ffffff">${esc(fmtUsd(t?.price))}</text>
      ${chStr ? `<text x="1136" y="410" text-anchor="end" font-family="S" font-size="46" fill="${chColor}">${esc(chStr)}</text>` : ''}

      ${stat(64, 'MARKET CAP', esc(fmtUsd(t?.mcap)))}
      ${stat(360, 'LIQUIDITY', esc(fmtUsd(t?.liq)))}
      ${stat(656, 'VOL 24H', esc(fmtUsd(t?.volume24h)))}
      ${stat(952, 'HOLDERS', esc(fmtNum(t?.holders)))}

      <text x="64" y="602" font-family="S" font-size="26" fill="#6a635a">stateraarc.com</text>
      <text x="1136" y="602" text-anchor="end" font-family="S" font-size="26" fill="#6a635a">Screener · Swap · Portfolio</text>
    </svg>`;

    const png = new Resvg(svg, {
      font: { fontBuffers: [FONT], defaultFontFamily: 'S', loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();

    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400');
    res.status(200).send(png);
  } catch (e) {
    res.status(500).send('og render failed: ' + (e?.message || String(e)));
  }
}
