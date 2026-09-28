import { Resvg, initWasm } from '@resvg/resvg-wasm';
import FONT_B64 from '../lib/ogfont.js';
import WASM_B64 from '../lib/ogwasm.js';
import { fetchUpstream } from '../lib/upstream.js';

// ARC NETWORK REPORT — the whole Network page as one image, drawn from the live /v2 data (chain, lending, where) at request
// time. Owner 09-28: "a full snapshot report image I can just post on X". Same renderer as the token cards (resvg WASM +
// the embedded font; see api/og.js for why). Formats:
//   /api/report                → 1200×1500 (4:5 — fills the X timeline when attached to a post)
//   /api/report?wide=1         → 1200×630 (the link-card image /network unfurls into)
//   &download=1                → served as an attachment (the "Download report" button)
// Any failure → the static site card (X keeps a broken image for good, so never an error).
const FONT = Buffer.from(FONT_B64, 'base64');
let wasmReady = null;
const ensureWasm = () => (wasmReady ||= initWasm(Buffer.from(WASM_B64, 'base64')));
const within = (p, ms, fb = null) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]).catch(() => fb);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const usd = (n) => (n == null || !isFinite(n) ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : n >= 0.01 ? '$' + n.toFixed(2) : '$' + n.toFixed(4));
const num = (n, d = 0) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const C = { bg: '#0a0806', panel: '#141110', line: '#2a2522', fire: '#ff7a1e', gold: '#ffc24a', white: '#ffffff', gray: '#a39a90', dim: '#6a635a', green: '#4ecb71', red: '#ff5a3c',
  lend: '#ff7a1e', dex: '#4ecb71', bridge: '#5aa9ff', ctr: '#a58bff', wal: '#6b6d75' };
const BUCKETS = [['lending', 'Lending', C.lend], ['dex', 'DEX pools', C.dex], ['bridge', 'Gateway', C.bridge], ['contracts', 'Other contracts', C.ctr], ['wallets', 'Wallets', C.wal]];
const NAME = { USDC: 'US dollars (USDC)', EURC: 'Euros (EURC)', cirBTC: 'Bitcoin (cirBTC)' };
const VALIDATORS = ['Circle · BlackRock · DTCC · Galaxy · Global Payments · ICE', 'Mastercard · MoneyGram · SBI Group · Standard Chartered · Sumitomo · Visa'];

