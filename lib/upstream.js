// Fetch from the VPS through the Tailscale funnel, retrying CONNECTION failures (never an HTTP answer).
// ⛔ 09-28: one of the funnel's two public entry servers (208.111.35.209) failed TLS while the other worked, and DNS hands
// out either — about half of all calls died at connect. A fresh connection usually lands on the healthy entry, so a
// connect error is retried up to 3 more times with a short back-off. Used by every /api function that reaches the VPS.
export async function fetchUpstream(url, init = {}, { tries = 4, timeoutMs = 8000, lastTimeoutMs = 20000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), connection: 'close' }, signal: AbortSignal.timeout(i < tries - 1 ? timeoutMs : lastTimeoutMs) });
      r.tries = i + 1;
      return r;
    } catch (e) { lastErr = e; if (i < tries - 1) await new Promise((ok) => setTimeout(ok, 150 * (i + 1))); }
  }
  throw lastErr || new Error('upstream unreachable');
}
