import { Resvg, initWasm } from '@resvg/resvg-wasm';
import FONT_B64 from '../lib/ogfont.js';
import WASM_B64 from '../lib/ogwasm.js';
import { fetchUpstream } from '../lib/upstream.js';
import { noEmoji } from '../lib/clean.js';

// ARC NETWORK REPORT — the whole Network page as one image, drawn from the live /v2 data (chain, lending, where) at request
// time. Owner 09-28: "a full snapshot report image I can just post on X". Same renderer as the token cards (resvg WASM +
// the embedded font; see api/og.js for why). Formats:
//   /api/report                → 1200×1500 (4:5 — fills the X timeline when attached to a post)
//   /api/report?wide=1         → 1200×630 (the link-card image /network unfurls into)
//   /api/report?token=0x…      → the token page as one image (1200×1500), same look (owner 09-29)
//   &download=1                → served as an attachment (the "Download report" / "Snapshot" buttons)
// Both tall images carry a SNAPSHOT stamp — the exact date and time (to the second, UTC) the data was read (owner 09-29).
// Any failure → the static site card (X keeps a broken image for good, so never an error).
const FONT = Buffer.from(FONT_B64, 'base64');
let wasmReady = null;
const ensureWasm = () => (wasmReady ||= initWasm(Buffer.from(WASM_B64, 'base64')));
const within = (p, ms, fb = null) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]).catch(() => fb);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const usd = (n) => (n == null || !isFinite(n) ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : n >= 0.01 ? '$' + n.toFixed(2) : '$' + n.toFixed(4));
const num = (n, d = 0) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
// Neutral near-black like the site's balanced theme (owner 09-29: the old brown/sepia cast looked muddy) — colour only
// for meaning and the fire accents.
const C = { bg: '#060607', panel: '#0d0d10', tile: '#131317', line: '#24242b', edge: '#2c2c33', barBg: '#1c1c22', fire: '#ff7a1e', gold: '#ffc24a',
  white: '#f6f7f8', gray: '#a3a3ad', dim: '#6b6b75', green: '#4ecb71', red: '#ff5a3c',
  lend: '#ff7a1e', dex: '#4ecb71', bridge: '#5aa9ff', ctr: '#a58bff', wal: '#5d5f68' };
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
const bar = (x, y, wdt, h, parts, bg = C.barBg) => {   // parts: [fraction 0..1, color]
  let out = `<rect x="${x}" y="${y}" width="${wdt}" height="${h}" rx="${h / 2}" fill="${bg}"/>`, cx = x;
  const vis = parts.filter(([f]) => f >= 0.003);
  vis.forEach(([f, col], i) => { const ww = Math.max(2, wdt * f); const r = i === 0 || i === vis.length - 1 ? h / 2 : 0;
    out += `<rect x="${cx}" y="${y}" width="${ww}" height="${h}" rx="${r}" fill="${col}"/>`; if (i > 0) out += `<rect x="${cx}" y="${y}" width="2" height="${h}" fill="${C.panel}"/>`; cx += ww; });
  return out;
};
// SNAPSHOT stamp: when the numbers were read, to the second. A pill top-right on both tall images.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const stampOf = (d) => ({
  date: `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`,
  file: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}_${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}`,
});
const stampPill = (xr, y, st, sub) => {  // right-aligned at xr, top at y
  const w = 330;
  return `<rect x="${xr - w}" y="${y}" width="${w}" height="${sub ? 84 : 64}" rx="14" fill="${C.tile}" stroke="${C.edge}"/>`
    + `<circle cx="${xr - w + 22}" cy="${y + 22}" r="5" fill="${C.fire}"/>`
    + T(xr - w + 36, y + 28, 'SNAPSHOT', 14, C.fire, 'letter-spacing="3"') + T(xr - 18, y + 28, esc(st.date), 15, C.gray, 'text-anchor="end"')
    + T(xr - w + 18, y + 55, esc(st.time), 24, C.white) + (sub ? T(xr - w + 18, y + 75, esc(sub), 14, C.dim) : '');
};
const takeaways = (c, l, w) => {
  const out = [];
  const bt = w?.assets?.find((a) => a.sym === 'cirBTC'), us = w?.assets?.find((a) => a.sym === 'USDC');
  if (bt && bt.supply > 0) out.push(`${pct(bt.buckets.lending, bt.supply).toFixed(0)}% of the Bitcoin on Arc is loan collateral — only ${pct(bt.buckets.dex, bt.supply).toFixed(1)}% is in DEX pools`);
  if (l?.morpho?.complete && l.morpho.supplyUsd > 0) out.push(`Morpho is ${Math.round((l.morpho.borrowUsd / l.morpho.supplyUsd) * 100)}% borrowed — ${usd(l.morpho.borrowUsd)} of ${usd(l.morpho.supplyUsd)} lent out`);
  else if (us && us.supply > 0) out.push(`${pct(us.buckets.wallets, us.supply).toFixed(0)}% of USDC on Arc sits in wallets, ${pct(us.buckets.lending, us.supply).toFixed(0)}% in lending`);
  return out;
};

function tall(c, l, w, st, logos) {
  const W = 1200, H = 1420, P = 56, IW = W - 2 * P; let s = '', y;
  // ── header (+ the SNAPSHOT stamp: date, time to the second, block)
  s += T(P, 70, 'STATERA · ARC', 24, C.fire, 'letter-spacing="6"');
  s += T(P, 128, 'Arc Network Report', 54) + stampPill(W - P, 40, st, c ? `at block ${num(c.head)}` : '');
  // ── headline takeaways (the hook)
  const tk = takeaways(c, l, w); y = 156;
  s += `<rect x="${P}" y="${y}" width="${IW}" height="${24 + tk.length * 38}" rx="16" fill="#110c09" stroke="#3a2516"/><rect x="${P}" y="${y + 14}" width="4" height="${tk.length * 38 - 4}" rx="2" fill="${C.fire}"/>`;
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
    s += `<rect x="${x}" y="${yy}" width="${cw}" height="54" rx="10" fill="${C.tile}" stroke="${C.line}"/>`;
    const img = v.logo && logos[v.logo];
    s += img ? `<rect x="${x + 10}" y="${yy + 11}" width="32" height="32" rx="7" fill="#ffffff"/><image x="${x + 13}" y="${yy + 14}" width="26" height="26" href="${img}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${x + 10}" y="${yy + 11}" width="32" height="32" rx="7" fill="#1f1611" stroke="#4a3020"/>` + T(x + 26, yy + 33, v.name.split(' ').map((q) => q[0]).join('').slice(0, 2), 13, C.gold, 'text-anchor="middle"');
    s += T(x + 50, yy + 33, esc(v.short || v.name), 15, C.white); });
  s += T(P + 24, y + 200, 'Founding validators named by Circle. The chain records addresses only; which institution runs which is not published.', 13, C.dim);
  // ── footer
  s += `<rect x="0" y="${H - 150}" width="${W}" height="150" fill="url(#foot)"/>`;
  s += T(P, H - 70, 'stateraarc.com/network', 30, C.fire) + T(W - P, H - 70, 'Live · read directly from Arc mainnet', 20, C.gray, 'text-anchor="end"');
  s += T(P, H - 38, 'Screener · Swap · Portfolio · Network', 18, C.dim) + T(W - P, H - 38, 'chain 5042', 18, C.dim, 'text-anchor="end"');
  return svg(W, H, s, 44, NETWORK_ACCENT); // rounded corners (owner 09-28): the downloaded report is a card, not a square
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
  return svg(W, H, s, 0, NETWORK_ACCENT);
}
// ── TOKEN SNAPSHOT (the token page as one image) ────────────────────────────────────────────────────────────────────
// Price as SVG inner markup; tiny prices get a subscript zero count ($0.0₅2485) drawn with a normal digit (same as og.js).
const priceInner = (n, fs) => {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + num(n, 0);
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  const m = n.toFixed(14).match(/^0\.(0*)(\d+?)0*$/);
  if (!m) return '$' + n.toPrecision(3);
  const zeros = m[1].length, sig = m[2].slice(0, 4);
  if (zeros < 4) return '$0.' + m[1] + sig;
  const sub = Math.round(fs * 0.58), dy = Math.round(fs * 0.22);
  return `$0.0<tspan font-size="${sub}" dy="${dy}">${zeros}</tspan><tspan font-size="${fs}" dy="${-dy}">${sig}</tspan>`;
};
const chg = (v) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);
const chgCol = (v) => (v == null || !isFinite(v) ? C.gray : v >= 0 ? C.green : C.red);
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
const hhmm = (sec) => { const d = new Date(sec * 1000); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const KNOWN_HOLDER = { '0x8366a39cc670b4001a1121b8f6a443a643e40951': 'Uniswap V4 pools', '0x000000000000000000000000000000000000dead': 'Burned' };

function candleChart(x, y, w, h, cs, lineCol = C.fire) {
  if (!cs || cs.length < 2) return T(x + w / 2, y + h / 2, 'Not enough trades yet for a chart', 18, C.dim, 'text-anchor="middle"');
  const volH = Math.round(h * 0.16), ph = h - volH - 10;
  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const c of cs) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); vmax = Math.max(vmax, c.volume || 0); }
  if (!(hi > lo)) { hi = lo * 1.01 + 1e-18; }
  const Y = (v) => y + ph - ((v - lo) / (hi - lo)) * ph, step = w / cs.length, bw = Math.max(1.5, Math.min(12, step * 0.62));
  let out = '';
  for (let i = 0; i <= 3; i++) { const gy = y + (ph * i) / 3; out += `<rect x="${x}" y="${gy}" width="${w}" height="1" fill="${C.line}"/>`; }
  cs.forEach((c, i) => {
    const cx = x + step * i + step / 2, up = c.close >= c.open, col = up ? C.green : C.red;
    out += `<rect x="${cx - 0.75}" y="${Y(c.high)}" width="1.5" height="${Math.max(1, Y(c.low) - Y(c.high))}" fill="${col}"/>`;
    const top = Y(Math.max(c.open, c.close)), bot = Y(Math.min(c.open, c.close));
    out += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1.5, bot - top)}" rx="1" fill="${col}"/>`;
    if (vmax > 0 && c.volume) { const vh = (c.volume / vmax) * volH; out += `<rect x="${cx - bw / 2}" y="${y + h - vh}" width="${bw}" height="${vh}" fill="${col}" opacity="0.35"/>`; }
  });
  const last = cs[cs.length - 1].close, ly = Y(last);
  out += `<rect x="${x}" y="${ly}" width="${w}" height="1" fill="${lineCol}" opacity="0.6"/>`;
  return out;
}

