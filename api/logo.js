// Token logo from the VPS logo cache (scripts/logo-cache.mjs pre-converts each listed token's logo to a 192px PNG — IPFS,
// WebP and oversized images included). The snapshot points tokens that have no logo URL of their own here.
// Rewrite: /api/logo/:addr -> /api/logo?addr=:addr. Edge-cached a day; a miss is a 404 (the site falls back to its letter badge).
export default async function handler(req, res) {
  const addr = (new URL(req.url, 'http://x').searchParams.get('addr') || '').toLowerCase();
  const UP = process.env.HOLDINGS_UPSTREAM, KEY = process.env.HOLDINGS_KEY;
  if (!/^0x[0-9a-f]{40}$/.test(addr) || !UP || !KEY) { res.statusCode = 404; return res.end(); }
  try {
    const r = await fetch(`${UP.replace(/\/+$/, '')}/holdings/logo/${addr}`, { headers: { 'x-relay-key': KEY }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) { res.statusCode = 404; res.setHeader('cache-control', 'public, s-maxage=600'); return res.end(); }
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    res.statusCode = 200; return res.end(Buffer.from(await r.arrayBuffer()));
  } catch { res.statusCode = 404; return res.end(); }
}
