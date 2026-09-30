// /network for crawlers AND people: serves the same SPA shell, with og:/twitter: meta pointing at the live Arc Network Report
// image (api/report.js, wide 1200×630), so a posted stateraarc.com/network link unfurls into the report card. Same pattern
// as api/token.js. The image URL carries a 5-minute bucket: X caches a card image per exact URL.
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
export default async function handler(req, res) {
  const origin = `https://${req.headers.host}`;
  let html = await fetch(`${origin}/index.html`, { headers: { 'x-og-render': '1' } }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (!html) { res.statusCode = 302; res.setHeader('location', '/'); return res.end(); }
  const bucket = Math.floor(Date.now() / 300000);
  const img = `${origin}/api/report?wide=1&t=${bucket}`;
  // Crawlers fetch the image once with a short timeout and keep a failure for good — render it now so theirs is a cache hit.
  if (/bot|crawler|spider|facebookexternalhit|embedly|slack|whatsapp|telegram|discord|preview/i.test(req.headers['user-agent'] || '')) {
    await Promise.race([fetch(img).then((r) => r.arrayBuffer()), new Promise((r) => setTimeout(r, 3500))]).catch(() => {});
  }
  const title = 'Arc Network Report — live from Arc mainnet · StateraArc';
  const desc = "Money on Arc, where it sits (lending, DEX pools, wallets), Circle bridge flows, lending, validators — read live from the chain.";
  const meta = [
    `<meta property="og:title" content="${esc(title)}"/>`, `<meta property="og:description" content="${esc(desc)}"/>`,
    `<meta property="og:image" content="${img}"/>`, `<meta property="og:image:width" content="1200"/>`, `<meta property="og:image:height" content="630"/>`,
    `<meta property="og:type" content="website"/>`, `<meta property="og:url" content="${origin}/network"/>`, `<meta property="og:site_name" content="StateraArc"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`, `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta name="twitter:description" content="${esc(desc)}"/>`, `<meta name="twitter:image" content="${img}"/>`,
  ].join('\n');
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = html.replace(/\s*<meta[^>]+(property="og:[^"]*"|name="twitter:[^"]*")[^>]*>/gi, '');
  html = html.replace('</head>', meta + '\n</head>');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // 09-30: stale-while-revalidate was 300 s — after a deploy the edge kept serving HTML that named the OLD script
  // (404 → blank page) for up to ~6 min. 10 s now; index.html also reloads once if a script fails.
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=10');
  res.status(200).send(html);
}
