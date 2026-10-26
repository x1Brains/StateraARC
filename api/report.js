import { Resvg, initWasm } from '@resvg/resvg-wasm';
import FONT_B64 from '../lib/ogfont.js';
import WASM_B64 from '../lib/ogwasm.js';
import { fetchUpstream } from '../lib/upstream.js';
import { isStateraImpersonator } from '../lib/fakes.js';

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

// mini bar chart (the Network page's sparkline bars): values → bars, max-scaled; buckets of `per` summed
const miniBars = (x, y, w, h, vals, col, per = 1) => {
  if (!vals || !vals.length) return '';
  const b = []; for (let i = 0; i < vals.length; i += per) b.push(vals.slice(i, i + per).reduce((a, v) => a + (Number(v) || 0), 0));
  const mx = Math.max(...b.map((v) => Math.abs(v))) || 1, bw = w / b.length; let o = '';
  b.forEach((v, i) => { const bh = Math.max(1, (Math.abs(v) / mx) * h); o += `<rect x="${(x + i * bw).toFixed(1)}" y="${(y + h - bh).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${v < 0 ? C.red : col}" opacity="0.85"/>`; });
  return o;
};

function tall(c, l, w, st, logos, act) {
  // 10-26 (owner: "the network snapshot is not showing all the information we're showing on the real website"): every
  // section of the Network page, in its order — pulse, live blocks, activity (with its bars), protocols, launchpads, money
  // on Arc, bridge (every chain), lending, validators. Height follows the content.
  const W = 1200, P = 56, IW = W - 2 * P, G = 16; let s = '', y;
  s += T(P, 70, 'STATERA · ARC', 24, C.fire, 'letter-spacing="6"');
  s += T(P, 128, 'Arc Network Report', 54) + stampPill(W - P, 40, st, c ? `at block ${num(c.head)}` : '');
  // ── headline takeaways (the hook)
  const tk = takeaways(c, l, w); y = 156;
  s += `<rect x="${P}" y="${y}" width="${IW}" height="${24 + tk.length * 38}" rx="16" fill="#110c09" stroke="#3a2516"/><rect x="${P}" y="${y + 14}" width="4" height="${tk.length * 38 - 4}" rx="2" fill="${C.fire}"/>`;
  tk.forEach((t, i) => { s += T(P + 26, y + 42 + i * 38, esc(t), 22, C.white); });
  // ── pulse
  y += 24 + tk.length * 38 + G; const pw = (IW - 3 * 14) / 4, fee = c ? (21000 * c.baseFeeGwei * 1e9) / 1e18 : null;
  const sm = (t) => `<tspan font-size="16" fill="${C.gray}">${t}</tspan>`;
  const txv = c?.m5 ? { raw: `${esc(num(c.m5.tps))}${sm('/sec')}${c.h1 ? `<tspan dx="12">${esc(num(c.h1.txs))}</tspan>${sm(c.coveredSeconds < 3500 ? ' so far' : '/hour')}` : ''}` } : '—';
  [[c?.h1 ? `${c.h1.blockTime.toFixed(2)}s` : '—', 'NEW BLOCK EVERY', 'payment final once in a block', C.white],
   [txv, 'TRANSACTIONS, LIVE', c?.m5?.fill != null && c.m5.fill > 0 ? `real use · blocks ${(c.m5.fill * 100).toFixed(1)}% full` : 'real use, last 5 min', C.white],
   [fee != null ? (fee < 0.01 ? '$' + fee.toFixed(4) : usd(fee)) : '—', 'COST TO SEND USDC', 'one transfer, paid in USDC', C.green],
   [c ? String(c.validatorCount) : '—', 'VALIDATORS', 'approved firms, equal turns', C.white]]
    .forEach(([v, k, d, col], i) => { const x = P + i * (pw + 14); s += panel(x, y, pw, 112) + T(x + 20, y + 50, typeof v === 'object' ? v.raw : esc(v), typeof v === 'object' ? 31 : 36, col) + T(x + 20, y + 78, k, 15, C.gold, 'letter-spacing="2"') + T(x + 20, y + 100, esc(d), 16, C.gray); });
  y += 112 + G;
  const pmeta = Object.fromEntries((act?.protocols || []).map((p) => [p.id, p]));
  // ── live blocks: one bar per block, height = transactions, coloured by what the block did (the page's block tape)
  const tape = (act?.tape || []).slice(-180);
  if (tape.length) {
    const bh = 250; s += panel(P, y, IW, bh) + T(P + 24, y + 42, 'LIVE BLOCKS', 20, C.white, 'letter-spacing="2"')
      + T(W - P - 24, y + 42, `blocks ${num(tape[0].n)} – ${num(tape[tape.length - 1].n)}`, 15, C.gray, 'text-anchor="end"');
    s += T(P + 24, y + 66, 'One bar per block, newest right · height = transactions · colour = what the block did', 14, C.dim);
    const gx = P + 24, gw = IW - 48, gy = y + 84, gh = 110, mx = Math.max(...tape.map((b) => b.txs || 0)) || 1, bw = gw / tape.length;
    tape.forEach((b, i) => { let top = gy + gh; const tot = b.txs || 0, known = Object.entries(b.p || {}).sort((a, z) => z[1] - a[1]);
      const unit = (gh / mx); let used = 0;
      known.forEach(([id, n]) => { const hh = n * unit; top -= hh; used += n; s += `<rect x="${(gx + i * bw).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${hh.toFixed(1)}" fill="${pmeta[id]?.color || C.fire}"/>`; });
      const rest = Math.max(0, tot - used); if (rest) { const hh = Math.max(1, rest * unit); top -= hh; s += `<rect x="${(gx + i * bw).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${hh.toFixed(1)}" fill="#3a3a44"/>`; } });
    const leg = [...new Set(tape.flatMap((b) => Object.keys(b.p || {})))].map((id) => pmeta[id]).filter(Boolean).slice(0, 9);
    let lx = P + 24; [...leg, { name: 'transfers & other', color: '#3a3a44' }].forEach((p) => { const t = esc(p.name); s += `<rect x="${lx}" y="${y + 214}" width="11" height="11" rx="3" fill="${p.color}"/>` + T(lx + 17, y + 224, t, 13, C.gray); lx += 30 + t.length * 6.6; });
    y += bh + G;
  }
  // ── activity 24h: the five counts, each with its last-3-hours bars
  if (act) {
    const x = act.h24 || act.h1, live = x.liveFrom && x.liveFrom > (act.now - 86400) + 120, ser = act.series || {}, ah = 250;
    s += panel(P, y, IW, ah) + T(P + 24, y + 42, 'ARC ACTIVITY · 24H', 20, C.white, 'letter-spacing="2"')
      + T(W - P - 24, y + 42, 'counted from every block · bars: last 3 hours', 15, C.gray, 'text-anchor="end"');
    const kw = (IW - 48 - 4 * 10) / 5, since = live ? `since ${new Date(x.liveFrom * 1000).toUTCString().slice(17, 22)} UTC` : 'last 24 hours';
    [[`${x.net >= 0 ? '+' : '−'}${usd(Math.abs(x.net))}`, 'USDC NET ISSUED', `${usd(x.minted)} minted`, x.net >= 0 ? C.green : C.red, ser.net],
     [usd(x.moved), 'USDC MOVED', 'all USDC transfers', C.white, ser.moved], [num(x.txs), 'TRANSACTIONS', since, C.white, ser.txs],
     [num(x.active), 'ACTIVE WALLETS', 'sent a transaction', C.white, ser.active], [num(x.newWallets), 'NEW WALLETS', 'first-ever transaction', C.white, ser.newWallets]]
      .forEach(([v, k, dsc, col, sv], i) => { const xx = P + 24 + i * (kw + 10);
        s += `<rect x="${xx}" y="${y + 60}" width="${kw}" height="172" rx="12" fill="${C.tile}" stroke="${C.line}"/>` + T(xx + 14, y + 98, esc(v), 24, col) + T(xx + 14, y + 122, k, 12, C.gold, 'letter-spacing="2"') + T(xx + 14, y + 141, esc(dsc), 12, C.dim)
          + miniBars(xx + 12, y + 160, kw - 24, 58, sv, '#6b6b78', 5); });
    y += ah + G;
    // ── protocols, live: every protocol with its 24h count and 3-hour bars
    const list = (act.protocols || []).map((p) => ({ ...p, n: x.protocols?.[p.id] ?? 0 })).sort((a, z) => z.n - a.n);
    const cols = 4, cw = (IW - 48 - (cols - 1) * 10) / cols, rows = Math.ceil(list.length / cols), ph = 74 + rows * 104;
    s += panel(P, y, IW, ph) + T(P + 24, y + 42, 'PROTOCOLS, LIVE', 20, C.white, 'letter-spacing="2"') + T(W - P - 24, y + 42, 'transactions, last 24 hours', 15, C.gray, 'text-anchor="end"');
    list.forEach((p, i) => { const xx = P + 24 + (i % cols) * (cw + 10), yy = y + 62 + Math.floor(i / cols) * 104;
      s += `<rect x="${xx}" y="${yy}" width="${cw}" height="94" rx="12" fill="${C.tile}" stroke="${C.line}"/><rect x="${xx + 12}" y="${yy + 14}" width="10" height="10" rx="3" fill="${p.color}"/>`
        + T(xx + 30, yy + 24, esc(p.name.length > 18 ? p.name.slice(0, 17) + '…' : p.name), 15) + T(xx + cw - 12, yy + 24, esc(String(p.cat || '').toUpperCase()), 11, C.dim, 'text-anchor="end" letter-spacing="1"')
        + T(xx + 12, yy + 52, `${num(p.n)}<tspan font-size="13" fill="${C.gray}"> tx</tspan>`, 22) + miniBars(xx + 12, yy + 62, cw - 24, 24, ser.protocols?.[p.id], p.color, 5); });
    y += ph + G;
    // ── launchpads 24h: totals, every pad, top tokens by market cap
    const lp = act.launchpads;
    if (lp && lp.trades > 0) {
      const pads = (lp.pads || []).filter((p) => p.trades > 0), top = (lp.top || []).slice(0, 6), pr = Math.ceil(pads.length / 2), lh = 150 + pr * 30 + (top.length ? 60 + Math.ceil(top.length / 2) * 30 : 0);
      s += panel(P, y, IW, lh) + T(P + 24, y + 42, 'LAUNCHPADS · 24H', 20, C.white, 'letter-spacing="2"') + T(W - P - 24, y + 42, 'tokens each launchpad created, counted from our own swap index', 14, C.gray, 'text-anchor="end"');
      s += T(P + 24, y + 94, `${num(lp.trades)}<tspan font-size="15" fill="${C.gray}"> trades</tspan><tspan dx="28">${esc(usd(lp.volume))}</tspan><tspan font-size="15" fill="${C.gray}"> volume</tspan><tspan dx="28">${num(lp.traded)}</tspan><tspan font-size="15" fill="${C.gray}"> tokens traded</tspan>`, 30);
      const c2 = (IW - 48 - 20) / 2;
      pads.forEach((p, i) => { const xx = P + 24 + (i % 2) * (c2 + 20), yy = y + 138 + Math.floor(i / 2) * 30;
        s += T(xx, yy, esc(p.pad === 'Argus pad' ? 'Argus' : p.pad), 16, C.gold) + T(xx + 130, yy, `${num(p.trades)} trades · ${usd(p.volume)} · ${num(p.traded)} token${p.traded === 1 ? '' : 's'} traded`, 15, C.gray); });
      if (top.length) { const ty = y + 138 + pr * 30 + 14; s += T(P + 24, ty, 'TOP BY MARKET CAP', 12, C.gold, 'letter-spacing="2"');
        top.forEach((t, i) => { const xx = P + 24 + (i % 2) * (c2 + 20), yy = ty + 32 + Math.floor(i / 2) * 30, ch = t.change24h;
          s += T(xx, yy, esc(`$${t.symbol}`), 16) + T(xx + 130, yy, `${usd(t.mcap)} mcap · ${usd(t.liq)} liq`, 15, C.gray) + (ch != null && isFinite(ch) ? T(xx + c2, yy, chg(ch), 15, chgCol(ch), 'text-anchor="end"') : ''); }); }
      y += lh + G;
    }
  }
  // ── money on Arc
  const mh = 372; s += panel(P, y, IW, mh);
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
  y += mh + G;
  // ── USDC bridged (every chain, both directions) | lending
  const hw = (IW - 14) / 2, f = c?.cctp?.h24 || c?.cctp?.h1, fPer = c?.cctp?.h24 ? 'LAST 24 HOURS' : 'LAST HOUR';
  const ins = f ? f.in.byChain.slice(0, 7) : [], outs = f ? f.out.byChain.slice(0, 7) : [], bh = 256 + Math.max(ins.length, outs.length, 3) * 22;
  s += panel(P, y, hw, bh) + T(P + 22, y + 44, `USDC BRIDGED · ${fPer}`, 20, C.white, 'letter-spacing="2"') + T(P + 22, y + 68, "Circle's official bridge (CCTP), into and out of Arc", 15, C.gray);
  if (f) {
    const net = f.in.usd - f.out.usd, sum = f.in.usd + f.out.usd || 1;
    s += T(P + 22, y + 118, usd(f.in.usd), 34, C.green) + T(P + 22, y + 140, `INTO Arc · ${f.in.count} transfers`, 15, C.gray);
    s += T(P + hw - 22, y + 118, usd(f.out.usd), 34, C.red, 'text-anchor="end"') + T(P + hw - 22, y + 140, `OUT of Arc · ${f.out.count} transfers`, 15, C.gray, 'text-anchor="end"');
    s += bar(P + 22, y + 154, hw - 44, 12, [[f.in.usd / sum, C.green], [f.out.usd / sum, C.red]]);
    s += T(P + 22, y + 196, `Net ${usd(Math.abs(net))} more bridged ${net >= 0 ? 'INTO' : 'OUT of'} Arc`, 20, net >= 0 ? C.green : C.red);
    s += T(P + 22, y + 226, 'FROM', 12, C.gold, 'letter-spacing="2"') + T(P + hw / 2 + 10, y + 226, 'TO', 12, C.gold, 'letter-spacing="2"');
    ins.forEach((x, i) => { const yy = y + 250 + i * 22; s += T(P + 22, yy, esc(x.chain), 15, C.white) + T(P + hw / 2 - 16, yy, usd(x.usd), 15, C.green, 'text-anchor="end"'); });
    outs.forEach((x, i) => { const yy = y + 250 + i * 22; s += T(P + hw / 2 + 10, yy, esc(x.chain), 15, C.white) + T(P + hw - 22, yy, usd(x.usd), 15, C.red, 'text-anchor="end"'); });
  }
  const lx0 = P + hw + 14; s += panel(lx0, y, hw, bh) + T(lx0 + 22, y + 44, 'LENDING', 20, C.white, 'letter-spacing="2"') + T(lx0 + 22, y + 68, 'Deposits earn interest; borrowers post collateral', 15, C.gray);
  if (l) {
    const mOk = !!l.morpho?.complete, lent = l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0), bor = l.aave.borrowUsd + (mOk ? l.morpho.borrowUsd : 0);
    s += T(lx0 + 22, y + 118, usd(lent), 34) + T(lx0 + 22, y + 140, 'deposited (Aave + Morpho)', 15, C.gray);
    s += T(lx0 + hw - 22, y + 118, usd(bor), 34, C.gold, 'text-anchor="end"') + T(lx0 + hw - 22, y + 140, `borrowed out · ${lent > 0 ? Math.round((bor / lent) * 100) : 0}% of deposits`, 15, C.gray, 'text-anchor="end"');
    const rows = [['Aave V4', l.aave.supplyUsd, l.aave.borrowUsd], ...(mOk ? [['Morpho', l.morpho.supplyUsd, l.morpho.borrowUsd]] : [])];
    rows.forEach(([n, a, b], i) => { const yy = y + 190 + i * 76, u = a > 0 ? b / a : 0;
      s += T(lx0 + 22, yy, n, 19) + T(lx0 + hw - 22, yy, `${usd(a)} deposited`, 16, C.white, 'text-anchor="end"');
      s += bar(lx0 + 22, yy + 12, hw - 44, 10, [[u, u >= 0.9 ? C.red : C.gold]]) + T(lx0 + hw - 22, yy + 42, `${usd(b)} borrowed out (${Math.round(u * 100)}%)`, 14, C.gray, 'text-anchor="end"'); });
    if (!mOk) s += T(lx0 + 22, y + bh - 20, 'Morpho: still counting its markets', 14, C.dim);
    const bt = w?.assets?.find((a) => a.sym === 'cirBTC');
    if (bt && bt.supply > 0) s += T(lx0 + 22, y + bh - 20, `${pct(bt.buckets.lending, bt.supply).toFixed(0)}% of the Bitcoin on Arc sits in the lending apps — collateral`, 14, C.dim);
  }
  y += bh + G;
  // ── validators (logo grid)
  s += panel(P, y, IW, 214) + T(P + 24, y + 42, 'WHO RUNS THE CHAIN', 20, C.white, 'letter-spacing="2"');
  s += T(W - P - 24, y + 42, c ? `${c.validatorCount} block producers on chain · equal turns` : '', 15, C.gray, 'text-anchor="end"');
  const vw = (IW - 48 - 5 * 10) / 6;
  VAL_LIST.forEach((v, i) => { const x = P + 24 + (i % 6) * (vw + 10), yy = y + 64 + Math.floor(i / 6) * 66;
    s += `<rect x="${x}" y="${yy}" width="${vw}" height="54" rx="10" fill="${C.tile}" stroke="${C.line}"/>`;
    const img = v.logo && logos[v.logo];
    s += img ? `<rect x="${x + 10}" y="${yy + 11}" width="32" height="32" rx="7" fill="#ffffff"/><image x="${x + 13}" y="${yy + 14}" width="26" height="26" href="${img}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${x + 10}" y="${yy + 11}" width="32" height="32" rx="7" fill="#1f1611" stroke="#4a3020"/>` + T(x + 26, yy + 33, v.name.split(' ').map((q) => q[0]).join('').slice(0, 2), 13, C.gold, 'text-anchor="middle"');
    s += T(x + 50, yy + 33, esc(v.short || v.name), 15, C.white); });
  s += T(P + 24, y + 200, 'Founding validators named by Circle. The chain records addresses only; which institution runs which is not published.', 13, C.dim);
  // ── footer
  y += 214 + G; const H = y + 134;
  s += `<rect x="0" y="${H - 150}" width="${W}" height="150" fill="url(#foot)"/>`;
  s += T(P, H - 70, 'stateraarc.com/network', 30, C.fire) + T(W - P, H - 70, 'Live · read directly from Arc mainnet', 20, C.gray, 'text-anchor="end"');
  s += T(P, H - 38, 'Screener · Swap · Portfolio · Network', 18, C.dim) + T(W - P, H - 38, 'chain 5042', 18, C.dim, 'text-anchor="end"');
  return svg(W, H, s, 44, NETWORK_ACCENT);
}