function tokenTall(t, d, cs, tf, logo, st, addr, acc) {
  const W = 1200, H = 1500, P = 56, IW = W - 2 * P; let s = '', y;
  const day = d?.dayStats || null, sym = esc(t?.symbol || 'TOKEN');
  // ── header: kicker + stamp, logo, name, price
  s += T(P, 70, 'STATERA · ARC', 24, C.fire, 'letter-spacing="6"') + T(P + 290, 70, 'TOKEN SNAPSHOT', 18, C.gray, 'letter-spacing="3"');
  s += stampPill(W - P, 40, st, 'read directly from Arc mainnet');
  const ly = 140;
  if (logo) s += `<clipPath id="lg"><rect x="${P}" y="${ly}" width="104" height="104" rx="24"/></clipPath><rect x="${P}" y="${ly}" width="104" height="104" rx="24" fill="${C.tile}"/><image x="${P}" y="${ly}" width="104" height="104" href="${logo}" clip-path="url(#lg)" preserveAspectRatio="xMidYMid slice"/>`;
  else s += `<rect x="${P}" y="${ly}" width="104" height="104" rx="24" fill="#1f1611" stroke="#4a3020"/>` + T(P + 52, ly + 68, esc((t?.symbol || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?'), 44, C.fire, 'text-anchor="middle"');
  const nx = P + 128, name = esc((t?.name || 'Arc token').slice(0, 26));
  s += T(nx, ly + 50, name, 46) + T(nx, ly + 86, `$${sym}`, 22, C.gold);
  const tags = [t?.launchpad, t?.source === 'V4' ? 'Uniswap V4' : t?.source, t?.hooked ? 'Hooked pool' : null].filter(Boolean).slice(0, 3);
  let tx = nx; tags.forEach((g) => { const txt = esc(String(g)), tw = 18 + txt.length * 8.6; s += `<rect x="${tx}" y="${ly + 98}" width="${tw}" height="28" rx="8" fill="${C.tile}" stroke="${C.edge}"/>` + T(tx + 9, ly + 118, txt, 14, C.gray); tx += tw + 8; });
  s += T(W - P, ly + 62, priceInner(t?.price, 58), 58, C.white, 'text-anchor="end"');
  const chips = [['1H', day?.change1h ?? t?.change1h], ['6H', day?.change6h], ['24H', day?.change24h ?? t?.change24h]].filter(([, v]) => v != null);
  let cx = W - P; [...chips].reverse().forEach(([k, v]) => { const txt = `${k} ${chg(v)}`, tw = 22 + txt.length * 9.4; cx -= tw; s += `<rect x="${cx}" y="${ly + 84}" width="${tw}" height="32" rx="9" fill="${C.tile}" stroke="${chgCol(v)}" stroke-opacity="0.45"/>` + T(cx + tw / 2, ly + 106, esc(txt), 16, chgCol(v), 'text-anchor="middle"'); cx -= 8; });
  // ── stats row
  y = 284; const sw = (IW - 4 * 12) / 5;
  [['MARKET CAP', usd(t?.mcap)], ['LIQUIDITY', usd(t?.liq)], ['VOLUME 24H', usd(day?.volume24h ?? t?.volume24h)], (d?.holdersOver?.over > 0 ? ['HOLDERS $0.10+', `${num(d.holdersOver.over)}${d.holdersOver.capped ? '+' : ''}`] : ['HOLDERS', t?.holders != null ? num(t.holders) : '—']), ['TXNS 24H', day?.txns24 != null ? num(day.txns24) : '—']]
    .forEach(([k, v], i) => { const x = P + i * (sw + 12); s += panel(x, y, sw, 100) + T(x + 18, y + 38, k, 14, C.gold, 'letter-spacing="2"') + T(x + 18, y + 78, esc(v), 32); });
  // ── chart
  y = 400; const chH = 400; s += panel(P, y, IW, chH);
  s += T(P + 24, y + 42, `$${sym} / USDC`, 22) + T(P + 24 + 18 + (`$${t?.symbol || ''} / USDC`).length * 12, y + 42, esc(tf), 16, C.gray);
  if (cs && cs.length >= 2) { let hi = -Infinity, lo = Infinity; cs.forEach((c) => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
    s += T(W - P - 24, y + 42, `H ${priceInner(hi, 16)}   L ${priceInner(lo, 16)}`, 16, C.gray, 'text-anchor="end"'); }
  s += candleChart(P + 24, y + 64, IW - 48, chH - 88, cs, acc ? acc.line : C.fire);
  // ── activity + liquidity
  y = 816; const hw = (IW - 14) / 2, bh = 250;
  s += panel(P, y, hw, bh) + T(P + 22, y + 42, 'TRADE ACTIVITY · 24H', 20, C.white, 'letter-spacing="2"');
  if (day && (day.buys24 != null || day.sells24 != null)) {
    const b = day.buys24 || 0, se = day.sells24 || 0, tot = b + se || 1;
    s += T(P + 22, y + 92, num(b), 34, C.green) + T(P + 22, y + 114, 'buys', 15, C.gray) + T(P + hw - 22, y + 92, num(se), 34, C.red, 'text-anchor="end"') + T(P + hw - 22, y + 114, 'sells', 15, C.gray, 'text-anchor="end"');
    s += bar(P + 22, y + 128, hw - 44, 12, [[b / tot, C.green], [se / tot, C.red]]);
    const mk = day.makers24 != null ? `${num(day.makers24)}${day.makersIsFloor ? '+' : ''}` : '—';
    [['TXNS', num(day.txns24)], ['MAKERS', mk], ['BUY SHARE', `${Math.round((b / tot) * 100)}%`]].forEach(([k, v], i) => { const x = P + 22 + i * ((hw - 44) / 3);
      s += T(x, y + 184, k, 13, C.gold, 'letter-spacing="2"') + T(x, y + 218, esc(v), 26); });
  } else s += T(P + 22, y + 100, 'No trades in the last 24 hours', 18, C.dim);
  const rx0 = P + hw + 14; s += panel(rx0, y, hw, bh) + T(rx0 + 22, y + 42, 'LIQUIDITY &amp; POOLS', 20, C.white, 'letter-spacing="2"');
  const pools = (d?.ocPools || []).filter((q) => q && q.liquidityUsdc != null && isFinite(q.liquidityUsdc)).sort((a, b) => b.liquidityUsdc - a.liquidityUsdc);
  const totLiq = pools.length ? pools.reduce((a, q) => a + q.liquidityUsdc, 0) : t?.liq;
  s += T(rx0 + 22, y + 92, usd(totLiq), 34) + T(rx0 + hw - 22, y + 92, `${pools.length || '—'} pool${pools.length === 1 ? '' : 's'}`, 18, C.gray, 'text-anchor="end"');
  pools.slice(0, 3).forEach((q, i) => { const yy = y + 138 + i * 34, lab = `${q.version}${q.feeTier ? ` · ${q.feeTier / 10000}%` : ''} · USDC`;
    s += `<rect x="${rx0 + 22}" y="${yy - 20}" width="${hw - 44}" height="28" rx="8" fill="${C.tile}"/>` + T(rx0 + 34, yy - 1, esc(lab), 15, C.gray) + T(rx0 + hw - 34, yy - 1, usd(q.liquidityUsdc), 15, C.white, 'text-anchor="end"'); });
  const lk = (d?.locks || []).filter((l) => l.locked > 0)[0];
  const foot = [d?.burn?.pct != null && d.burn.pct >= 0.01 ? `${d.burn.pct.toFixed(2)}% burned` : null,
    lk ? `${lk.pct != null ? lk.pct.toFixed(2) + '%' : num(lk.locked)} locked (${lk.label})${lk.nextUnlock ? ` · next unlock ${new Date(lk.nextUnlock * 1000).toUTCString().slice(5, 16)}` : ''}` : null].filter(Boolean).join('  ·  ');
  if (foot) s += T(rx0 + 22, y + bh - 16, esc(foot), 14, lk ? C.green : C.dim);
  // ── holders + latest trades
  y = 1082; const hh = 290;
  s += panel(P, y, hw, hh) + T(P + 22, y + 42, 'TOP HOLDERS', 20, C.white, 'letter-spacing="2"');
  const poolSet = new Set(pools.map((q) => String(q.pool).toLowerCase()));
  (d?.holders || []).slice(0, 6).forEach((h, i) => { const yy = y + 80 + i * 34, a = String(h.address || '').toLowerCase();
    // server labels (holder-intel.ts): V4 pools / Liquidity pool / Burned / Argus locker; any other contract gets a CONTRACT tag
    const named = h.label || KNOWN_HOLDER[a] || (poolSet.has(a) ? 'Liquidity pool' : null), lab = named || short(a), p = h.percent != null ? Math.max(0, Math.min(100, h.percent)) : null;
    s += T(P + 22, yy, `${i + 1}`, 15, C.dim) + T(P + 48, yy, esc(lab), 16, named ? C.gold : C.white);
    const tag = h.kind === 'locker' ? ['LOCKED', C.green] : h.kind === 'contract' ? ['CONTRACT', '#b8a3ff'] : null;
    // room after the name/address (the tag touched '0x6763…6976')
    if (tag) { const tx0 = P + 60 + lab.length * 9.6; s += `<rect x="${tx0}" y="${yy - 15}" width="${tag[0].length * 8 + 12}" height="20" rx="5" fill="none" stroke="${tag[1]}" stroke-opacity="0.5"/>` + T(tx0 + 6, yy, tag[0], 11, tag[1], 'letter-spacing="1"'); }
    s += bar(P + 250, yy - 10, hw - 360, 8, [[(p || 0) / 100, C.fire]]) + T(P + hw - 22, yy, p == null ? '—' : p > 0 && p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`, 16, C.white, 'text-anchor="end"'); });
  if (!(d?.holders || []).length) s += T(P + 22, y + 90, 'Holder list not available', 16, C.dim);
  s += panel(rx0, y, hw, hh) + T(rx0 + 22, y + 42, 'LATEST TRADES', 20, C.white, 'letter-spacing="2"') + T(rx0 + hw - 22, y + 42, 'UTC', 14, C.dim, 'text-anchor="end"');
  const trades = (d?.swaps || []).filter((x) => x && isFinite(x.usd) && x.usd >= 0 && x.usd < 1e9).slice(0, 6);
  trades.forEach((x, i) => { const yy = y + 80 + i * 34, buy = x.side === 'buy';
    s += `<rect x="${rx0 + 22}" y="${yy - 19}" width="52" height="26" rx="7" fill="${buy ? '#10251a' : '#2a1210'}"/>` + T(rx0 + 48, yy - 1, buy ? 'BUY' : 'SELL', 13, buy ? C.green : C.red, 'text-anchor="middle"');
    s += T(rx0 + 88, yy, usd(x.usd), 17) + T(rx0 + 210, yy, esc(x.trader ? short(x.trader) : ''), 15, C.gray) + T(rx0 + hw - 22, yy, x.time ? hhmm(x.time) : '', 15, C.gray, 'text-anchor="end"'); });
  if (!trades.length) s += T(rx0 + 22, y + 90, 'No recent trades found', 16, C.dim);
  // ── footer
  s += `<rect x="0" y="${H - 130}" width="${W}" height="130" fill="url(#foot)"/>`;
  s += T(P, H - 56, `stateraarc.com/token/${addr.slice(0, 8)}…${addr.slice(-4)}`, 28, C.fire) + T(W - P, H - 56, 'Live on-chain data · not financial advice', 18, C.gray, 'text-anchor="end"');
  s += T(P, H - 26, 'Screener · Swap · Portfolio · Network', 16, C.dim) + T(W - P, H - 26, 'Arc mainnet · chain 5042', 16, C.dim, 'text-anchor="end"');
  return svg(W, H, s, 44, acc);
}

// ── accent colour ── (owner 09-29: no orange-red grading in the corner; each token card takes its LOGO's colour)
// The logo is drawn at 24×24 by resvg itself and read back as RGBA — no extra image library. Pixels that are see-through,
// near-grey, near-black or near-white are skipped; the rest vote by hue (weighted by saturation) and the winning hue's
// average colour is lifted to a readable brightness. No usable colour → the neutral default.
const toHsl = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l]; const sat = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; return [h, sat, l]; };
const hsl = (h, sat, l) => `hsl(${Math.round(h)}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`;
function logoAccent(dataUri) {
  if (!dataUri) return null;
  try {
    const px = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><image width="24" height="24" href="${dataUri}" preserveAspectRatio="xMidYMid slice"/></svg>`).render().pixels;
    const bins = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 160) continue;
      const [h, sat, l] = toHsl(px[i], px[i + 1], px[i + 2]);
      if (sat < 0.28 || l < 0.12 || l > 0.9) continue;
      const bin = bins[Math.floor(h / 30) % 12], w = sat * (1 - Math.abs(l - 0.5));
      bin.w += w; bin.h += h * w; bin.s += sat * w;
    }
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w < 8) return null; // too few coloured pixels (a black/white/grey logo)
    return { h: best.h / best.w, s: Math.min(0.9, Math.max(0.55, best.s / best.w)) };
  } catch { return null; }
}
// Accent set for the card: a strong colour for lines, a glow colour for the corner wash.
const accentOf = (a) => (a ? { line: hsl(a.h, a.s, 0.58), glow: hsl(a.h, a.s, 0.5) } : null);
const NETWORK_ACCENT = { line: '#4f8cff', glow: '#2f6bff' }; // the network card: a cool blue (not the old orange-red wash)

// Token logo for the snapshot: the VPS logo cache (192px PNG — resvg draws png/jpeg only).
async function tokenLogo(addr) {
  const UP = process.env.HOLDINGS_UPSTREAM, KEY = process.env.HOLDINGS_KEY;
  if (!UP || !KEY) return '';
  try {
    const r = await fetchUpstream(`${UP.replace(/\/+$/, '')}/holdings/logo/${addr}`, { headers: { 'x-relay-key': KEY } }, { timeoutMs: 2000, lastTimeoutMs: 2500 });
    if (!r.ok) return '';
    const ct = (r.headers.get('content-type') || '').toLowerCase(); if (!/png|jpe?g/.test(ct)) return '';
    const b = Buffer.from(await r.arrayBuffer()); return b.length > 64 ? `data:${ct.split(';')[0]};base64,${b.toString('base64')}` : '';
  } catch { return ''; }
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
const svg = (W, H, body, radius = 0, acc = null) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
  <defs>
    <radialGradient id="g1" cx="12%" cy="0%" r="75%"><stop offset="0%" stop-color="${acc ? acc.glow : '#000'}" stop-opacity="${acc ? 0.2 : 0}"/><stop offset="70%" stop-color="${acc ? acc.glow : '#000'}" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="100%" cy="100%" r="60%"><stop offset="0%" stop-color="${acc ? acc.glow : '#000'}" stop-opacity="${acc ? 0.07 : 0}"/><stop offset="70%" stop-color="${acc ? acc.glow : '#000'}" stop-opacity="0"/></radialGradient>
    <linearGradient id="foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#060607" stop-opacity="0"/><stop offset="1" stop-color="#0c0c10"/></linearGradient>
    <linearGradient id="hair" x1="0" x2="1"><stop offset="0" stop-color="${acc ? acc.line : '#ffa03c'}" stop-opacity="0"/><stop offset="0.5" stop-color="${acc ? acc.line : '#ffa03c'}" stop-opacity="0.7"/><stop offset="1" stop-color="${acc ? acc.line : '#ffa03c'}" stop-opacity="0"/></linearGradient>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
  <rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${acc ? acc.line : C.fire}"/>
  ${body}
  </g>
  ${radius ? `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${radius - 1}" fill="none" stroke="#2c2c33" stroke-width="2"/>` : ''}
</svg>`;

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const isWide = u.searchParams.get('wide') === '1', download = u.searchParams.get('download') === '1';
    const origin = `https://${req.headers.host || 'www.stateraarc.com'}`;
    const tokenAddr = (u.searchParams.get('token') || '').toLowerCase();
    if (tokenAddr) {
      if (!/^0x[0-9a-f]{40}$/.test(tokenAddr)) throw new Error('bad token address');
      const [row, d, c15, c5, logo] = await Promise.all([within(v2(`token/${tokenAddr}`), 5000), within(v2(`token/${tokenAddr}/detail`), 9000),
        within(v2(`token/${tokenAddr}/candles?sec=900&look=259200`), 6000), within(v2(`token/${tokenAddr}/candles?sec=300&look=86400`), 6000), within(tokenLogo(tokenAddr), 3000, ''), ensureWasm()]);
      const t = row?.token ? { ...row.token, name: noEmoji(row.token.name), symbol: noEmoji(row.token.symbol), launchpad: noEmoji(row.token.launchpad) || null } : null;
      if (!t) throw new Error('token not found');
      // 15-minute candles over 3 days; a token younger than ~6 h gets 5-minute candles over 24 h instead
      const long = c15?.candles || [], shortC = c5?.candles || [];
      const [cs, tf] = long.length >= 24 ? [long.slice(-160), '15m candles · last 3 days'] : [shortC.slice(-160), '5m candles · last 24 hours'];
      const now = new Date(), st = stampOf(now);
      // the card's colour comes from the token's logo; a grey/black/white or missing logo gets a quiet neutral
      const acc = accentOf(logoAccent(logo)) || { line: '#9aa3b2', glow: '#5b6475' };
      const png = new Resvg(tokenTall(t, d, cs, tf, logo, st, tokenAddr, acc), { font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false }, fitTo: { mode: 'width', value: 1200 } }).render().asPng();
      res.setHeader('content-type', 'image/png');
      const symSafe = String(t.symbol || 'token').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'token';
      if (download) { res.setHeader('content-disposition', `attachment; filename="statera-${symSafe}-snapshot-${st.file}-UTC.png"`); res.setHeader('cache-control', 'no-store'); }
      else res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).send(Buffer.from(png));
    }
    const [c, l, w, logos] = await Promise.all([within(v2('chain'), 4500), within(v2('lending'), 4500), within(v2('where'), 4500), isWide ? {} : within(validatorLogos(origin), 3000, {}), ensureWasm()]);
    if (!c) throw new Error('no chain data');
    const now = new Date(), when = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC', st = stampOf(now);
    const png = new Resvg(isWide ? wide(c, l, w, when) : tall(c, l, w, st, logos || {}), {
      font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    // Timestamped name: several downloads in a day were all 'arc-network-report-<date>.png' and the old one got opened.
    if (download) res.setHeader('content-disposition', `attachment; filename="arc-network-report-${st.file}-UTC.png"`);
    if (download) res.setHeader('cache-control', 'no-store');
    res.status(200).send(Buffer.from(png));
  } catch (e) {
    res.setHeader('x-report-error', String(e?.message || e).slice(0, 200));
    res.setHeader('cache-control', 'no-store');
    res.statusCode = 302; res.setHeader('location', '/og-card.jpg'); res.end();
  }
}