async function v2(path) {
  const UP = process.env.HOLDINGS_UPSTREAM, KEY = process.env.HOLDINGS_KEY;
  if (!UP || !KEY) return null;
  const r = await fetchUpstream(`${UP.replace(/\/+$/, '')}/v2/${path}`, { headers: { 'x-relay-key': KEY } }, { tries: 3, timeoutMs: 1500, lastTimeoutMs: 3000 });
  return r.ok ? r.json() : null;
}
const T = (x, y, s, size, fill = C.white, extra = '') => `<text x="${x}" y="${y}" font-family="Open Sans" font-size="${size}" fill="${fill}" ${extra}>${s}</text>`;
const panel = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${C.panel}" stroke="${C.line}"/><rect x="${x + 24}" y="${y}" width="${w - 48}" height="2" fill="url(#hair)"/>`;

// Shared pieces for both layouts.
const bar = (x, y, wdt, h, parts, bg = '#221e1b') => {   // parts: [fraction 0..1, color]
  let out = `<rect x="${x}" y="${y}" width="${wdt}" height="${h}" rx="${h / 2}" fill="${bg}"/>`, cx = x;
  const vis = parts.filter(([f]) => f >= 0.003);
  vis.forEach(([f, col], i) => { const ww = Math.max(2, wdt * f); const r = i === 0 || i === vis.length - 1 ? h / 2 : 0;
    out += `<rect x="${cx}" y="${y}" width="${ww}" height="${h}" rx="${r}" fill="${col}"/>`; if (i > 0) out += `<rect x="${cx}" y="${y}" width="2" height="${h}" fill="#0a0806"/>`; cx += ww; });
  return out;
};
const takeaways = (c, l, w) => {
  const out = [];
  const bt = w?.assets?.find((a) => a.sym === 'cirBTC'), us = w?.assets?.find((a) => a.sym === 'USDC');
  if (bt && bt.supply > 0) out.push(`${pct(bt.buckets.lending, bt.supply).toFixed(0)}% of the Bitcoin on Arc is loan collateral — only ${pct(bt.buckets.dex, bt.supply).toFixed(1)}% is in DEX pools`);
  if (l?.morpho?.complete && l.morpho.supplyUsd > 0) out.push(`Morpho is ${Math.round((l.morpho.borrowUsd / l.morpho.supplyUsd) * 100)}% borrowed — ${usd(l.morpho.borrowUsd)} of ${usd(l.morpho.supplyUsd)} lent out`);
  else if (us && us.supply > 0) out.push(`${pct(us.buckets.wallets, us.supply).toFixed(0)}% of USDC on Arc sits in wallets, ${pct(us.buckets.lending, us.supply).toFixed(0)}% in lending`);
  return out;
};

function tall(c, l, w, when, logos) {
  const W = 1200, H = 1500, P = 56, IW = W - 2 * P; let s = '', y;
  // ── header
  s += T(P, 70, 'STATERA · ARC', 24, C.fire, 'letter-spacing="6"') + T(W - P, 70, esc(when), 22, C.gray, 'text-anchor="end"');
  s += T(P, 128, 'Arc Network Report', 54) + T(W - P, 126, c ? `block ${num(c.head)}` : '', 22, C.dim, 'text-anchor="end"');
  // ── headline takeaways (the hook)
  const tk = takeaways(c, l, w); y = 156;
  s += `<rect x="${P}" y="${y}" width="${IW}" height="${24 + tk.length * 38}" rx="16" fill="#1d1510" stroke="#4a2f1c"/><rect x="${P}" y="${y + 14}" width="4" height="${tk.length * 38 - 4}" rx="2" fill="${C.fire}"/>`;
  tk.forEach((t, i) => { s += T(P + 26, y + 42 + i * 38, esc(t), 22, C.white); });
  // ── pulse
  y = 262; const pw = (IW - 3 * 14) / 4, fee = c ? (21000 * c.baseFeeGwei * 1e9) / 1e18 : null;
  [[c?.h1 ? `${c.h1.blockTime.toFixed(2)}s` : '—', 'NEW BLOCK', 'final — no reorgs', C.white],
   [c?.m5 ? num(c.m5.tps) : '—', 'TX / SECOND', c?.h1 ? `${num(c.h1.txs)} in the last hour` : '', C.white],
   [fee != null ? (fee < 0.01 ? '$' + fee.toFixed(4) : usd(fee)) : '—', 'TO SEND MONEY', 'gas is paid in USDC', C.green],
   [c ? String(c.validatorCount) : '—', 'VALIDATORS', 'taking equal turns', C.white]]
    .forEach(([v, k, d, col], i) => { const x = P + i * (pw + 14); s += panel(x, y, pw, 112) + T(x + 20, y + 50, esc(v), 38, col) + T(x + 20, y + 78, k, 15, C.gold, 'letter-spacing="2"') + T(x + 20, y + 100, esc(d), 16, C.gray); });
  // ── money on Arc
  y = 390; const mh = 372; s += panel(P, y, IW, mh);
  const tot = c?.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((a, k) => a + (c.supplyUsd[k] || 0), 0) : null;
  s += T(P + 24, y + 46, 'MONEY ON ARC', 22, C.white, 'letter-spacing="2"') + T(W - P - 24, y + 50, usd(tot), 44, C.fire, 'text-anchor="end"');
  s += T(P + 24, y + 74, "Circle's assets on Arc (full supply, from each token contract) and where each one sits right now", 16, C.gray);
  ['USDC', 'EURC', 'cirBTC'].forEach((k, i) => {
    const yy = y + 104 + i * 88, a = w?.assets?.find((x) => x.sym === k), val = c?.supplyUsd?.[k];
    s += T(P + 24, yy + 18, NAME[k], 21) + T(W - P - 24, yy + 18, usd(val), 22, C.white, 'text-anchor="end"');
    if (a && a.supply > 0) {
      s += bar(P + 24, yy + 30, IW - 48, 16, BUCKETS.map(([bk, , col]) => [a.buckets[bk] / a.supply, col]));
      let lx = P + 24;
      for (const [bk, label, col] of BUCKETS) { const f = a.buckets[bk] / a.supply; if (f < 0.01) continue;
        const t = `${label} ${(f * 100).toFixed(1)}% · ${usd(val != null ? val * f : null)}`;
        s += `<rect x="${lx}" y="${yy + 60}" width="11" height="11" rx="3" fill="${col}"/>` + T(lx + 17, yy + 70, esc(t), 15, C.gray); lx += 34 + t.length * 7.6; }
    }
  });
  // ── bridge + lending
  y = 778; const hw = (IW - 14) / 2, bh = 296, f = c?.cctp?.h1;
  s += panel(P, y, hw, bh) + T(P + 22, y + 44, 'BRIDGED · LAST HOUR', 20, C.white, 'letter-spacing="2"') + T(P + 22, y + 68, "Circle's CCTP bridge, in and out of Arc", 15, C.gray);
  if (f) {
    const net = f.in.usd - f.out.usd, sum = f.in.usd + f.out.usd || 1;
    s += T(P + 22, y + 118, usd(f.in.usd), 34, C.green) + T(P + 22, y + 140, `in · ${f.in.count} transfers`, 15, C.gray);
    s += T(P + hw - 22, y + 118, usd(f.out.usd), 34, C.red, 'text-anchor="end"') + T(P + hw - 22, y + 140, `out · ${f.out.count} transfers`, 15, C.gray, 'text-anchor="end"');
    s += bar(P + 22, y + 154, hw - 44, 12, [[f.in.usd / sum, C.green], [f.out.usd / sum, C.red]]);
    s += T(P + 22, y + 196, `Net ${net >= 0 ? '+' : '−'}${usd(Math.abs(net))} ${net >= 0 ? 'into' : 'out of'} Arc`, 20, net >= 0 ? C.green : C.red);
    const ins = f.in.byChain.slice(0, 3), outs = f.out.byChain.slice(0, 3);
    // (no arrow glyphs: the embedded font has none — they rendered as nothing)
    ins.forEach((x, i) => { s += T(P + 22, y + 228 + i * 21, esc(`from ${x.chain} ${usd(x.usd)}`), 15, C.gray); });
    outs.forEach((x, i) => { s += T(P + hw - 22, y + 228 + i * 21, esc(`to ${x.chain} ${usd(x.usd)}`), 15, C.gray, 'text-anchor="end"'); });
  }
  const lx0 = P + hw + 14; s += panel(lx0, y, hw, bh) + T(lx0 + 22, y + 44, 'LENDING', 20, C.white, 'letter-spacing="2"') + T(lx0 + 22, y + 68, 'Deposits earn interest; borrowers post collateral', 15, C.gray);
  if (l) {
    const mOk = !!l.morpho?.complete, lent = l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0), bor = l.aave.borrowUsd + (mOk ? l.morpho.borrowUsd : 0);
    s += T(lx0 + 22, y + 118, usd(lent), 34) + T(lx0 + 22, y + 140, 'lent', 15, C.gray);
    s += T(lx0 + hw - 22, y + 118, usd(bor), 34, C.gold, 'text-anchor="end"') + T(lx0 + hw - 22, y + 140, `borrowed · ${lent > 0 ? Math.round((bor / lent) * 100) : 0}% used`, 15, C.gray, 'text-anchor="end"');
    const rows = [['Aave', l.aave.supplyUsd, l.aave.borrowUsd], ...(mOk ? [['Morpho', l.morpho.supplyUsd, l.morpho.borrowUsd]] : [])];
    rows.forEach(([n, a, b], i) => { const yy = y + 184 + i * 50, u = a > 0 ? b / a : 0;
      s += T(lx0 + 22, yy, n, 19) + T(lx0 + hw - 22, yy, `${usd(a)} · ${Math.round(u * 100)}% borrowed`, 16, C.gray, 'text-anchor="end"');
      s += bar(lx0 + 22, yy + 12, hw - 44, 10, [[u, u >= 0.9 ? C.red : C.gold]]); });
    if (!mOk) s += T(lx0 + 22, y + 280, 'Morpho: still counting its markets', 14, C.dim);
  }
  // ── validators (logo grid)
  y = 1090; s += panel(P, y, IW, 214) + T(P + 24, y + 42, 'WHO RUNS THE CHAIN', 20, C.white, 'letter-spacing="2"');
  s += T(W - P - 24, y + 42, c ? `${c.validatorCount} block producers on chain · equal turns` : '', 15, C.gray, 'text-anchor="end"');
  const cw = (IW - 48 - 5 * 10) / 6;
  VAL_LIST.forEach((v, i) => { const x = P + 24 + (i % 6) * (cw + 10), yy = y + 64 + Math.floor(i / 6) * 66;
    s += `<rect x="${x}" y="${yy}" width="${cw}" height="54" rx="10" fill="#1b1714" stroke="${C.line}"/>`;
    const img = v.logo && logos[v.logo];
    s += img ? `<rect x="${x + 10}" y="${yy + 11}" width="32" height="32" rx="7" fill="#ffffff"/><image x="${x + 13}" y="${yy + 14}" width="26" height="26" href="${img}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${x + 10}" y="${yy + 11}" width="32" height="32" rx="7" fill="#2a1a10" stroke="#5a3a20"/>` + T(x + 26, yy + 33, v.name.split(' ').map((q) => q[0]).join('').slice(0, 2), 13, C.gold, 'text-anchor="middle"');
    s += T(x + 50, yy + 33, esc(v.short || v.name), 15, C.white); });
  s += T(P + 24, y + 200, 'Founding validators named by Circle. The chain records addresses only; which institution runs which is not published.', 13, C.dim);
  // ── footer
  s += `<rect x="0" y="${H - 170}" width="${W}" height="170" fill="url(#foot)"/>`;
  s += T(P, H - 70, 'stateraarc.com/network', 30, C.fire) + T(W - P, H - 70, 'Live · read directly from Arc mainnet', 20, C.gray, 'text-anchor="end"');
  s += T(P, H - 38, 'Screener · Swap · Portfolio · Network', 18, C.dim) + T(W - P, H - 38, 'chain 5042', 18, C.dim, 'text-anchor="end"');
  return svg(W, H, s, 44); // rounded corners (owner 09-28): the downloaded report is a card, not a square
}

