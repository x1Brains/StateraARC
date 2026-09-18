// Resilient RadarDEX proxy.
// RadarDEX (api.radardex.pro) sits behind Cloudflare, which INTERMITTENTLY serves a "Just a moment…"
// challenge page to Vercel's datacenter IPs. The old dumb rewrite forwarded that HTML straight to the
// client, so radarGet's JSON.parse threw and the whole site (screener/portfolio/token pages) stalled
// on "Loading…". This function:
//   • sends browser-like headers (passes Cloudflare's managed challenge far more often),
//   • retries a few times when a challenge slips through,
//   • CACHES good responses at the Vercel edge (s-maxage + stale-while-revalidate) so a transient
//     challenge is served from cache instead of blanking the UI.
const UPSTREAM = 'https://api.radardex.pro';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://radardex.pro/',
};
const looksChallenged = (status, text) =>
  status >= 400 || /just a moment|cf-challenge|challenge-platform|enable javascript|<!doctype html|<html/i.test((text || '').slice(0, 300));

export default async function handler(req, res) {
  const path = (req.url || '').replace(/^\/api\/radar/, '') || '/';
  const url = UPSTREAM + path;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: BROWSER_HEADERS });
      const text = await r.text();
      if (!looksChallenged(r.status, text)) {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('access-control-allow-origin', '*');
        // Edge-cache good data so an intermittent challenge is smoothed over by cached/stale responses.
        res.setHeader('cache-control', 'public, s-maxage=45, stale-while-revalidate=300');
        return res.status(200).send(text);
      }
    } catch {
      /* network error → retry */
    }
    await new Promise((done) => setTimeout(done, 300 * (i + 1)));
  }
  res.setHeader('cache-control', 'no-store');
  return res.status(502).json({ error: 'radar upstream unavailable' });
}
