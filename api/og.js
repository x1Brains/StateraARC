import { Resvg, initWasm } from '@resvg/resvg-wasm';
import FONT_B64 from '../lib/ogfont.js';
import WASM_B64 from '../lib/ogwasm.js';
import { liveToken } from '../lib/livetoken.js';

// Dynamic social card for a token: paste stateraarc.com/token/0x… anywhere and it unfurls into this.
// Rasterised with the WASM build of resvg. The NATIVE @resvg/resvg-js renders blank text under
// Vercel's Node 24 (self-test came back blank there while identical code works locally); the WASM
// build is the same bytecode everywhere. Both the font and the wasm are base64-embedded from lib/
// (OUT of /api so they aren't compiled as functions) — self-fetch and fs-tracing both failed here.
const OG_VER = 'v8-live';
const FONT = Buffer.from(FONT_B64, 'base64');

let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm(Buffer.from(WASM_B64, 'base64'));
  return wasmReady;
}

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
// Compact price as SVG inner-markup (goes inside a <text>). Tiny prices use a subscript zero-count drawn
// with a normal digit via <tspan> (a font glyph we KNOW exists) — so $0.00005152 shows as $0.0[4]5152
// instead of a wall of decimals, without risking a missing Unicode-subscript glyph rendering as tofu.
// `fs` = the parent price font-size, so the tspan can reset cleanly after the smaller subscript digit.
const priceInner = (n, fs) => {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  const m = n.toFixed(12).match(/^0\.(0*)(\d+?)0*$/);
  if (!m) return '$' + n.toPrecision(3);
  const zeros = m[1].length, sig = m[2].slice(0, 4);
  if (zeros < 4) return '$0.' + m[1] + sig;
  const sub = Math.round(fs * 0.55), dy = Math.round(fs * 0.22);
  return `$0.0<tspan font-size="${sub}" dy="${dy}">${zeros}</tspan><tspan font-size="${fs}" dy="${-dy}">${sig}</tspan>`;
};

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
    const square = url.searchParams.get('sq') === '1'; // 600x600 for X's compact `summary` card (short, not the tall banner)
    res.setHeader('x-og-ver', OG_VER);

    if (url.searchParams.get('debug')) {
      let selftest = 'skip';
      try {
        await ensureWasm();
        const t0 = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="4" y="44" font-family="Open Sans" font-size="40" fill="#fff">Ag9</text></svg>',
          { font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false }, fitTo: { mode: 'width', value: 200 } });
        selftest = 'png:' + t0.render().asPng().length;
      } catch (e) { selftest = 'ERR:' + (e?.message || e); }
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ ver: OG_VER, node: process.version, fontLen: FONT.length, fontB64Len: (FONT_B64 || '').length, selftest }));
    }

    // Live: the site's current list (VPS /api/snapshot) + the price re-read from the token's pool right now.
    const t = addr ? await liveToken(origin, addr).catch(() => null) : null;

    const sym = esc(t?.symbol || 'TOKEN');
    const name = esc((t?.name || 'Arc token').slice(0, 42));
    const ch = t?.change24h;
    const chStr = ch == null ? '' : `${ch >= 0 ? '+' : '-'}${Math.abs(ch).toFixed(1)}% 24h`;
    const chColor = ch == null ? '#8f8478' : ch >= 0 ? '#4ecb71' : '#ff5a5a';
    const [logo] = await Promise.all([logoDataUri(t, addr), ensureWasm()]);
    const symX = logo ? 234 : 64;

    // 1200x630 = Twitter/X's exact link-card ratio (1.91:1). ⛔ A SHORTER image gets center-cropped by X (it
    // fills the card and trims the sides — "STATERA"->"TERA", "$0.0020"->".0020"). So this is the floor for an
    // uncropped card; the layout is filled generously so it reads full, not empty. (Discord/Telegram DO honor a
    // shorter aspect, but X does not — its card height is fixed.)
    const stat = (x, label, value) => `
      <text x="${x}" y="508" font-family="Open Sans" font-size="23" fill="#8f8478" letter-spacing="2">${label}</text>
      <text x="${x}" y="564" font-family="Open Sans" font-size="46" fill="#ffffff">${value}</text>`;

    const wideSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630">
      <defs>
        <radialGradient id="glow" cx="82%" cy="0%" r="70%">
          <stop offset="0%" stop-color="#ff7a1e" stop-opacity="0.28"/>
          <stop offset="60%" stop-color="#ff7a1e" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="lc"><rect x="64" y="128" width="150" height="150" rx="28"/></clipPath>
      </defs>
      <rect width="1200" height="630" fill="#0a0806"/>
      <rect width="1200" height="630" fill="url(#glow)"/>
      <rect x="0" y="0" width="1200" height="6" fill="#ff7a1e"/>

      <text x="64" y="80" font-family="Open Sans" font-size="30" fill="#ff7a1e" letter-spacing="6">STATERA · ARC</text>
      <text x="1136" y="80" text-anchor="end" font-family="Open Sans" font-size="26" fill="#8f8478">Arc Mainnet · USDC</text>

      ${logo ? `<rect x="64" y="128" width="150" height="150" rx="28" fill="#161310"/><image x="64" y="128" width="150" height="150" clip-path="url(#lc)" preserveAspectRatio="xMidYMid slice" xlink:href="${logo}"/>` : ''}
      <text x="${symX}" y="216" font-family="Open Sans" font-size="88" fill="#ffffff">$${sym}</text>
      <text x="${symX}" y="270" font-family="Open Sans" font-size="32" fill="#8f8478">${name}</text>

      <text x="64" y="420" font-family="Open Sans" font-size="104" fill="#ffffff">${priceInner(t?.price, 104)}</text>
      ${chStr ? `<text x="1136" y="408" text-anchor="end" font-family="Open Sans" font-size="52" fill="${chColor}">${esc(chStr)}</text>` : ''}

      ${stat(64, 'MARKET CAP', esc(fmtUsd(t?.mcap)))}
      ${stat(360, 'LIQUIDITY', esc(fmtUsd(t?.liq)))}
      ${stat(656, 'VOL 24H', esc(fmtUsd(t?.volume24h)))}
      ${stat(952, 'HOLDERS', esc(fmtNum(t?.holders)))}

      <text x="64" y="602" font-family="Open Sans" font-size="26" fill="#6a635a">stateraarc.com</text>
      <text x="1136" y="602" text-anchor="end" font-family="Open Sans" font-size="26" fill="#6a635a">Screener · Swap · Portfolio</text>
    </svg>`;

    // Square 600x600 for X's `summary` card — a small thumbnail (logo + $sym + price), short by design; the
    // market-cap/liquidity/volume/holders live in the card's description text instead of on the image.
    const sqSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="600">
      <defs>
        <radialGradient id="glow" cx="50%" cy="0%" r="85%"><stop offset="0%" stop-color="#ff7a1e" stop-opacity="0.30"/><stop offset="60%" stop-color="#ff7a1e" stop-opacity="0"/></radialGradient>
        <clipPath id="lcs"><rect x="205" y="92" width="190" height="190" rx="40"/></clipPath>
      </defs>
      <rect width="600" height="600" fill="#0a0806"/>
      <rect width="600" height="600" fill="url(#glow)"/>
      <rect x="0" y="0" width="600" height="8" fill="#ff7a1e"/>
      <text x="300" y="58" text-anchor="middle" font-family="Open Sans" font-size="23" fill="#ff7a1e" letter-spacing="5">STATERA · ARC</text>
      ${logo ? `<rect x="205" y="92" width="190" height="190" rx="40" fill="#161310"/><image x="205" y="92" width="190" height="190" clip-path="url(#lcs)" preserveAspectRatio="xMidYMid slice" xlink:href="${logo}"/>` : ''}
      <text x="300" y="382" text-anchor="middle" font-family="Open Sans" font-size="78" fill="#ffffff">$${sym}</text>
      <text x="300" y="456" text-anchor="middle" font-family="Open Sans" font-size="62" fill="#ffffff">${priceInner(t?.price, 62)}</text>
      ${chStr ? `<text x="300" y="516" text-anchor="middle" font-family="Open Sans" font-size="38" fill="${chColor}">${esc(chStr)}</text>` : ''}
      <text x="300" y="568" text-anchor="middle" font-family="Open Sans" font-size="22" fill="#8f8478">Arc Mainnet · stateraarc.com</text>
    </svg>`;

    const png = new Resvg(square ? sqSvg : wideSvg, {
      font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false },
      fitTo: { mode: 'width', value: square ? 600 : 1200 },
    }).render().asPng();

    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300'); // live price: a minute at most
    res.status(200).send(Buffer.from(png)); // .asPng() is a Uint8Array; Buffer for correct binary send
  } catch (e) {
    res.status(500).send('og render failed: ' + (e?.message || String(e)));
  }
}
