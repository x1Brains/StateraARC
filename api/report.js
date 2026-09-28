import { Resvg, initWasm } from '@resvg/resvg-wasm';
import FONT_B64 from '../lib/ogfont.js';
import WASM_B64 from '../lib/ogwasm.js';

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
  const r = await fetch(`${UP.replace(/\/+$/, '')}/v2/${path}`, { headers: { 'x-relay-key': KEY }, signal: AbortSignal.timeout(4000) });
  return r.ok ? r.json() : null;
}
const T = (x, y, s, size, fill = C.white, extra = '') => `<text x="${x}" y="${y}" font-family="Open Sans" font-size="${size}" fill="${fill}" ${extra}>${s}</text>`;
const panel = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${C.panel}" stroke="${C.line}"/><rect x="${x + 24}" y="${y}" width="${w - 48}" height="2" fill="url(#hair)"/>`;

function tall(c, l, w, when) {
  const W = 1200, H = 1500, P = 56;
  let s = '', y = 0;
  // header
  s += T(P, 76, 'STATERA · ARC', 26, C.fire, 'letter-spacing="6"') + T(W - P, 76, esc(when), 22, C.gray, 'text-anchor="end"');
  s += T(P, 132, 'Arc Network Report', 52) + T(W - P, 132, c ? `block ${num(c.head)}` : '', 24, C.dim, 'text-anchor="end"');
  // pulse
  y = 166; const pw = (W - 2 * P - 3 * 16) / 4;
  const fee = c ? (21000 * c.baseFeeGwei * 1e9) / 1e18 : null;
  [[c?.h1 ? `${c.h1.blockTime.toFixed(2)}s` : '—', 'NEW BLOCK', 'final, no reorgs'], [c?.m5 ? num(c.m5.tps) : '—', 'TX / SECOND', c?.h1 ? `${num(c.h1.txs)} last hour` : ''],
   [fee != null ? (fee < 0.01 ? '$' + fee.toFixed(4) : usd(fee)) : '—', 'TO SEND MONEY', 'fees paid in USDC'], [c ? String(c.validatorCount) : '—', 'VALIDATORS', 'permissioned, rotating']]
    .forEach(([v, k, d], i) => { const x = P + i * (pw + 16); s += panel(x, y, pw, 132) + T(x + 22, y + 58, esc(v), 42) + T(x + 22, y + 90, k, 17, C.gold, 'letter-spacing="2"') + T(x + 22, y + 116, esc(d), 18, C.gray); });
  // money on arc + where it sits
  y = 322; const mh = 404; s += panel(P, y, W - 2 * P, mh);
  const tot = c?.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((a, k) => a + (c.supplyUsd[k] || 0), 0) : null;
  s += T(P + 26, y + 50, 'MONEY ON ARC', 24, C.white, 'letter-spacing="2"') + T(W - P - 26, y + 52, usd(tot), 40, C.fire, 'text-anchor="end"');
  s += T(P + 26, y + 82, 'Circle assets on Arc — full supply, read from each token contract. Bars = where it sits now.', 18, C.gray);
  const bw = W - 2 * P - 52;
  ['USDC', 'EURC', 'cirBTC'].forEach((k, i) => {
    const yy = y + 118 + i * 94, a = w?.assets?.find((x) => x.sym === k);
    s += T(P + 26, yy + 18, NAME[k], 22) + T(W - P - 26, yy + 18, usd(c?.supplyUsd?.[k]), 22, C.white, 'text-anchor="end"');
    s += `<rect x="${P + 26}" y="${yy + 32}" width="${bw}" height="14" rx="7" fill="#221e1b"/>`;
    if (a && a.supply > 0) {
      let x = P + 26; const legend = [];
      for (const [bk, label, col] of BUCKETS) { const p = pct(a.buckets[bk], a.supply); if (p < 0.3) continue; const ww = (bw * p) / 100; s += `<rect x="${x}" y="${yy + 32}" width="${ww}" height="14" fill="${col}"/>`; x += ww; if (p >= 1) legend.push([label, p, col]); }
      let lx = P + 26; for (const [label, p, col] of legend) { const t = `${label} ${p.toFixed(1)}%`; s += `<rect x="${lx}" y="${yy + 60}" width="12" height="12" rx="3" fill="${col}"/>` + T(lx + 18, yy + 71, esc(t), 17, C.gray); lx += 30 + t.length * 9.2; }
    }
  });
  // bridge + lending side by side
  y = 744; const hw = (W - 2 * P - 16) / 2, bh = 330; const f = c?.cctp?.h1;
  s += panel(P, y, hw, bh) + T(P + 24, y + 48, 'BRIDGED · LAST HOUR', 22, C.white, 'letter-spacing="2"') + T(P + 24, y + 76, "Circle's CCTP bridge, in and out of Arc", 17, C.gray);
  if (f) {
    const net = f.in.usd - f.out.usd;
    s += T(P + 24, y + 132, usd(f.in.usd), 38, C.green) + T(P + 24, y + 158, `came in · ${f.in.count} transfers`, 17, C.gray);
    s += T(P + 24 + hw / 2, y + 132, usd(f.out.usd), 38, C.red) + T(P + 24 + hw / 2, y + 158, `went out · ${f.out.count} transfers`, 17, C.gray);
    s += T(P + 24, y + 206, `Net ${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`, 24, net >= 0 ? C.green : C.red);
    const top = [...f.in.byChain.slice(0, 2).map((x) => `from ${x.chain} ${usd(x.usd)}`), ...f.out.byChain.slice(0, 2).map((x) => `to ${x.chain} ${usd(x.usd)}`)];
    top.forEach((t, i) => { s += T(P + 24, y + 244 + i * 22, esc(t), 17, C.gray); });
  }
  const lx0 = P + hw + 16; s += panel(lx0, y, hw, bh) + T(lx0 + 24, y + 48, 'LENDING', 22, C.white, 'letter-spacing="2"') + T(lx0 + 24, y + 76, 'Deposits earning interest, borrowed against collateral', 17, C.gray);
  if (l) {
    const mOk = !!l.morpho?.complete, lent = l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0), bor = l.aave.borrowUsd + (mOk ? l.morpho.borrowUsd : 0);
    s += T(lx0 + 24, y + 132, usd(lent), 38) + T(lx0 + 24, y + 158, 'lent', 17, C.gray);
    s += T(lx0 + 24 + hw / 2, y + 132, usd(bor), 38, C.gold) + T(lx0 + 24 + hw / 2, y + 158, `borrowed · ${lent > 0 ? Math.round((bor / lent) * 100) : 0}% used`, 17, C.gray);
    const rows = [['Aave', l.aave.supplyUsd, l.aave.borrowUsd], ...(mOk ? [['Morpho', l.morpho.supplyUsd, l.morpho.borrowUsd]] : [])];
    rows.forEach(([n, a, b], i) => { const yy = y + 214 + i * 42; s += T(lx0 + 24, yy, n, 22) + T(lx0 + hw - 24, yy, `${usd(a)} · ${a > 0 ? Math.round((b / a) * 100) : 0}% borrowed`, 20, C.gray, 'text-anchor="end"'); });
    if (!mOk) s += T(lx0 + 24, y + 300, 'Morpho: still counting its markets', 16, C.dim);
  }
  // validators
  y = 1092; s += panel(P, y, W - 2 * P, 172) + T(P + 26, y + 48, 'WHO RUNS THE CHAIN', 22, C.white, 'letter-spacing="2"');
  s += T(P + 26, y + 82, 'Founding validators named by Circle:', 18, C.gray) + T(P + 26, y + 112, esc(VALIDATORS[0]), 20, C.white) + T(P + 26, y + 140, esc(VALIDATORS[1]), 20, C.white);
  s += T(P + 26, y + 162, c ? `${c.validatorCount} block-producing addresses on chain, taking equal turns` : '', 16, C.dim);
  // key takeaways — computed live, one line each (the tweetable part)
  const take = [];
  const bt = w?.assets?.find((a) => a.sym === 'cirBTC'), us = w?.assets?.find((a) => a.sym === 'USDC');
  if (bt && bt.supply > 0) take.push(`${pct(bt.buckets.lending, bt.supply).toFixed(0)}% of the Bitcoin on Arc is posted as loan collateral — only ${pct(bt.buckets.dex, bt.supply).toFixed(1)}% sits in DEX pools`);
  if (l?.morpho?.complete && l.morpho.supplyUsd > 0) take.push(`Morpho is ${Math.round((l.morpho.borrowUsd / l.morpho.supplyUsd) * 100)}% borrowed (${usd(l.morpho.borrowUsd)} of ${usd(l.morpho.supplyUsd)})`);
  else if (us && us.supply > 0) take.push(`${pct(us.buckets.wallets, us.supply).toFixed(0)}% of USDC on Arc sits in wallets, ${pct(us.buckets.lending, us.supply).toFixed(0)}% in lending`);
  y = 1282; s += `<rect x="${P}" y="${y}" width="${W - 2 * P}" height="${34 + take.length * 34}" rx="14" fill="#1a1411" stroke="#3a2a1e"/>`;
  take.forEach((t, i) => { s += `<rect x="${P + 22}" y="${y + 24 + i * 34}" width="8" height="8" rx="2" fill="${C.fire}"/>` + T(P + 40, y + 33 + i * 34, esc(t), 20, C.white); });
  // footer
  s += `<rect x="0" y="${H - 96}" width="${W}" height="96" fill="#0d0a08"/>` + T(P, H - 42, 'stateraarc.com/network', 30, C.fire) + T(W - P, H - 42, 'Live · read from Arc mainnet (chain 5042)', 22, C.gray, 'text-anchor="end"');
  return svg(W, H, s);
}

