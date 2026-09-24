// The screener's token list, served from the VPS builder — NOT from a Vercel deploy.
// The VPS rebuilds the list from chain every 30 min; it used to publish by committing to git, i.e. one
// Vercel DEPLOY per refresh (~48/day). On 09-24 the Hobby deploy limit blocked the good build for a day and
// the site sat on a gutted 43-token list. Now the VPS serves its latest good build (holdings-svc
// /holdings/snapshot, key-gated, only replaced by builds with >= 500 tokens) and this edge-caches it.
// Fallback: the static /tokens-snapshot.json baked into this deploy.
export default async function handler(req, res) {
  const UP = process.env.HOLDINGS_UPSTREAM, KEY = process.env.HOLDINGS_KEY;
  if (UP && KEY) {
    try {
      const r = await fetch(`${UP.replace(/\/+$/, '')}/holdings/snapshot`, { headers: { 'x-relay-key': KEY }, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const text = await r.text();
        const j = JSON.parse(text);
        if (j && Array.isArray(j.tokens) && j.tokens.length >= 200) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=900');
          res.setHeader('x-snapshot-source', 'vps');
          if (r.headers.get('x-snapshot-age')) res.setHeader('x-snapshot-age', r.headers.get('x-snapshot-age'));
          return res.status(200).send(text);
        }
      }
    } catch { /* fall back to the static file */ }
  }
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', '/tokens-snapshot.json');
  return res.status(307).end();
}
