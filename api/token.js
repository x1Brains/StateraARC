// Server-rendered HTML for /token/:addr so X / Discord / Telegram unfurl a per-token card.
// A Vite SPA ships one static index.html with generic meta — crawlers don't run JS, so they'd all
// show the same preview. This function serves the SAME shell (so the app still boots) but injects
// per-token og:/twitter: meta pointing at /api/og?token=… Vercel rewrite: /token/:addr -> here.

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const fmtUsd = (n) => {
  if (n == null || !isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  return '$' + n.toFixed(12).replace(/0+$/, '');
};

export default async function handler(req, res) {
  const origin = `https://${req.headers.host}`;
  const url = new URL(req.url, origin);
  let addr = (url.searchParams.get('addr') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { const m = url.pathname.match(/0x[0-9a-f]{40}/i); addr = m ? m[0].toLowerCase() : ''; }

  // The real built SPA shell (hashed script/style tags intact) — fetched, not hardcoded.
  let html = await fetch(`${origin}/index.html`, { headers: { 'x-og-render': '1' } }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (!html) { res.statusCode = 302; res.setHeader('location', `/`); return res.end(); }

  let t = null;
  if (addr) {
    try { const snap = await fetch(`${origin}/tokens-snapshot.json`, { cache: 'no-store' }).then((r) => r.json()); t = (snap.tokens || []).find((x) => (x.address || '').toLowerCase() === addr) || null; } catch { /* no data */ }
  }

  const sym = t?.symbol || 'Token';
  const price = fmtUsd(t?.price);
  const ch = t?.change24h;
  const chTxt = ch == null ? '' : ` (${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h)`;
  const title = t ? `$${sym}${price ? ` · ${price}` : ''}${chTxt} — StateraArc` : 'StateraArc — Arc token screener';
  const desc = t
    ? `${t.name || sym} on Arc mainnet — live price, chart, liquidity, holders and real-time trades on StateraArc.`
    : 'Live Arc-mainnet token screener — price, charts, liquidity, holders and trades.';
  const img = addr ? `${origin}/api/og?token=${addr}` : `${origin}/api/og`;
  const pageUrl = `${origin}/token/${addr}`;

  const meta = [
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(desc)}"/>`,
    `<meta property="og:image" content="${img}"/>`,
    `<meta property="og:image:width" content="1200"/>`,
    `<meta property="og:image:height" content="630"/>`,
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:url" content="${pageUrl}"/>`,
    `<meta property="og:site_name" content="StateraArc"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta name="twitter:description" content="${esc(desc)}"/>`,
    `<meta name="twitter:image" content="${img}"/>`,
  ].join('\n');

  // Swap the <title> and drop any existing og:/twitter: tags so ours are authoritative, then inject.
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = html.replace(/\s*<meta[^>]+(property="og:[^"]*"|name="twitter:[^"]*")[^>]*>/gi, '');
  html = html.replace('</head>', meta + '\n</head>');

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
  res.statusCode = 200;
  res.end(html);
}