function wide(c, l, w, when) {
  const W = 1200, H = 630, P = 56; let s = '';
  s += T(P, 74, 'STATERA · ARC', 26, C.fire, 'letter-spacing="6"') + T(W - P, 74, esc(when), 22, C.gray, 'text-anchor="end"');
  s += T(P, 142, 'Arc Network Report', 60);
  const tot = c?.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((a, k) => a + (c.supplyUsd[k] || 0), 0) : null;
  const mOk = !!l?.morpho?.complete, lent = l ? l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0) : null;
  const f = c?.cctp?.h1, net = f ? f.in.usd - f.out.usd : null;
  const cells = [[usd(tot), 'MONEY ON ARC'], [lent != null ? usd(lent) : '—', 'LENT'], [c?.m5 ? num(c.m5.tps) : '—', 'TX / SECOND'], [net == null ? '—' : `${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`, 'BRIDGED NET · 1H']];
  const cw = (W - 2 * P - 3 * 16) / 4;
  cells.forEach(([v, k], i) => { const x = P + i * (cw + 16); s += panel(x, 214, cw, 176) + T(x + 22, 294, esc(v), 44, i === 0 ? C.fire : C.white) + T(x + 22, 340, k, 18, C.gold, 'letter-spacing="2"'); });
  const b = w?.assets?.find((a) => a.sym === 'cirBTC');
  s += T(P, 452, b ? `Bitcoin on Arc: ${pct(b.buckets.lending, b.supply).toFixed(0)}% posted as lending collateral, ${pct(b.buckets.dex, b.supply).toFixed(1)}% in DEX pools` : '', 24, C.gray);
  s += T(P, 492, c ? `${c.validatorCount} validators · blocks every ${c.h1 ? c.h1.blockTime.toFixed(2) : '—'}s · final, no reorgs` : '', 24, C.gray);
  s += T(P, 590, 'stateraarc.com/network', 30, C.fire) + T(W - P, 590, 'Live from Arc mainnet', 22, C.gray, 'text-anchor="end"');
  return svg(W, H, s);
}
const svg = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="g1" cx="10%" cy="0%" r="70%"><stop offset="0%" stop-color="#ff7a1e" stop-opacity="0.20"/><stop offset="70%" stop-color="#ff7a1e" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="100%" cy="100%" r="60%"><stop offset="0%" stop-color="#ff2f14" stop-opacity="0.10"/><stop offset="70%" stop-color="#ff2f14" stop-opacity="0"/></radialGradient>
    <linearGradient id="hair" x1="0" x2="1"><stop offset="0" stop-color="#ffa03c" stop-opacity="0"/><stop offset="0.5" stop-color="#ffa03c" stop-opacity="0.7"/><stop offset="1" stop-color="#ffa03c" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${C.fire}"/>
  ${body}
</svg>`;

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const isWide = u.searchParams.get('wide') === '1', download = u.searchParams.get('download') === '1';
    const [c, l, w] = await Promise.all([within(v2('chain'), 4500), within(v2('lending'), 4500), within(v2('where'), 4500), ensureWasm()]);
    if (!c) throw new Error('no chain data');
    const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const png = new Resvg(isWide ? wide(c, l, w, when) : tall(c, l, w, when), {
      font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    if (download) res.setHeader('content-disposition', `attachment; filename="arc-network-report-${when.slice(0, 10)}.png"`);
    res.status(200).send(Buffer.from(png));
  } catch (e) {
    res.setHeader('x-report-error', String(e?.message || e).slice(0, 200));
    res.setHeader('cache-control', 'no-store');
    res.statusCode = 302; res.setHeader('location', '/og-card.jpg'); res.end();
  }
}