// X link card (1200×630). ⛔ X lays its own title label over the BOTTOM-LEFT (~0–600 × 560–630): nothing important goes there.
function wide(c, l, w, when) {
  const W = 1200, H = 630, P = 48; let s = '';
  s += T(P, 62, 'STATERA · ARC', 22, C.fire, 'letter-spacing="6"') + T(W - P, 62, 'stateraarc.com/network', 22, C.fire, 'text-anchor="end"');
  s += T(P, 118, 'Arc Network Report', 48) + T(W - P, 116, esc(when), 20, C.gray, 'text-anchor="end"');
  const tot = c?.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((a, k) => a + (c.supplyUsd[k] || 0), 0) : null;
  const stable = c?.supplyUsd ? (c.supplyUsd.USDC || 0) + (c.supplyUsd.EURC || 0) : null, btc = c?.supplyUsd?.cirBTC ?? null;
  const mOk = !!l?.morpho?.complete, lent = l ? l.aave.supplyUsd + (mOk ? l.morpho.supplyUsd : 0) : null, bor = l ? l.aave.borrowUsd + (mOk ? l.morpho.borrowUsd : 0) : null;
  const f = c?.cctp?.h24 || c?.cctp?.h1, net = f ? f.in.usd - f.out.usd : null; // 24h once covered (label follows)
  const cells = [
    [usd(tot), 'MONEY ON ARC', `${usd(stable)} stables · ${usd(btc)} BTC`, C.fire],
    [usd(lent), 'LENT', bor != null ? `${usd(bor)} borrowed · ${lent ? Math.round((bor / lent) * 100) : 0}%` : '', C.white],
    [c?.m5 ? `${num(c.m5.tps)} tx/s` : '—', 'LIVE TRAFFIC', c?.h1 ? `${num(c.h1.txs)} tx/hr${c.m5?.fill ? ` · blocks ${(c.m5.fill * 100).toFixed(1)}% full` : ''}` : '', C.white],
    [net == null ? '—' : `${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`, `NET BRIDGED ${net != null && net < 0 ? 'OUT' : 'IN'} · ${c?.cctp?.h24 ? '24H' : '1H'}`, f ? `${usd(f.in.usd)} into Arc · ${usd(f.out.usd)} out` : '', net != null && net >= 0 ? C.green : C.red],
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

function candleChart(x, y, w, h, cs, lineCol = C.fire, log = false) {
  if (!cs || cs.length < 2) return T(x + w / 2, y + h / 2, 'Not enough trades yet for a chart', 18, C.dim, 'text-anchor="middle"');
  const volH = Math.round(h * 0.16), ph = h - volH - 10;
  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const c of cs) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); vmax = Math.max(vmax, c.volume || 0); }
  if (!(hi > lo)) { hi = lo * 1.01 + 1e-18; }
  // log scale (the since-launch chart): a token that went 1000x is still readable; needs positive prices
  const useLog = log && lo > 0, f = (v) => (useLog ? Math.log(v) : v), fl = f(lo), fh = f(hi);
  const Y = (v) => y + ph - ((f(Math.max(v, lo)) - fl) / (fh - fl || 1)) * ph, step = w / cs.length, bw = Math.max(1.5, Math.min(12, step * 0.62));
  let out = '';
  for (let i = 0; i <= 3; i++) { const gy = y + (ph * i) / 3; out += `<rect x="${x}" y="${gy}" width="${w}" height="1" fill="${C.line}"/>`; }
  cs.forEach((c, i) => {
    const cx = x + step * i + step / 2, up = c.close >= c.open, col = up ? C.green : C.red;
    out += `<rect x="${cx - 0.75}" y="${Y(c.high)}" width="1.5" height="${Math.max(1, Y(c.low) - Y(c.high))}" fill="${col}"/>`;
    const top = Y(Math.max(c.open, c.close)), bot = Y(Math.min(c.open, c.close));
    out += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1.5, bot - top)}" rx="1" fill="${col}"/>`;
    if (vmax > 0 && c.volume) { const vh = Math.max(1, (c.volume / vmax) * volH); out += `<rect x="${cx - bw / 2}" y="${y + h - vh}" width="${bw}" height="${vh}" fill="${col}" opacity="0.5"/>`; }
  });
  const last = cs[cs.length - 1].close, ly = Y(last);
  out += `<rect x="${x}" y="${ly}" width="${w}" height="1" fill="${lineCol}" opacity="0.6"/>`;
  return out;
}

