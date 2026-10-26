// Resilient RadarDEX proxy (single function — the [...path] catch-all only matched one segment on
// this Vite project, so token/holders/portfolio 404'd). A vercel.json rewrite funnels every
// /api/radar/:path* here as ?path=:path*; we rebuild the upstream path and forward it.
//
// Why a proxy at all: RadarDEX (api.radardex.pro) sits behind Cloudflare, which HARD-BLOCKS Vercel's
// datacenter IPs (0/6 from Vercel, 6/6 from a clean IP). So we fetch through a clean-IP relay (our VPS,
// which RadarDEX doesn't block) configured via private env vars RADAR_UPSTREAM + RADAR_KEY (kept OUT of
// this public repo), fall back to hitting RadarDEX directly, and EDGE-CACHE good responses so a
// transient failure is smoothed over by cached/stale data.
const DIRECT = 'https://api.radardex.pro';
const RELAY = process.env.RADAR_UPSTREAM || '';
const RELAY_KEY = process.env.RADAR_KEY || '';
// 10-26: honest client headers (no browser User-Agent / Referer spoofing).
const DIRECT_HEADERS = {
  'User-Agent': 'StateraArc/1.0 (+https://www.stateraarc.com)',
  Accept: 'application/json',
};
// Retry/fail-over ONLY on a Cloudflare HTML challenge or a 5xx/network error. A 4xx with a JSON body
// (e.g. RadarDEX's {"error":"token not found"}) is a REAL answer — pass it straight through.
const isChallenge = (text) => /just a moment|cf-challenge|challenge-platform|enable javascript|<!doctype html|<html/i.test((text || '').slice(0, 300));

export default async function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const sub = (u.searchParams.get('path') || '').replace(/^\/+/, '');
  u.searchParams.delete('path');
  // 10-26: the path is forwarded to the keyed relay — only plain segments (no '..', '.', '%', '\\' or empty segments),
  // so a crafted ?path= can never climb out of the RadarDEX API onto other paths of the relay host.
  const segs = sub.split('/');
  if (!sub || sub.length > 200 || !/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(sub) || segs.some((p) => p === '.' || p === '..')) {
    res.setHeader('cache-control', 'no-store');
    return res.status(400).json({ error: 'bad path' });
  }
  const qs = u.searchParams.toString();
  const suffix = '/' + sub + (qs ? '?' + qs : '');

  const targets = [];
  if (RELAY) targets.push({ url: RELAY + suffix, headers: { 'x-relay-key': RELAY_KEY, Accept: 'application/json' } });
  targets.push({ url: DIRECT + suffix, headers: DIRECT_HEADERS });

  for (const t of targets) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(t.url, { headers: t.headers });
        const text = await r.text();
        if (!isChallenge(text) && r.status < 500) {
          // real answer (2xx, or a 4xx like "token not found") — pass it through
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', r.status === 200 ? 'public, s-maxage=45, stale-while-revalidate=600' : 'no-store');
          return res.status(r.status).send(text);
        }
        // challenge or 5xx → retry, then try the next target
      } catch {
        /* try again / next target */
      }
      await new Promise((done) => setTimeout(done, 250 * (i + 1)));
    }
  }
  res.setHeader('cache-control', 'no-store');
  return res.status(502).json({ error: 'radar upstream unavailable' });
}
