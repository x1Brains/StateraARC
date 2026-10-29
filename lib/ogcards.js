// Token link cards (the image X / Discord / Telegram show for a pasted stateraarc.com/token/0x… link), 1200x630, in the
// snapshot cards' look (10-29 owner: "use the whole card … a little bit of the chart … 3-4 options"). Pure SVG builders:
// api/og.js fetches the data and renders; scripts can render the same builders locally for previews.
//   t    = the token row (/api/v2/token/:a → token + list: price, change24h, mcap, liq, volume24h, holders, spark = 7d closes)
//   logo = data URI or '' · hero = data URI of the hero art or ''
const C = { bg: '#060607', panel: '#0d0d10', tile: '#131317', line: '#24242b', edge: '#2c2c33', fire: '#ff7a1e', gold: '#ffc24a',
  white: '#f6f7f8', gray: '#a3a3ad', dim: '#6b6b75', green: '#4ecb71', red: '#ff5a3c' };
const W = 1200, H = 630;
const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const T = (x, y, s, size, fill = C.white, extra = '') => `<text x="${x}" y="${y}" font-family="Open Sans" font-size="${size}" fill="${fill}" ${extra}>${s}</text>`;
const usd = (n) => (n == null || !isFinite(n) || n <= 0 ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + n.toFixed(2));
const cnt = (n) => (n == null || !isFinite(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n).toLocaleString('en-US'));
export const priceInner = (n, fs) => {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  const m = n.toFixed(14).match(/^0\.(0*)(\d+?)0*$/);
  if (!m) return '$' + n.toPrecision(3);
  const zeros = m[1].length, sig = m[2].slice(0, 4);
  if (zeros < 4) return '$0.' + m[1] + sig;
  const sub = Math.round(fs * 0.55), dy = Math.round(fs * 0.22);
  return `$0.0<tspan font-size="${sub}" dy="${dy}">${zeros}</tspan><tspan font-size="${fs}" dy="${-dy}">${sig}</tspan>`;
};
const chgTxt = (v) => (v == null || !isFinite(v) ? null : Math.abs(v) < 0.05 ? '0.0%' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);
const chgCol = (v) => (v == null || !isFinite(v) || Math.abs(v) < 0.05 ? C.gray : v >= 0 ? C.green : C.red);
// change pill: "+4.2% 24H"
const pill = (x, y, v, size = 26, anchorEnd = false) => {
  const t = chgTxt(v); if (!t) return '';
  const label = `${t} 24H`, w = 26 + label.length * size * 0.58, h = size + 22, x0 = anchorEnd ? x - w : x, col = chgCol(v);
  return `<rect x="${x0}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${col}" fill-opacity="0.12" stroke="${col}" stroke-opacity="0.55"/>` + T(x0 + w / 2, y + h / 2 + size * 0.36, label, size, col, 'text-anchor="middle" font-weight="700"');
};
// 7-day chart (spark closes): glowing line + gradient fill, coloured by the week's direction
let gid = 0;
function chart(x, y, w, h, spark, opts = {}) {
  const sp = (spark || []).filter((v) => isFinite(v) && v > 0);
  if (sp.length < 2) return '';
  const up = sp[sp.length - 1] >= sp[0], col = opts.color || (up ? C.green : C.red), id = `cg${++gid}`;
  const mn = Math.min(...sp), mx = Math.max(...sp), rg = mx - mn || mx * 0.01 || 1;
  const pts = sp.map((v, i) => [x + (i / (sp.length - 1)) * w, y + h - ((v - mn) / rg) * h * 0.86 - h * 0.07]);
  const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
  const area = `${line}L${x + w},${y + h}L${x},${y + h}Z`;
  const [lx, ly] = pts[pts.length - 1];
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="${opts.fill ?? 0.32}"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="${(opts.width ?? 3) + 6}" stroke-opacity="0.12" stroke-linejoin="round"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="${opts.width ?? 3}" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="${(opts.width ?? 3) + 4}" fill="${col}" fill-opacity="0.25"/><circle cx="${lx}" cy="${ly}" r="${(opts.width ?? 3) + 1}" fill="${col}"/>`;
}
// the textured side: dot grid fading out, lava contour lines, embers, sparks (seeded — same on every card)
function texture(mask = 'tL', count = 120, W = 1200, H = 630) {
  let seed = 1029; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let o = `<defs>
    <pattern id="tgrid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.3" fill="#ffb27a" fill-opacity="0.34"/></pattern>
    <linearGradient id="tL" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.78" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="tA" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0.25"/></linearGradient>
    <mask id="tm" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#${mask})"/></mask>
    <radialGradient id="ember"><stop offset="0" stop-color="#ffd27a"/><stop offset="0.35" stop-color="#ff8a2a" stop-opacity="0.75"/><stop offset="1" stop-color="#ff5a1e" stop-opacity="0"/></radialGradient>
    <linearGradient id="streak" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff7a1e" stop-opacity="0"/><stop offset="1" stop-color="#ffc24a" stop-opacity="0.85"/></linearGradient>
  </defs>`;
  let cl = '';
  for (let k = 0; k < 6; k++) {
    const y0 = H * (0.1 + k * 0.15), amp = 10 + rnd() * 18, ph = rnd() * 6.28, f = 0.004 + rnd() * 0.003; let d = '';
    for (let x = 0; x <= W; x += 24) d += `${x ? 'L' : 'M'}${x},${(y0 + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.3 + ph * 1.7) * amp * 0.35).toFixed(1)}`;
    cl += `<path d="${d}" fill="none" stroke="#ff7a1e" stroke-width="${k % 3 === 0 ? 1.6 : 1}" stroke-opacity="${(0.13 + rnd() * 0.13).toFixed(2)}"/>`;
  }
  o += `<g mask="url(#tm)"><rect width="${W}" height="${H}" fill="url(#tgrid)"/>${cl}</g>`;
  for (let i = 0; i < count; i++) {
    const t = rnd(), x = 14 + t * (W - 28), y = 10 + rnd() * (H - 20), big = rnd() < 0.16, r = big ? 5 + rnd() * 9 : 1.2 + rnd() * 2.4;
    const op = (0.22 + rnd() * 0.6) * (0.6 + 0.4 * t);
    o += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#ember)" opacity="${(big ? op * 0.45 : op).toFixed(2)}"/>`;
  }
  for (let i = 0; i < 12; i++) {
    const x = W * (0.08 + rnd() * 0.8), y = H * (0.15 + rnd() * 0.7), len = 14 + rnd() * 26, a = -0.9 - rnd() * 0.5;
    o += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + Math.cos(a) * len).toFixed(1)}" y2="${(y + Math.sin(a) * len).toFixed(1)}" stroke="url(#streak)" stroke-width="${(1 + rnd() * 1.2).toFixed(1)}" stroke-linecap="round" opacity="${(0.35 + rnd() * 0.5).toFixed(2)}"/>`;
  }
  return o;
}
// the hero art at (x, y, w, h), faded out on the left (and at the bottom if fadeB)
function heroArt(hero, x, y, w, h, { opacity = 1, fadeL = true, fadeB = true, align = 'xMidYMin' } = {}) {
  if (!hero) return '';
  return `<defs>
    <linearGradient id="hL" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="${fadeL ? 0 : 1}"/><stop offset="0.3" stop-color="#fff" stop-opacity="${fadeL ? 0.35 : 1}"/><stop offset="0.55" stop-color="#fff" stop-opacity="1"/></linearGradient>
    <linearGradient id="hB" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="${fadeB ? 0 : 1}"/></linearGradient>
    <mask id="hmL" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#hL)"/></mask>
    <mask id="hmB" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#hB)"/></mask>
  </defs><g opacity="${opacity}" mask="url(#hmB)"><g mask="url(#hmL)"><image x="${x}" y="${y}" width="${w}" height="${h}" href="${hero}" preserveAspectRatio="${align} slice"/></g></g>`;
}
const logoBox = (logo, x, y, s, sym, r = 0.22) => logo
  ? `<clipPath id="lg${x}${y}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * r}"/></clipPath><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * r}" fill="${C.tile}"/><image x="${x}" y="${y}" width="${s}" height="${s}" href="${logo}" clip-path="url(#lg${x}${y})" preserveAspectRatio="xMidYMid slice"/><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * r}" fill="none" stroke="#ffffff" stroke-opacity="0.12"/>`
  : `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * r}" fill="#1f1611" stroke="#4a3020"/>` + T(x + s / 2, y + s * 0.66, esc((sym || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?'), s * 0.45, C.fire, 'text-anchor="middle"');
const glass = (x, y, w, h, r = 16, op = 0.78) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}" fill-opacity="${op}" stroke="#ffffff" stroke-opacity="0.08"/><rect x="${x + 20}" y="${y}" width="${w - 40}" height="2" fill="url(#hair)"/>`;
const kicker = (x, y) => T(x, y, 'STATERA · ARC', 22, C.fire, 'letter-spacing="6"');
const statsOf = (t) => [['MARKET CAP', usd(t?.mcap)], ['LIQUIDITY', usd(t?.liq)], ['VOLUME 24H', usd(t?.volume24h)], ['HOLDERS', cnt(t?.holders)]];
const fit = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const frame = (body, fake, W = 1200, H = 630) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
  <defs>
    <radialGradient id="g1" cx="10%" cy="0%" r="75%"><stop offset="0%" stop-color="#3a1608" stop-opacity="0.55"/><stop offset="70%" stop-color="#3a1608" stop-opacity="0"/></radialGradient>
    <linearGradient id="hair" x1="0" x2="1"><stop offset="0" stop-color="#ff7a1e" stop-opacity="0"/><stop offset="0.5" stop-color="#ff7a1e" stop-opacity="0.7"/><stop offset="1" stop-color="#ff7a1e" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#g1)"/>
  ${body}
  <rect x="0" y="0" width="${W}" height="6" fill="${C.fire}"/>
  ${fake ? `<rect x="0" y="0" width="${W}" height="${W > 700 ? 64 : 56}" fill="#d63a3a"/>` + T(W / 2, W > 700 ? 43 : 38, W > 700 ? 'FAKE — NOT ASSOCIATED WITH STATERA' : 'FAKE — NOT STATERA', W > 700 ? 30 : 26, '#ffffff', 'text-anchor="middle" font-weight="700"') : ''}
</svg>`;

// A — SPLIT HERO: the S on the right, identity + price + the week's chart on the left, a glass stat strip across the bottom
function cardA(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 12)), name = esc(fit(t?.name || 'Arc token', 30));
  let s = heroArt(hero, 640, 0, 560, H) + texture('tL');
  s += kicker(56, 70);
  s += logoBox(logo, 56, 100, 104, t?.symbol) + T(182, 162, `$${sym}`, 62, C.white, 'font-weight="700"') + T(184, 200, name, 24, C.gray);
  s += T(56, 316, priceInner(t?.price, 92), 92, C.white, 'font-weight="700"') + pill(56, 336, t?.change24h, 24);
  s += chart(330, 336, 330, 70, t?.spark, { width: 3, fill: 0.25 }) + T(660, 330, '7D', 14, C.dim, 'text-anchor="end" letter-spacing="2"');
  const st = statsOf(t), sw = (W - 112 - 3 * 12) / 4;
  st.forEach(([k, v], i) => { const x = 56 + i * (sw + 12); s += glass(x, 440, sw, 112) + T(x + 22, 480, k, 15, C.gold, 'letter-spacing="2"') + T(x + 22, 528, esc(v), 38, C.white, 'font-weight="700"'); });
  s += T(56, 600, 'stateraarc.com', 20, C.fire) + T(W - 56, 600, 'Live from Arc mainnet', 18, C.gray, 'text-anchor="end"');
  return frame(s, fake);
}
// B — CHART BACKDROP: the week's chart fills the lower card, the S glowing top-right, price big, stats on glass at the bottom
function cardB(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 12)), name = esc(fit(t?.name || 'Arc token', 30));
  let s = heroArt(hero, 700, 0, 500, 420, { opacity: 0.9 }) + texture('tL', 90);
  s += chart(0, 250, W, 250, t?.spark, { width: 4, fill: 0.38 });
  s += kicker(56, 70);
  s += logoBox(logo, 56, 98, 96, t?.symbol) + T(172, 156, `$${sym}`, 58, C.white, 'font-weight="700"') + T(174, 192, name, 22, C.gray);
  s += T(56, 300, priceInner(t?.price, 84), 84, C.white, 'font-weight="700"') + pill(56, 320, t?.change24h, 24);
  s += T(W - 56, 288, '7 DAYS', 15, C.gray, 'text-anchor="end" letter-spacing="3"');
  s += glass(40, 486, W - 80, 104, 20, 0.86);
  const st = statsOf(t), sw = (W - 80) / 4;
  st.forEach(([k, v], i) => { const x = 40 + i * sw; if (i) s += `<rect x="${x}" y="506" width="1" height="64" fill="${C.edge}"/>`;
    s += T(x + 28, 522, k, 14, C.gold, 'letter-spacing="2"') + T(x + 28, 566, esc(v), 34, C.white, 'font-weight="700"'); });
  s += T(W - 56, 70, 'stateraarc.com', 20, C.fire, 'text-anchor="end"');
  return frame(s, fake);
}
// C — LOGO SPOTLIGHT: the token's logo big on the right on a glow, the S behind it, identity + price + chart on the left
function cardC(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 12)), name = esc(fit(t?.name || 'Arc token', 30)), up = (t?.change24h ?? 0) >= 0;
  let s = heroArt(hero, 560, 0, 640, H, { opacity: 0.55 }) + texture('tL', 110);
  s += `<defs><radialGradient id="spot"><stop offset="0" stop-color="#ff7a1e" stop-opacity="0.45"/><stop offset="0.6" stop-color="#ff7a1e" stop-opacity="0.08"/><stop offset="1" stop-color="#ff7a1e" stop-opacity="0"/></radialGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter></defs>`;
  s += `<circle cx="930" cy="300" r="300" fill="url(#spot)"/>`;
  if (logo) s += `<image x="790" y="160" width="280" height="280" href="${logo}" filter="url(#blur)" opacity="0.7" preserveAspectRatio="xMidYMid slice"/>`;
  s += logoBox(logo, 800, 170, 260, t?.symbol, 0.24);
  s += kicker(56, 70);
  s += T(56, 168, `$${sym}`, 76, C.white, 'font-weight="700"') + T(58, 210, name, 26, C.gray);
  s += T(56, 330, priceInner(t?.price, 90), 90, C.white, 'font-weight="700"') + pill(56, 350, t?.change24h, 24);
  s += chart(56, 420, 600, 60, t?.spark, { width: 3, fill: 0.22 });
  const st = statsOf(t);
  st.forEach(([k, v], i) => { const x = 56 + i * 160; s += T(x, 532, k, 13, C.gold, 'letter-spacing="2"') + T(x, 568, esc(v), 28, C.white, 'font-weight="700"'); });
  s += T(56, 608, 'stateraarc.com', 18, C.fire) + T(W - 56, 608, `Live from Arc mainnet · ${up ? 'up' : 'down'} today`, 16, C.gray, 'text-anchor="end"');
  return frame(s, fake);
}
// D — DASHBOARD: the hero art across the whole card, dimmed; two glass panels — identity + price, and the chart + stats
function cardD(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 12)), name = esc(fit(t?.name || 'Arc token', 26));
  let s = heroArt(hero, 0, -60, W, H + 120, { opacity: 0.5, fadeL: false, fadeB: false, align: 'xMidYMid' }) + `<rect width="${W}" height="${H}" fill="${C.bg}" fill-opacity="0.35"/>` + texture('tA', 100);
  s += kicker(48, 62) + T(W - 48, 62, 'stateraarc.com', 20, C.fire, 'text-anchor="end"');
  s += glass(40, 92, 470, 496, 22, 0.84);
  s += logoBox(logo, 72, 124, 120, t?.symbol) + T(72, 312, `$${sym}`, 62, C.white, 'font-weight="700"') + T(74, 350, name, 22, C.gray);
  s += T(72, 470, priceInner(t?.price, 76), 76, C.white, 'font-weight="700"') + pill(72, 494, t?.change24h, 22);
  s += glass(526, 92, 634, 496, 22, 0.84);
  s += T(558, 136, 'PRICE · 7 DAYS', 15, C.gold, 'letter-spacing="3"');
  s += chart(558, 156, 570, 200, t?.spark, { width: 3, fill: 0.3 });
  const st = statsOf(t), cw = (570 - 12) / 2;
  st.forEach(([k, v], i) => { const x = 558 + (i % 2) * (cw + 12), y = 382 + Math.floor(i / 2) * 98;
    s += `<rect x="${x}" y="${y}" width="${cw}" height="86" rx="14" fill="${C.tile}" stroke="${C.line}"/>` + T(x + 18, y + 32, k, 13, C.gold, 'letter-spacing="2"') + T(x + 18, y + 70, esc(v), 30, C.white, 'font-weight="700"'); });
  return frame(s, fake);
}
export const TOKEN_CARDS = { a: cardA, b: cardB, c: cardC, d: cardD };

// ── SQUARE 600x600 — X's `summary` card (the small thumbnail beside the post text; owner 10-29 screenshot). Read at ~130 px,
// so: big logo, $SYM, price and the 24h change, a hint of the week's chart, the hero art and texture behind.
const S = 600;
const sqPill = (cx, y, v, size = 30) => {
  const t = chgTxt(v); if (!t) return '';
  const label = `${t} 24H`, w = 30 + label.length * size * 0.6, h = size + 20, col = chgCol(v);
  return `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-opacity="0.6" stroke-width="2"/>` + T(cx, y + h / 2 + size * 0.36, label, size, col, 'text-anchor="middle" font-weight="700"');
};
const symFs = (sym, base) => Math.max(40, Math.min(base, Math.floor(540 / Math.max(4, sym.length + 1) * 1.7)));
// SA — HERO: the lava S behind everything (dimmed), logo top-centre, $SYM + price + change, the week's chart along the bottom
function sqA(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10)), fs = symFs(sym, 84);
  let s = heroArt(hero, 0, 0, S, S, { opacity: 0.55, fadeL: false, fadeB: true, align: 'xMidYMid' }) + `<rect width="${S}" height="${S}" fill="${C.bg}" fill-opacity="0.3"/>` + texture('tA', 70, S, S);
  s += chart(0, 430, S, 170, t?.spark, { width: 4, fill: 0.35 });
  s += T(S / 2, 52, 'STATERA · ARC', 20, C.fire, 'text-anchor="middle" letter-spacing="5"');
  s += logoBox(logo, 210, 80, 180, t?.symbol, 0.24);
  s += T(S / 2, 340, `$${sym}`, fs, C.white, 'text-anchor="middle" font-weight="700"');
  s += T(S / 2, 418, priceInner(t?.price, 66), 66, C.white, 'text-anchor="middle" font-weight="700"');
  s += sqPill(S / 2, 446, t?.change24h, 30);
  return frame(s, fake, S, S);
}
// SB — CHART: the week's chart fills the lower half glowing, logo + $SYM + price on top, the S faint top-right
function sqB(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10)), fs = symFs(sym, 72);
  let s = heroArt(hero, 260, 0, 340, 380, { opacity: 0.85 }) + texture('tL', 60, S, S);
  s += chart(0, 330, S, 270, t?.spark, { width: 5, fill: 0.45 });
  s += T(40, 56, 'STATERA · ARC', 19, C.fire, 'letter-spacing="5"');
  s += logoBox(logo, 40, 84, 150, t?.symbol, 0.24);
  s += T(40, 300, `$${sym}`, fs, C.white, 'font-weight="700"');
  s += T(40, 392, priceInner(t?.price, 72), 72, C.white, 'font-weight="700"');
  s += `<rect x="0" y="${S - 92}" width="${S}" height="92" fill="${C.bg}" fill-opacity="0.55"/>` + sqPill(S / 2, S - 76, t?.change24h, 30);
  return frame(s, fake, S, S);
}
// SC — SPOTLIGHT: the token's logo huge on a fire glow with the S behind, a glass price band across the bottom
function sqC(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10)), fs = symFs(sym, 56);
  let s = heroArt(hero, 0, 0, S, 470, { opacity: 0.6, fadeL: false, align: 'xMidYMid' }) + texture('tA', 70, S, S);
  s += `<defs><radialGradient id="spot"><stop offset="0" stop-color="#ff7a1e" stop-opacity="0.55"/><stop offset="0.55" stop-color="#ff7a1e" stop-opacity="0.1"/><stop offset="1" stop-color="#ff7a1e" stop-opacity="0"/></radialGradient></defs>`;
  s += `<circle cx="${S / 2}" cy="230" r="230" fill="url(#spot)"/>`;
  s += logoBox(logo, 160, 70, 280, t?.symbol, 0.24);
  s += T(S / 2, 46, 'STATERA · ARC', 19, C.fire, 'text-anchor="middle" letter-spacing="5"');
  s += `<rect x="24" y="378" width="${S - 48}" height="198" rx="26" fill="${C.panel}" fill-opacity="0.88" stroke="#ffffff" stroke-opacity="0.1"/><rect x="60" y="378" width="${S - 120}" height="2" fill="url(#hair)"/>`;
  s += T(56, 436, `$${sym}`, fs, C.white, 'font-weight="700"') + sqPillRight(S - 56, 404, t?.change24h);
  s += T(56, 524, priceInner(t?.price, 70), 70, C.white, 'font-weight="700"');
  s += chart(330, 470, 214, 70, t?.spark, { width: 3, fill: 0.25 });
  s += T(56, 560, 'stateraarc.com', 17, C.fire);
  return frame(s, fake, S, S);
}
const sqPillRight = (xr, y, v, size = 26) => {
  const t = chgTxt(v); if (!t) return '';
  const label = `${t} 24H`, w = 26 + label.length * size * 0.6, h = size + 18, col = chgCol(v);
  return `<rect x="${xr - w}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-opacity="0.6" stroke-width="2"/>` + T(xr - w / 2, y + h / 2 + size * 0.36, label, size, col, 'text-anchor="middle" font-weight="700"');
};
// SD — SPLIT: the hero art across the top half with the logo sitting on its edge, the bottom half a clean price panel
function sqD(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10)), fs = symFs(sym, 64);
  let s = heroArt(hero, 0, 0, S, 300, { opacity: 1, fadeL: false, align: 'xMidYMid' }) + texture('tA', 50, S, S);
  s += T(32, 50, 'STATERA · ARC', 19, C.fire, 'letter-spacing="5"');
  s += `<rect x="0" y="300" width="${S}" height="${S - 300}" fill="${C.bg}" fill-opacity="0.7"/>`;
  s += `<rect x="38" y="194" width="168" height="168" rx="40" fill="${C.bg}"/>` + logoBox(logo, 46, 202, 152, t?.symbol, 0.24);
  s += T(226, 330, `$${sym}`, fs, C.white, 'font-weight="700"');
  s += T(46, 448, priceInner(t?.price, 80), 80, C.white, 'font-weight="700"');
  s += sqPill(150, 478, t?.change24h, 28) + chart(330, 470, 230, 80, t?.spark, { width: 3, fill: 0.25 });
  s += T(S - 40, 580, 'stateraarc.com', 17, C.fire, 'text-anchor="end"');
  return frame(s, fake, S, S);
}
export const TOKEN_SQUARES = { a: sqA, b: sqB, c: sqC, d: sqD };