// Pool health — the SAME 0–100 score as the token page (src/components/PremainDetail.tsx "Pool health"): liquidity depth
// 35 · holder distribution 20 · trading quality 20 · pool age 15 · stability 10, each from on-chain numbers. Not a safety rating.
function poolHealth(t, d, tvl) {
  const day = d?.dayStats || null, burn = d?.burn || null;
  const minted = burn?.supply ?? (t?.totalSupply != null ? Number(t.totalSupply) : null);
  const fdv = t?.fdv ?? (t?.price != null && minted ? t.price * minted : null), valuation = t?.mcap ?? fdv ?? null;
  const dRaw = tvl != null && valuation ? (tvl / valuation) * 100 : null, depthPct = dRaw != null && isFinite(dRaw) && dRaw <= 1000 ? dRaw : null;
  const hs = d?.holders || []; let top10 = null;
  if (hs.length) { const top = hs.slice(0, 10).map((h) => (burn?.supply > 0 && h.amount != null && isFinite(h.amount) ? (h.amount / burn.supply) * 100 : h.percent));
    if (!top.some((p) => p == null || !isFinite(p) || p < 0 || p > 100.5)) { const sum = top.reduce((a, p) => a + p, 0); top10 = sum <= 100.5 ? Math.min(100, sum) : null; } }
  const ageSecs = t?.createdAt ? Math.max(0, (Date.now() - t.createdAt) / 1000) : null, ch = day?.change24h ?? t?.change24h ?? null;
  const sig = {
    depth: depthPct == null ? null : Math.max(0, Math.min(100, Math.round((Math.min(depthPct, 10) / 10) * 100))),
    dist: top10 == null ? null : Math.max(0, Math.min(100, Math.round(100 - Math.max(0, top10 - 20) * (100 / 60)))),
    quality: day?.makers24 != null && day.makersSample ? Math.round(Math.min(100, (day.makers24 / day.makersSample) * 100))
      : day?.makers24 != null && day?.txns24 ? Math.round(Math.min(100, (day.makers24 / day.txns24) * 100)) : null,
    age: ageSecs == null ? null : Math.round(Math.min(100, (ageSecs / (30 * 86400)) * 100)),
    vol: ch == null ? null : Math.round(Math.max(0, 100 - Math.min(100, Math.abs(ch)))),
  };
  const HW = { depth: 35, dist: 20, quality: 20, age: 15, vol: 10 }, LBL = { depth: 'Liquidity depth', dist: 'Holder distribution', quality: 'Trading quality', age: 'Pool age', vol: 'Stability' };
  const parts = Object.keys(HW).map((k) => ({ k, label: LBL[k], v: sig[k], w: HW[k] })).filter((p) => p.v != null);
  const score = parts.length ? Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / parts.reduce((a, p) => a + p.w, 0)) : null;
  return { score, label: score == null ? '' : score >= 70 ? 'Healthy' : score >= 40 ? 'Caution' : 'High risk', parts, depthPct, top10, ageSecs, fdv, minted };
}
const ageTxt = (s) => (s == null ? '—' : s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 60)}m`);
const cmp = (v) => (v == null || !isFinite(v) ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v >= 1 ? v.toFixed(0) : v.toPrecision(3));
const dmy = (sec) => new Date(sec * 1000).toUTCString().slice(5, 16);
// a row of small labelled cells (label on top in gold, value under it) — the page's ta-grid
const cells = (x, y, w, items, vs = 24) => { const cw = w / items.length; let o = '';
  items.forEach(([k, v, col], i) => { o += T(x + i * cw, y, k, 12, C.gold, 'letter-spacing="2"') + T(x + i * cw, y + 32, typeof v === 'object' && v ? v.raw : esc(v), vs, col || C.white); }); return o; };

function tokenTall(t, d, cs, tf, logo, st, addr, acc, ex = {}) {
  // 10-26 (owner: "money flow, profitability, multiple liquidities, full charts, holders, pool health … the snapshot should
  // include all of that"): every panel of the token page, in its order. Drawn 1376 wide, scaled to 1200 on render.
  const W = 1376, P = 56, IW = W - 2 * P, hw = (IW - 14) / 2, rx0 = P + hw + 14, G = 16; let s = '', y;
  const day = d?.dayStats || null, sym = esc(t?.symbol || 'TOKEN');
  const pools = (d?.ocPools || []).filter((q) => q && q.liquidityUsdc != null && isFinite(q.liquidityUsdc) && q.liquidityUsdc >= 1).sort((a, b) => b.liquidityUsdc - a.liquidityUsdc);
  // same liquidity as the stats row / screener when the server measured the row's real reserves (liqUsdc)
  const totLiq = t?.liqUsdc != null && t?.liq > 0 ? t.liq : pools.length ? pools.reduce((a, q) => a + q.liquidityUsdc, 0) : t?.liq;
  const ph = poolHealth(t, d, totLiq);
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
  const chips = [['5M', day?.change5m], ['1H', day?.change1h ?? t?.change1h], ['6H', day?.change6h], ['24H', day?.change24h ?? t?.change24h]].filter(([, v]) => v != null);
  let cx = W - P; [...chips].reverse().forEach(([k, v]) => { const txt = `${k} ${chg(v)}`, tw = 22 + txt.length * 9.4; cx -= tw; s += `<rect x="${cx}" y="${ly + 84}" width="${tw}" height="32" rx="9" fill="${C.tile}" stroke="${chgCol(v)}" stroke-opacity="0.45"/>` + T(cx + tw / 2, ly + 106, esc(txt), 16, chgCol(v), 'text-anchor="middle"'); cx -= 8; });
  if (isStateraImpersonator(addr, t?.name, t?.symbol)) s += `<rect x="${P}" y="12" width="${IW}" height="30" rx="8" fill="#d63a3a"/>` + T(W / 2, 33, 'FAKE — NOT ASSOCIATED WITH STATERA', 18, '#ffffff', 'text-anchor="middle" letter-spacing="2"');
  // ── stats row (the page's stat bar + FDV)
  y = 284; const sw = (IW - 5 * 12) / 6;
  [['MARKET CAP', usd(t?.mcap)], ['FDV', usd(ph.fdv)], ['LIQUIDITY', usd(totLiq), t?.liqUsdc != null ? `${usd(t.liqUsdc)} USDC` : ''],
   ['VOLUME 24H', usd(t?.liqUsdc != null ? t?.volume24h : (day?.volume24h ?? t?.volume24h))],
   d?.holdersOver?.over > 0 ? ['HOLDERS $0.10+', `${num(d.holdersOver.over)}${d.holdersOver.capped ? '+' : ''}`, d.holdersOver.total ? `of ${num(d.holdersOver.total)} wallets` : ''] : ['HOLDERS', t?.holders != null ? num(t.holders) : '—'],
   ['TXNS 24H', day?.txns24 != null ? num(day.txns24) : '—']]
    .forEach(([k, v, sub], i) => { const x = P + i * (sw + 12); s += panel(x, y, sw, 112) + T(x + 16, y + 36, k, 13, C.gold, 'letter-spacing="2"') + T(x + 16, y + 74, esc(v), 28) + (sub ? T(x + 16, y + 98, esc(sub), 13, C.dim) : ''); });
  // ── chart: recent (15m · 3 days, or 5m · 24 h for a young token)
  y += 112 + G; const chH = 400; s += panel(P, y, IW, chH);
  s += T(P + 24, y + 42, `$${sym} / USDC`, 22) + T(P + 24 + 18 + (`$${t?.symbol || ''} / USDC`).length * 12, y + 42, esc(tf), 16, C.gray);
  if (cs && cs.length >= 2) { let hi = -Infinity, lo = Infinity; cs.forEach((c) => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
    s += T(W - P - 24, y + 42, `H ${priceInner(hi, 16)}   L ${priceInner(lo, 16)}`, 16, C.gray, 'text-anchor="end"'); }
  s += candleChart(P + 24, y + 64, IW - 48, chH - 88, cs, acc ? acc.line : C.fire);
  // ── chart: the whole history (daily candles from the swap store, log scale)
  const ds = (ex.daily?.candles || []).filter((k) => k && k.close > 0 && k.low > 0);
  y += chH + G; const lh = 330; s += panel(P, y, IW, lh) + T(P + 24, y + 42, 'PRICE SINCE LAUNCH', 20, C.white, 'letter-spacing="2"');
  if (ds.length >= 2) {
    const f0 = ds[0].open || ds[0].close, fl = ds[ds.length - 1].close, chL = ((fl - f0) / f0) * 100, ath = ds.reduce((a, k) => (k.high > a.high ? k : a)), lowK = ds.reduce((a, k) => (k.low < a.low ? k : a));
    s += T(P + 24 + 290, y + 42, `daily candles · ${ds.length} days · log scale`, 16, C.gray);
    const mult = fl / f0, chTxt = mult >= 10 ? `${num(mult, mult >= 100 ? 0 : 1)}x` : `${chL >= 0 ? '+' : '−'}${Math.abs(chL).toFixed(Math.abs(chL) >= 100 ? 0 : 1)}%`;
    s += T(W - P - 24, y + 42, `${chTxt} since ${dmy(ds[0].time)}  ·  ATH ${priceInner(ath.high, 16)} (${dmy(ath.time)})  ·  low ${priceInner(lowK.low, 16)}`, 16, C.gray, 'text-anchor="end"');
    s += candleChart(P + 24, y + 62, IW - 48, lh - 84, ds.slice(-200), acc ? acc.line : C.fire, true);
  } else s += T(P + 24, y + 110, 'Not enough history yet', 18, C.dim);
  // ── trade activity | pool health
  y += lh + G; const r1 = 300;
  s += panel(P, y, hw, r1) + T(P + 22, y + 42, 'TRADE ACTIVITY · 24H', 20, C.white, 'letter-spacing="2"');
  if (day && (day.buys24 != null || day.sells24 != null)) {
    const b = day.buys24 || 0, se = day.sells24 || 0, tot = b + se || 1;
    s += T(P + 22, y + 94, num(b), 34, C.green) + T(P + 22, y + 116, 'buys', 15, C.gray) + T(P + hw - 22, y + 94, num(se), 34, C.red, 'text-anchor="end"') + T(P + hw - 22, y + 116, 'sells', 15, C.gray, 'text-anchor="end"');
    s += bar(P + 22, y + 130, hw - 44, 12, [[b / tot, C.green], [se / tot, C.red]]);
    const mk = day.makers24 != null ? `${num(day.makers24)}${day.makersIsFloor ? '+' : ''}` : '—';
    s += cells(P + 22, y + 192, hw - 44, [['TXNS', num(day.txns24)], ['MAKERS', mk], ['BUY SHARE', `${Math.round((b / tot) * 100)}%`]]);
    s += cells(P + 22, y + 254, hw - 44, [['BURNED', d?.burn?.pct != null ? `${d.burn.pct.toFixed(1)}%` : '—'], ['TOP 10 HOLD', ph.top10 != null ? `${ph.top10.toFixed(1)}%` : '—'], ['POOL AGE', ageTxt(ph.ageSecs)]]);
  } else s += T(P + 22, y + 100, 'No trades in the last 24 hours', 18, C.dim);
  s += panel(rx0, y, hw, r1) + T(rx0 + 22, y + 42, 'POOL HEALTH', 20, C.white, 'letter-spacing="2"');
  if (ph.score != null) {
    const col = ph.score >= 70 ? C.green : ph.score >= 40 ? C.gold : C.red;
    s += T(rx0 + hw - 22, y + 44, `<tspan font-size="30">${ph.score}</tspan><tspan font-size="16" fill="${C.gray}">/100 · </tspan>${esc(ph.label)}`, 20, col, 'text-anchor="end"');
    ph.parts.forEach((p, i) => { const yy = y + 86 + i * 38;
      s += T(rx0 + 22, yy, esc(p.label), 16) + T(rx0 + hw - 22, yy, String(p.v), 16, C.white, 'text-anchor="end"');
      s += bar(rx0 + 22, yy + 9, hw - 44, 7, [[p.v / 100, p.v >= 70 ? C.green : p.v >= 40 ? C.gold : C.red]]); });
    s += T(rx0 + 22, y + r1 - 14, 'Weighted signal from live on-chain data — not a legitimacy or safety certificate', 13, C.dim);
  } else s += T(rx0 + 22, y + 100, 'Not enough data for a score yet', 18, C.dim);
  // ── liquidity & pools | supply + locked
  y += r1 + G; const shown = pools.slice(0, 6), r2 = Math.max(380, 236 + shown.length * 36 + 18);
  s += panel(P, y, hw, r2) + T(P + 22, y + 42, 'LIQUIDITY &amp; POOLS', 20, C.white, 'letter-spacing="2"');
  s += T(P + 22, y + 92, usd(totLiq), 34) + T(P + hw - 22, y + 92, `${pools.length || '—'} pool${pools.length === 1 ? '' : 's'}`, 18, C.gray, 'text-anchor="end"');
  s += cells(P + 22, y + 132, hw - 44, [['DEPTH / VAL', ph.depthPct != null ? `${ph.depthPct.toFixed(1)}%` : '—'], ['USDC IN POOLS', t?.liqUsdc != null ? usd(t.liqUsdc) : '—'], ['POOL AGE', ageTxt(ph.ageSecs)]], 20);
  s += T(P + 22, y + 204, 'PAIR', 12, C.dim, 'letter-spacing="2"') + T(P + hw - 190, y + 204, 'PRICE', 12, C.dim, 'letter-spacing="2" text-anchor="end"') + T(P + hw - 22, y + 204, 'LIQUIDITY', 12, C.dim, 'letter-spacing="2" text-anchor="end"');
  shown.forEach((q, i) => { const yy = y + 236 + i * 36, lab = `${q.version || 'Pool'}${q.feeTier ? ` · ${q.feeTier / 10000}%` : ''} · ${q.quote || 'USDC'}`;
    s += `<rect x="${P + 22}" y="${yy - 22}" width="${hw - 44}" height="30" rx="8" fill="${C.tile}"/>` + T(P + 34, yy - 2, esc(lab), 15, C.gray)
      + T(P + hw - 190, yy - 2, q.price != null ? priceInner(q.price, 15) : '—', 15, C.green, 'text-anchor="end"') + T(P + hw - 34, yy - 2, usd(q.liquidityUsdc), 15, C.white, 'text-anchor="end"'); });
  if (pools.length > shown.length) s += T(P + 22, y + r2 - 14, `+${pools.length - shown.length} smaller pools`, 13, C.dim);
  if (!shown.length) s += T(P + 22, y + 240, 'No pools found', 16, C.dim);
  // supply (top of the right column)
  const burn = d?.burn || null, minted = ph.minted, burnt = burn?.burnt > 0 ? burn.burnt : null, circ = minted != null ? Math.max(0, minted - (burnt || 0)) : null;
  const sh = 150; s += panel(rx0, y, hw, sh) + T(rx0 + 22, y + 42, 'SUPPLY', 20, C.white, 'letter-spacing="2"');
  s += cells(rx0 + 22, y + 84, hw - 44, [['MINTED', cmp(minted)], [burnt ? `BURNED ${burn.pct.toFixed(1)}%` : 'BURNED', burnt ? cmp(burnt) : '0'], ['CIRCULATING', cmp(circ)], ['FDV', usd(ph.fdv)]], 22);
  // locked (under supply): total, locker, the next unlocks
  const lkY = y + sh + 14, lkH = r2 - sh - 14, locks = (d?.locks || []).filter((l) => l.locked > 0);
  s += panel(rx0, lkY, hw, lkH) + T(rx0 + 22, lkY + 42, 'LOCKED', 20, C.white, 'letter-spacing="2"');
  if (locks.length) {
    const lk = locks[0], parts = (lk.parts || []).filter((p) => p.amount > 0 && p.unlock * 1000 > Date.now()).sort((a, b) => a.unlock - b.unlock), nowS = Date.now() / 1000;
    s += T(rx0 + 22, lkY + 84, `${cmp(lk.locked)} ${sym}`, 26) + T(rx0 + hw - 22, lkY + 84, lk.pct != null ? `${lk.pct < 0.01 ? '&lt;0.01' : lk.pct.toFixed(2)}% of supply` : '', 16, C.green, 'text-anchor="end"');
    s += T(rx0 + 22, lkY + 108, esc(`in the ${lk.label || 'locker'}${locks.length > 1 ? ` (+${locks.length - 1} more locker${locks.length > 2 ? 's' : ''})` : ''}`), 14, C.gray);
    const rows = Math.max(0, Math.floor((lkH - 150) / 28));
    parts.slice(0, rows).forEach((p, i) => { const yy = lkY + 142 + i * 28;
      s += T(rx0 + 22, yy, esc(cmp(p.amount)), 15) + T(rx0 + 170, yy, `unlocks ${dmy(p.unlock)}`, 15, C.gray) + T(rx0 + hw - 22, yy, `${Math.max(0, Math.ceil((p.unlock - nowS) / 86400))}d`, 15, C.green, 'text-anchor="end"'); });
    if (parts.length > rows) s += T(rx0 + 22, lkY + lkH - 14, `+${parts.length - rows} more parts · last unlocks ${lk.lastUnlock ? dmy(lk.lastUnlock) : '—'}`, 13, C.dim);
  } else s += T(rx0 + 22, lkY + 92, 'No tokens in a known locker', 16, C.dim);
  // ── money flow | holder profitability
  y += r2 + G; const r3 = 420, fw = (ex.flow?.windows || []).find((q) => q.window === '24h');
  s += panel(P, y, hw, r3) + T(P + 22, y + 42, 'MONEY FLOW · 24H', 20, C.white, 'letter-spacing="2"');
  if (fw && (fw.buys || fw.sells)) {
    const tot = fw.buyUsd + fw.sellUsd || 1, up = fw.net >= 0;
    s += T(P + 22, y + 96, `${up ? '+' : '−'}${usd(Math.abs(fw.net))}`, 36, up ? C.green : C.red) + T(P + 22, y + 120, `net ${up ? 'inflow' : 'outflow'}`, 15, C.gray);
    s += bar(P + 22, y + 138, hw - 44, 12, [[fw.buyUsd / tot, C.green], [fw.sellUsd / tot, C.red]]);
    s += T(P + 22, y + 174, `Bought ${usd(fw.buyUsd)}`, 16, C.green) + T(P + hw - 22, y + 174, `Sold ${usd(fw.sellUsd)}`, 16, C.red, 'text-anchor="end"');
    s += cells(P + 22, y + 216, hw - 44, [['BUYS', num(fw.buys)], ['SELLS', num(fw.sells)], ['BUYERS', fw.makersKnown ? num(fw.buyers) : '—'], ['SELLERS', fw.makersKnown ? num(fw.sellers) : '—']], 22);
    s += cells(P + 22, y + 284, hw - 44, [['BIGGEST BUY', usd(fw.biggestBuy)], ['BIGGEST SELL', usd(fw.biggestSell)]], 22);
    [['TOP BUYER', fw.topBuyer], ['TOP SELLER', fw.topSeller]].forEach(([k, w], i) => { if (!w?.wallet) return; const yy = y + 362 + i * 30, upW = w.net >= 0;
      s += T(P + 22, yy, k, 12, C.gold, 'letter-spacing="2"') + T(P + 150, yy, esc(short(w.wallet)), 15) + T(P + hw - 22, yy, `${upW ? '+' : '−'}${usd(Math.abs(w.net))}`, 15, upW ? C.green : C.red, 'text-anchor="end"'); });
  } else s += T(P + 22, y + 100, 'No trades in the last 24 hours', 18, C.dim);
  s += panel(rx0, y, hw, r3) + T(rx0 + 22, y + 42, 'HOLDER PROFITABILITY', 20, C.white, 'letter-spacing="2"');
  const pr = ex.profit, prOk = pr && pr.holders >= 10 && pr.pctHolders != null && pr.coverage != null && pr.coverage >= 0.5;
  if (prOk) {
    s += T(rx0 + 22, y + 98, `${pr.pctHolders.toFixed(0)}%`, 40, pr.pctHolders >= 50 ? C.green : C.red) + T(rx0 + 22 + 20 + `${pr.pctHolders.toFixed(0)}%`.length * 24, y + 98, `of ${num(pr.holders)} holders are in profit right now`, 16, C.gray);
    s += cells(rx0 + 22, y + 140, hw - 44, [['IN PROFIT', pr.pctSupply != null ? `${pr.pctSupply.toFixed(0)}%` : '—'], ['TYPICAL BUY', { raw: priceInner(pr.medianEntry, 18) }], ['AVG BUY', { raw: priceInner(pr.avgEntry, 18) }], ['PRICE NOW', { raw: priceInner(pr.price, 18) }]], 18);
    s += T(rx0 + 22, y + 214, 'Holders by how far they are up or down since they bought', 14, C.gray);
    const BANDS = ['Down over 50%', 'Down 20 to 50%', 'Down under 20%', 'Up under 25%', 'Up 25 to 100%', 'More than 2x'];
    (pr.dist || []).slice(0, 6).forEach((b, i) => { const yy = y + 248 + i * 27;
      s += T(rx0 + 22, yy, BANDS[i] || esc(b.label), 14, C.white) + bar(rx0 + 170, yy - 9, hw - 330, 8, [[Math.max(0.01, b.pct / 100), i < 3 ? C.red : C.green]])
        + T(rx0 + hw - 70, yy, num(b.holders), 14, C.white, 'text-anchor="end"') + T(rx0 + hw - 22, yy, b.pct < 1 && b.holders ? '&lt;1%' : `${b.pct.toFixed(0)}%`, 14, C.gray, 'text-anchor="end"'); });
  } else s += T(rx0 + 22, y + 100, 'Not enough trades matched to wallets yet', 18, C.dim);
  // ── top holders | latest trades (10 each)
  y += r3 + G; const r4 = 432;
  s += panel(P, y, hw, r4) + T(P + 22, y + 42, 'TOP HOLDERS', 20, C.white, 'letter-spacing="2"') + T(P + hw - 22, y + 42, d?.holderCount ? `${num(d.holderCount)} holders` : '', 14, C.dim, 'text-anchor="end"');
  const poolSet = new Set(pools.map((q) => String(q.pool).toLowerCase()));
  (d?.holders || []).slice(0, 10).forEach((h, i) => { const yy = y + 80 + i * 34, a = String(h.address || '').toLowerCase();
    const named = h.label || KNOWN_HOLDER[a] || (poolSet.has(a) ? 'Liquidity pool' : null), lab = named || short(a), p = h.percent != null ? Math.max(0, Math.min(100, h.percent)) : null;
    s += T(P + 22, yy, `${i + 1}`, 15, C.dim) + T(P + 52, yy, esc(lab), 16, named ? C.gold : C.white);
    const tag = h.kind === 'locker' ? ['LOCKED', C.green] : h.kind === 'contract' ? ['CONTRACT', '#b8a3ff'] : null;
    if (tag) { const tx0 = P + 64 + lab.length * 9.6; s += `<rect x="${tx0}" y="${yy - 15}" width="${tag[0].length * 8 + 12}" height="20" rx="5" fill="none" stroke="${tag[1]}" stroke-opacity="0.5"/>` + T(tx0 + 6, yy, tag[0], 11, tag[1], 'letter-spacing="1"'); }
    s += bar(P + 260, yy - 10, hw - 370, 8, [[(p || 0) / 100, C.fire]]) + T(P + hw - 22, yy, p == null ? '—' : p > 0 && p < 0.01 ? '&lt;0.01%' : `${p.toFixed(2)}%`, 16, C.white, 'text-anchor="end"'); });
  if (!(d?.holders || []).length) s += T(P + 22, y + 90, 'Holder list not available', 16, C.dim);
  s += panel(rx0, y, hw, r4) + T(rx0 + 22, y + 42, 'LATEST TRADES', 20, C.white, 'letter-spacing="2"') + T(rx0 + hw - 22, y + 42, 'UTC', 14, C.dim, 'text-anchor="end"');
  const trades = (d?.swaps || []).filter((x) => x && isFinite(x.usd) && x.usd >= 0 && x.usd < 1e9).slice(0, 10);
  trades.forEach((x, i) => { const yy = y + 80 + i * 34, buy = x.side === 'buy';
    s += `<rect x="${rx0 + 22}" y="${yy - 19}" width="52" height="26" rx="7" fill="${buy ? '#10251a' : '#2a1210'}"/>` + T(rx0 + 48, yy - 1, buy ? 'BUY' : 'SELL', 13, buy ? C.green : C.red, 'text-anchor="middle"');
    s += T(rx0 + 88, yy, usd(x.usd), 17) + T(rx0 + 200, yy, esc(x.amount != null ? `${cmp(x.amount)} ${t?.symbol || ''}`.slice(0, 18) : ''), 14, C.gray)
      + T(rx0 + 370, yy, esc(x.trader ? short(x.trader) : ''), 15, C.gray) + T(rx0 + hw - 22, yy, x.time ? hhmm(x.time) : '', 15, C.gray, 'text-anchor="end"'); });
  if (!trades.length) s += T(rx0 + 22, y + 90, 'No recent trades found', 16, C.dim);
  // ── biggest trades 24h (top 3 each side, rows older than 24 h by OUR clock dropped)
  y += r4 + G; const bh2 = 196, nowS = Date.now() / 1000;
  [['buys', 'BIGGEST BUYS · 24H', C.green, P], ['sells', 'BIGGEST SELLS · 24H', C.red, rx0]].forEach(([k, title, col, x0]) => {
    s += panel(x0, y, hw, bh2) + T(x0 + 22, y + 42, title, 20, C.white, 'letter-spacing="2"') + T(x0 + hw - 22, y + 42, 'UTC', 14, C.dim, 'text-anchor="end"');
    const list = (d?.biggest?.h24?.[k] || []).filter((x) => x && x.usd != null && isFinite(x.usd) && x.usd >= 0 && x.usd < 1e9 && x.time >= nowS - 86400).slice(0, 3);
    list.forEach((x, i) => { const yy = y + 86 + i * 38;
      s += T(x0 + 22, yy, `${i + 1}`, 15, C.dim) + T(x0 + 46, yy, usd(x.usd), 22, col) + T(x0 + 180, yy, esc(`${cmp(x.amount)} ${t?.symbol || ''}`.trim().slice(0, 18)), 15, C.gray)
        + T(x0 + 350, yy, esc(x.trader ? short(x.trader) : ''), 15, C.gray) + T(x0 + hw - 22, yy, x.time ? hhmm(x.time) : '', 15, C.gray, 'text-anchor="end"'); });
    if (!list.length) s += T(x0 + 22, y + 92, `No ${k} in the last 24 hours`, 16, C.dim);
  });
  // ── top traders | info
  y += bh2 + G; const r5 = 250;
  s += panel(P, y, hw, r5);
  const tt = ex.traders, ttOk = tt && tt.coverage != null && tt.coverage >= 0.5 && (tt.rows || []).length;
  s += T(P + 22, y + 42, 'TOP TRADERS · BY PROFIT', 20, C.white, 'letter-spacing="2"');
  if (ttOk) {
    s += T(P + hw - 22, y + 42, `${num(tt.traders)} wallets`, 14, C.dim, 'text-anchor="end"');
    tt.rows.slice(0, 5).forEach((r, i) => { const yy = y + 84 + i * 34, up = r.pnl >= 0;
      s += T(P + 22, yy, `${i + 1}`, 15, C.dim) + T(P + 48, yy, esc(short(r.wallet)), 16) + T(P + 240, yy, `bought ${usd(r.bought)}`, 15, C.gray)
        + T(P + hw - 22, yy, `${up ? '+' : '−'}${usd(Math.abs(r.pnl))}`, 18, up ? C.green : C.red, 'text-anchor="end"'); });
  } else s += T(P + 22, y + 100, 'Wallets are still being matched to trades', 18, C.dim);
  s += panel(rx0, y, hw, r5) + T(rx0 + 22, y + 42, 'INFO', 20, C.white, 'letter-spacing="2"');
  const ct = d?.contract || {};
  [['Contract', addr], ['Standard', 'ERC20'], ['Decimals', String(d?.dec ?? ct.decimals ?? t?.decimals ?? '—')], ['Pool', t?.poolId || t?.pool ? short(t.poolId || t.pool) : '—'],
   ['Creator', ct.creator ? short(ct.creator) : '—'], ['Transfers 24h', ct.transfers24h != null ? num(ct.transfers24h) : '—']]
    .forEach(([k, v], i) => { const yy = y + 80 + i * 28; s += T(rx0 + 22, yy, k, 15, C.gray) + T(rx0 + hw - 22, yy, esc(v), k === 'Contract' ? 13 : 15, C.white, 'text-anchor="end"'); });
  // ── footer
  y += r5 + G; const H = y + 130;
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
      const [row, d, c15, c5, logo, , b15, flow, traders, daily, profit] = await Promise.all([within(v2(`token/${tokenAddr}`), 5000), within(v2(`token/${tokenAddr}/detail`), 9000),
        within(v2(`token/${tokenAddr}/candles?sec=900&look=259200`), 6000), within(v2(`token/${tokenAddr}/candles?sec=300&look=86400`), 6000), within(tokenLogo(tokenAddr), 3000, ''), ensureWasm(),
        // the swap store (10-21): real 15m candles, money flow, top traders, daily closes since launch — each optional
        within(v2(`token/${tokenAddr}/bars?res=15m&limit=288`), 6000), within(v2(`token/${tokenAddr}/flow`), 6000),
        within(v2(`token/${tokenAddr}/traders?limit=5`), 7000), within(v2(`token/${tokenAddr}/bars?res=1d&limit=400`), 6000),
        within(v2(`token/${tokenAddr}/profitability`), 7000)]);
      // token names/symbols are the creator's own text — shown as they are, emojis included (owner 09-29: the no-emoji
      // rule is for OUR wording, not token data)
      const t = row?.token ?? null;
      if (!t) throw new Error('token not found');
      // 15-minute candles over 3 days; a token younger than ~6 h gets 5-minute candles over 24 h instead
      const long = (b15?.candles || []).length >= 24 ? b15.candles : c15?.candles || [], shortC = c5?.candles || [];
      const [cs, tf] = long.length >= 24 ? [long.slice(-160), '15m candles · last 3 days'] : [shortC.slice(-160), '5m candles · last 24 hours'];
      const now = new Date(), st = stampOf(now);
      // the card's colour comes from the token's logo; a grey/black/white or missing logo gets a quiet neutral
      const acc = accentOf(logoAccent(logo)) || { line: '#9aa3b2', glow: '#5b6475' };
      const png = new Resvg(tokenTall(t, d, cs, tf, logo, st, tokenAddr, acc, { flow, traders, daily, profit }), { font: { fontBuffers: [FONT], defaultFontFamily: 'Open Sans', loadSystemFonts: false }, fitTo: { mode: 'width', value: 1200 } }).render().asPng();
      res.setHeader('content-type', 'image/png');
      const symSafe = String(t.symbol || 'token').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'token';
      if (download) { res.setHeader('content-disposition', `attachment; filename="statera-${symSafe}-snapshot-${st.file}-UTC.png"`); res.setHeader('cache-control', 'no-store'); }
      else res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).send(Buffer.from(png));
    }
    const [c, l, w, logos, , act] = await Promise.all([within(v2('chain'), 4500), within(v2('lending'), 4500), within(v2('where'), 4500), isWide ? {} : within(validatorLogos(origin), 3000, {}), ensureWasm(),
      isWide ? null : within(v2('activity'), 4500)]);
    if (!c) throw new Error('no chain data');
    const now = new Date(), when = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC', st = stampOf(now);
    const png = new Resvg(isWide ? wide(c, l, w, when) : tall(c, l, w, st, logos || {}, act && act.h24 ? act : null), {
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
