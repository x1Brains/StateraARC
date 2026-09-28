// /api/v2/* → the v2 data API on the VPS (server/statera-api.ts via the Tailscale funnel path /v2), edge-cached.
// Same upstream + key as /api/snapshot (HOLDINGS_UPSTREAM / HOLDINGS_KEY). The API computes the board ONCE for all
// visitors; the browser gets KBs instead of the 1.14 MB list + ~130 RPC calls per page (v1). On any failure this answers
// 502 and the page falls back to the v1 path by itself (src/lib/v2.ts → App.tsx).
const ALLOWED = /^(health|home|board|search|list|swap-tokens|tokens|chain|lending|token\/0x[0-9a-fA-F]{40}(\/(detail|candles))?)$/;
export default async function handler(req, res) {
  const UP = process.env.HOLDINGS_UPSTREAM, KEY = process.env.HOLDINGS_KEY;
  const path = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  if (!ALLOWED.test(path)) return res.status(404).json({ error: 'unknown path' });
  if (!UP || !KEY) return res.status(502).json({ error: 'v2 not configured' });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== 'path' && typeof v === 'string') qs.set(k, v.slice(0, 4000));
  try {
    const r = await fetch(`${UP.replace(/\/+$/, '')}/v2/${path}${qs.toString() ? '?' + qs : ''}`, { headers: { 'x-relay-key': KEY, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    if (r.status >= 500) return res.status(502).json({ error: 'v2 upstream ' + r.status });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', r.headers.get('cache-control') || 'public, s-maxage=10, stale-while-revalidate=60');
    for (const h of ['x-statera-asof', 'x-snapshot-age']) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
    return res.status(r.status).send(text);
  } catch (e) { return res.status(502).json({ error: 'v2 unreachable' }); }
}