// ── SQUARES v2 (owner 10-29: "use the whole square — the right side is empty"): every one fills edge to edge — background
// across the whole square and the full set of numbers inside it (price, 24h, week chart, market cap, liquidity, volume,
// holders), laid out across the full width.
const sqStats = (t, x, y, w, h, gap = 12, cols = 2) => {
  const st = statsOf(t), rows = Math.ceil(st.length / cols), cw = (w - gap * (cols - 1)) / cols, ch = (h - gap * (rows - 1)) / rows;
  return st.map(([k, v], i) => { const xx = x + (i % cols) * (cw + gap), yy = y + Math.floor(i / cols) * (ch + gap);
    return `<rect x="${xx}" y="${yy}" width="${cw}" height="${ch}" rx="14" fill="${C.panel}" fill-opacity="0.82" stroke="#ffffff" stroke-opacity="0.09"/>`
      + T(xx + 16, yy + ch * 0.4, k, 14, C.gold, 'letter-spacing="2"') + T(xx + 16, yy + ch * 0.82, esc(v), Math.min(34, ch * 0.42), C.white, 'font-weight="700"'); }).join('');
};
const bg = (hero, op = 0.6) => heroArt(hero, 0, 0, S, S, { opacity: op, fadeL: false, fadeB: false, align: 'xMidYMid' }) + `<rect width="${S}" height="${S}" fill="${C.bg}" fill-opacity="0.38"/>` + texture('tA', 80, S, S);
// SE — FULL: header row (logo + $SYM + pill), price across the width, the week's chart across the width, 2x2 numbers
function sqE(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10));
  let s = bg(hero, 0.55);
  s += logoBox(logo, 28, 28, 96, t?.symbol) + T(140, 74, `$${sym}`, 50, C.white, 'font-weight="700"') + T(142, 108, 'STATERA · ARC', 16, C.fire, 'letter-spacing="4"');
  s += sqPillRight(S - 28, 44, t?.change24h, 24);
  s += T(28, 214, priceInner(t?.price, 92), 92, C.white, 'font-weight="700"');
  s += chart(28, 236, S - 56, 108, t?.spark, { width: 4, fill: 0.32 }) + T(S - 28, 236, '7D', 13, C.dim, 'text-anchor="end" letter-spacing="2"');
  s += sqStats(t, 28, 362, S - 56, 210);
  return frame(s, fake, S, S);
}
// SF — CHART BED: the week's chart glows across the whole middle, price over it, numbers on one glass bar at the bottom
function sqF(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10));
  let s = bg(hero, 0.6) + chart(0, 190, S, 240, t?.spark, { width: 5, fill: 0.42 });
  s += logoBox(logo, 28, 28, 92, t?.symbol) + T(136, 72, `$${sym}`, 48, C.white, 'font-weight="700"') + T(138, 104, 'STATERA · ARC', 16, C.fire, 'letter-spacing="4"');
  s += T(S - 28, 72, priceInner(t?.price, 46), 46, C.white, 'text-anchor="end" font-weight="700"') + sqPillRight(S - 28, 88, t?.change24h, 22);
  s += `<rect x="20" y="446" width="${S - 40}" height="134" rx="20" fill="${C.panel}" fill-opacity="0.86" stroke="#ffffff" stroke-opacity="0.1"/><rect x="50" y="446" width="${S - 100}" height="2" fill="url(#hair)"/>`;
  const st = statsOf(t), cw = (S - 40) / 2;
  st.forEach(([k, v], i) => { const x = 20 + (i % 2) * cw + 24, y = 446 + Math.floor(i / 2) * 64; s += T(x, y + 30, k, 13, C.gold, 'letter-spacing="2"') + T(x, y + 58, esc(v), 26, C.white, 'font-weight="700"'); });
  s += `<rect x="${20 + cw}" y="466" width="1" height="94" fill="${C.edge}"/>`;
  return frame(s, fake, S, S);
}
// SG — CENTRED: big logo centre-top on a glow, $SYM + price centred, chart under it, the four numbers in a full-width row
function sqG(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10));
  let s = bg(hero, 0.65) + `<defs><radialGradient id="spot"><stop offset="0" stop-color="#ff7a1e" stop-opacity="0.5"/><stop offset="1" stop-color="#ff7a1e" stop-opacity="0"/></radialGradient></defs><circle cx="${S / 2}" cy="120" r="170" fill="url(#spot)"/>`;
  s += logoBox(logo, 230, 36, 140, t?.symbol, 0.24);
  s += T(S / 2, 236, `$${sym}`, 54, C.white, 'text-anchor="middle" font-weight="700"');
  s += T(S / 2, 318, priceInner(t?.price, 74), 74, C.white, 'text-anchor="middle" font-weight="700"');
  s += sqPill(S / 2, 336, t?.change24h, 24) + chart(28, 394, S - 56, 70, t?.spark, { width: 3, fill: 0.28 });
  s += sqStats(t, 20, 482, S - 40, 98, 8, 4);
  return frame(s, fake, S, S);
}
// SH — PANEL: the art full-bleed, one big glass panel across the square holding everything
function sqH(t, logo, hero, fake) {
  const sym = esc(fit(t?.symbol || 'TOKEN', 10));
  let s = bg(hero, 0.8);
  s += T(S / 2, 44, 'STATERA · ARC', 18, C.fire, 'text-anchor="middle" letter-spacing="5"');
  s += `<rect x="24" y="68" width="${S - 48}" height="${S - 92}" rx="28" fill="${C.panel}" fill-opacity="0.72" stroke="#ffffff" stroke-opacity="0.12"/><rect x="64" y="68" width="${S - 128}" height="2" fill="url(#hair)"/>`;
  s += logoBox(logo, 52, 96, 104, t?.symbol) + T(176, 146, `$${sym}`, 50, C.white, 'font-weight="700"') + T(178, 180, esc(fit(t?.name || '', 22)), 18, C.gray);
  s += T(52, 286, priceInner(t?.price, 84), 84, C.white, 'font-weight="700"') + sqPillRight(S - 52, 232, t?.change24h, 24);
  s += chart(52, 300, S - 104, 86, t?.spark, { width: 3, fill: 0.3 });
  s += sqStats(t, 52, 404, S - 104, 156, 10);
  return frame(s, fake, S, S);
}
export const TOKEN_SQUARES_V2 = { e: sqE, f: sqF, g: sqG, h: sqH };

