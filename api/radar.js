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
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://radardex.pro/',
};
const looksBad = (status, text) =>
  status >= 400 || /just a moment|cf-challenge|challenge-platform|enable javascript|<!doctype html|<html/i.test((text || '').slice(0, 300));

export default async function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const sub = (u.searchParams.get('path') || '').replace(/^\/+/, '');
  u.searchParams.delete('path');
  const qs = u.searchParams.toString();
  const suffix = '/' + sub + (qs ? '?' + qs : '');

  const targets = [];
  if (RELAY) targets.push({ url: RELAY + suffix, headers: { 'x-relay-key': RELAY_KEY, Accept: 'application/json' } });
  targets.push({ url: DIRECT + suffix, headers: BROWSER });

  for (const t of targets) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(t.url, { headers: t.headers });
        const text = await r.text();
        if (!looksBad(r.status, text)) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader('cache-control', 'public, s-maxage=45, stale-while-revalidate=600');
          return res.status(200).send(text);
        }
      } catch {
        /* try again / next target */
      }
      await new Promise((done) => setTimeout(done, 250 * (i + 1)));
    }
  }
  res.setHeader('cache-control', 'no-store');
  return res.status(502).json({ error: 'radar upstream unavailable' });
}