// X link card (1200×630). ⛔ X lays its own title label over the BOTTOM-LEFT (~0–600 × 560–630): nothing important goes there.
function wide(c, l, w, when) {
  const W = 1200, H = 630, P = 48; let s = '';
  s += T(P, 62, 'STATERA · ARC', 22, C.fire, 'letter-spacing="6"') + T(W - P, 62, 'stateraarc.com/network', 22, C.fire, 'text-anchor="end"');
  s += T(P, 118, 'Arc Network Report', 48) + T(W - P, 116, esc(when), 20, C.gray, 'text-anchor="end"');
  const tot = c?.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((a, k) => a + (c.supplyUsd[k] || 0), 0) : null;
  const stable = c?.supplyUsd ? (c.supplyUsd.USDC || 0) + (c.supplyUsd.EURC || 0) : null, btc = c?.supplyUsd?.cirBTC ?? null;
  const mOk = !!l?.morpho?.complete, lent = l ? l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0) : null, bor = l ? l.aave.borrowUsd + (mOk ? l.morpho.borrowUsd : 0) : null;
  const f = c?.cctp?.h1, net = f ? f.in.usd - f.out.usd : null;
  const cells = [
    [usd(tot), 'MONEY ON ARC', `${usd(stable)} stables · ${usd(btc)} BTC`, C.fire],
    [usd(lent), 'LENT', bor != null ? `${usd(bor)} borrowed · ${lent ? Math.round((bor / lent) * 100) : 0}%` : '', C.white],
    [c?.m5 ? `${num(c.m5.tps)} tx/s` : '—', 'THROUGHPUT', c?.h1 ? `${num(c.h1.txs)} tx/hr · ${c.h1.blockTime.toFixed(2)}s blocks` : '', C.white],
    [net == null ? '—' : `${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`, 'BRIDGED NET · 1H', f ? `${usd(f.in.usd)} in · ${usd(f.out.usd)} out` : '', net != null && net >= 0 ? C.green : C.red],
  ];
  const cw = (W - 2 * P - 3 * 14) / 4;
  cells.forEach(([v, k, d, col], i) => { const x = P + i * (cw + 14); s += panel(x, 148, cw, 150) + T(x + 18, 206, esc(v), 36, col) + T(x + 18, 236, k, 15, C.gold, 'letter-spacing="2"') + T(x + 18, 268, esc(d), 15, C.gray); });
  // Bitcoin where-it-sits bar + lending utilization + validators
  const bt = w?.assets?.find((a) => a.sym === 'cirBTC');
  s += panel(P, 316, W - 2 * P, 116);
  s += T(P + 20, 350, 'WHERE THE BITCOIN SITS', 15, C.gold, 'letter-spacing="2"');
  if (bt && bt.supply > 0) {
    s += bar(P + 20, 364, W - 2 * P - 40, 16, BUCKETS.map(([bk, , col]) => [bt.buckets[bk] / bt.supply, col]));
    s += T(P + 20, 412, esc(`Lending ${pct(bt.buckets.lending, bt.supply).toFixed(1)}%  ·  DEX pools ${pct(bt.buckets.dex, bt.supply).toFixed(1)}%  ·  Wallets ${pct(bt.buckets.wallets, bt.supply).toFixed(1)}%`), 18, C.white);
  }
  const mU = mOk && l.morpho.supplyUsd > 0 ? Math.round((l.morpho.borrowUsd / l.morpho.supplyUsd) * 100) : null;
  s += panel(P, 448, (W - 2 * P - 14) / 2, 96) + T(P + 20, 482, 'MORPHO UTILIZATION', 15, C.gold, 'letter-spacing="2"') + T(P + 20, 524, mU != null ? `${mU}% borrowed` : 'counting…', 28, mU != null && mU >= 90 ? C.red : C.white);
  const x2 = P + (W - 2 * P - 14) / 2 + 14;
  s += panel(x2, 448, (W - 2 * P - 14) / 2, 96) + T(x2 + 20, 482, 'VALIDATORS', 15, C.gold, 'letter-spacing="2"') + T(x2 + 20, 524, c ? `${c.validatorCount} · Circle, BlackRock, Visa, Mastercard +8` : '—', 22, C.white);
  s += T(W - P, 600, 'Live from Arc mainnet', 18, C.gray, 'text-anchor="end"');
  return svg(W, H, s);
}
const VAL_LIST = [
  { name: 'Circle', logo: 'circle' }, { name: 'BlackRock', logo: 'blackrock' }, { name: 'DTCC', logo: 'dtcc' }, { name: 'Galaxy', logo: 'galaxy' },
  { name: 'Global Payments', short: 'Global Pay.', logo: 'globalpayments' }, { name: 'ICE', logo: 'ice' }, { name: 'Mastercard', logo: 'mastercard' }, { name: 'MoneyGram', logo: 'moneygram' },
  { name: 'SBI Group' }, { name: 'Standard Chartered', short: 'Std Chartered', logo: 'standardchartered' }, { name: 'Sumitomo' }, { name: 'Visa', logo: 'visa' },
];
// Validator icons as data URIs, fetched once from our own static files (resvg can't fetch URLs itself).
let logoCache = null;
async function validatorLogos(origin) {
  if (logoCache) return logoCache;
  const out = {};
  await Promise.all(VAL_LIST.filter((v) => v.logo).map(async (v) => {
    try { const r = await fetch(`${origin}/validators/${v.logo}.png`, { signal: AbortSignal.timeout(2500) }); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); const jpg = b[0] === 0xff && b[1] === 0xd8; out[v.logo] = `data:image/${jpg ? 'jpeg' : 'png'};base64,${b.toString('base64')}`; } } catch { /* letter badge */ }
  }));
  if (Object.keys(out).length >= 6) logoCache = out;
  return out;
}
// radius > 0 = transparent rounded corners (everything clipped to a rounded card); 0 = square (X rounds link cards itself).
const svg = (W, H, body, radius = 0) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
  <defs>
    <radialGradient id="g1" cx="10%" cy="0%" r="70%"><stop offset="0%" stop-color="#ff7a1e" stop-opacity="0.20"/><stop offset="70%" stop-color="#ff7a1e" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="100%" cy="100%" r="60%"><stop offset="0%" stop-color="#ff2f14" stop-opacity="0.10"/><stop offset="70%" stop-color="#ff2f14" stop-opacity="0"/></radialGradient>
    <linearGradient id="foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0806" stop-opacity="0"/><stop offset="1" stop-color="#1a0f08"/></linearGradient>
    <linearGradient id="hair" x1="0" x2="1"><stop offset="0" stop-color="#ffa03c" stop-opacity="0"/><stop offset="0.5" stop-color="#ffa03c" stop-opacity="0.7"/><stop offset="1" stop-color="#ffa03c" stop-opacity="0"/></linearGradient>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
  <rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${C.fire}"/>
  ${body}
  </g>
  ${radius ? `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${radius - 1}" fill="none" stroke="#3a2a1e" stroke-width="2"/>` : ''}
</svg>`;

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const isWide = u.searchParams.get('wide') === '1', download = u.searchParams.get('download') === '1';
    const origin = `https://${req.headers.host || 'www.stateraarc.com'}`;
    const [c, l, w, logos] = await Promise.all([within(v2('chain'), 4500), within(v2('lending'), 4500), within(v2('where'), 4500), isWide ? {} : within(validatorLogos(origin), 3000, {}), ensureWasm()]);
    if (!c) throw new Error('no chain data');
    const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const png = new Resvg(isWide ? wide(c, l, w, when) : tall(c, l, w, when, logos || {}), {
      font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    // Timestamped name: several downloads in a day were all 'arc-network-report-<date>.png' and the old one got opened.
    if (download) res.setHeader('content-disposition', `attachment; filename="arc-network-report-${when.slice(0, 16).replace(/[: ]/g, '-')}.png"`);
    if (download) res.setHeader('cache-control', 'no-store');
    res.status(200).send(Buffer.from(png));
  } catch (e) {
    res.setHeader('x-report-error', String(e?.message || e).slice(0, 200));
    res.setHeader('cache-control', 'no-store');
    res.statusCode = 302; res.setHeader('location', '/og-card.jpg'); res.end();
  }
}