// ── STRIP 1200x400 (owner 10-29: "smaller, wider, shorter") — the test for X's full-width card at a short height:
// identity + price on the left over the texture, the week's chart through the middle, numbers on the right, the S behind.
export function tokenStrip(t, logo, hero, fake) {
  const SW = 1200, SH = 400, sym = esc(fit(t?.symbol || 'TOKEN', 11));
  let s = heroArt(hero, 0, 0, SW, SH, { opacity: 0.5, fadeL: false, fadeB: false, align: 'xMidYMid' }) + `<rect width="${SW}" height="${SH}" fill="${C.bg}" fill-opacity="0.35"/>` + texture('tA', 110, SW, SH);
  s += chart(0, 170, SW, 230, t?.spark, { width: 4, fill: 0.3 });
  s += T(44, 56, 'STATERA · ARC', 18, C.fire, 'letter-spacing="5"');
  s += logoBox(logo, 44, 80, 112, t?.symbol) + T(176, 140, `$${sym}`, 58, C.white, 'font-weight="700"') + T(178, 176, esc(fit(t?.name || '', 26)), 20, C.gray);
  s += T(44, 296, priceInner(t?.price, 92), 92, C.white, 'font-weight="700"') + pill(48, 318, t?.change24h, 24);
  const st = statsOf(t);
  s += `<rect x="${SW - 384}" y="40" width="344" height="320" rx="22" fill="${C.panel}" fill-opacity="0.8" stroke="#ffffff" stroke-opacity="0.1"/><rect x="${SW - 354}" y="40" width="284" height="2" fill="url(#hair)"/>`;
  st.forEach(([k, v], i) => { const y = 64 + i * 74; if (i) s += `<rect x="${SW - 360}" y="${y - 8}" width="296" height="1" fill="${C.edge}"/>`;
    s += T(SW - 360, y + 22, k, 14, C.gold, 'letter-spacing="2"') + T(SW - 360, y + 58, esc(v), 32, C.white, 'font-weight="700"'); });
  s += T(SW - 384, 386, 'stateraarc.com', 17, C.fire);
  return frame(s, fake, SW, SH);
}
