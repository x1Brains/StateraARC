// Resilient RadarDEX proxy.
// RadarDEX (api.radardex.pro) sits behind Cloudflare, which HARD-BLOCKS Vercel's datacenter IPs
// (verified 0/6 from Vercel, 6/6 from a clean IP). The old rewrite forwarded the challenge HTML, so
// radarGet's JSON.parse threw and the whole site (screener/portfolio/token pages) stalled on "Loading…".
// Fix: fetch through a clean-IP relay (our VPS, which RadarDEX does not block) configured via private
// env vars — RADAR_UPSTREAM (e.g. http://host:8787) + RADAR_KEY — so the box IP/key stay OUT of this
// public repo. We try the relay first, fall back to hitting RadarDEX directly, and EDGE-CACHE good
// responses so a transient failure is smoothed over by cached/stale data.
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
  const path = (req.url || '').replace(/^\/api\/radar/, '') || '/';
  // Prefer the clean-IP relay; fall back to hitting RadarDEX directly.
  const targets = [];
  if (RELAY) targets.push({ url: RELAY + path, headers: { 'x-relay-key': RELAY_KEY, Accept: 'application/json' } });
  targets.push({ url: DIRECT + path, headers: BROWSER });
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
