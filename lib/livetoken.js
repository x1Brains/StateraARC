// Live token data for the share cards (api/og.js image + api/token.js page meta).
// ⛔ Both used to read the STATIC /tokens-snapshot.json baked into the last deploy — since the VPS stopped
// deploying per refresh (09-24) that file is only a ≤6h git backup, so X/Discord cards showed prices hours old
// (measured 2.5h behind the site, 09-25). Now: the snapshot comes from /api/snapshot (the VPS's latest on-chain
// build, same list the site shows), and the PRICE is re-read from the token's own pool at request time
// (V3 slot0 / V4 StateView) — on-chain is primary, the snapshot is only the fallback. Kept out of /api so
// Vercel doesn't compile it as a function.
const RPCS = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org', 'https://arc.gateway.tenderly.co'];
const V4_STATEVIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

async function ethCall(to, data) {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j && j.result && j.result !== '0x') return j.result;
    } catch { /* next node */ }
  }
  return null;
}

/** The token's row from the site's current list: /api/snapshot (VPS, follows its 307 to the static file if the VPS is down). */
export async function snapshotRow(origin, addr) {
  for (const u of [`${origin}/api/snapshot`, `${origin}/tokens-snapshot.json`]) {
    try {
      const snap = await fetch(u, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
      if (!snap || !Array.isArray(snap.tokens)) continue;
      return snap.tokens.find((x) => (x.address || '').toLowerCase() === addr) || null;
    } catch { /* next source */ }
  }
  return null;
}

/** USD price read from the pool right now, or null. Same math as the site (arc.ts v4PriceOf / slot0). */
export async function chainPrice(t) {
  if (!t) return null;
  const dexp = 10 ** ((t.decimals ?? 18) - 6);
  let sq = null;
  try {
    if (t.poolId) {
      const r = await ethCall(V4_STATEVIEW, '0xc815641c' + t.poolId.replace(/^0x/, '').padStart(64, '0')); // getSlot0(poolId)
      if (r) sq = BigInt('0x' + r.slice(2, 66)) & ((1n << 160n) - 1n);
    } else if (t.pool) {
      const r = await ethCall(t.pool, '0x3850c7bd'); // slot0()
      if (r) sq = BigInt(r.slice(0, 66));
    }
  } catch { return null; }
  if (!sq || sq <= 0n) return null;
  const ratio = (Number(sq) / 2 ** 96) ** 2;
  const p = (t.usdcIsC0 ? 1 / ratio : ratio) * dexp;
  return isFinite(p) && p > 0 && p < 1e6 ? p : null;
}

/**
 * Snapshot row with price/mcap/24h change brought up to the live pool price. mcap scales with price (same
 * supply); the 24h change keeps the snapshot's 24h-ago reference price. A live read that disagrees wildly
 * with the snapshot (>20x) is treated as a bad read and ignored.
 */
export async function liveToken(origin, addr) {
  const t = await snapshotRow(origin, addr);
  if (!t) return null;
  const live = await chainPrice(t);
  if (live == null || !(t.price > 0)) return live == null ? t : { ...t, price: live, priceLive: true };
  const k = live / t.price;
  if (k > 20 || k < 1 / 20) return t;
  const ch = t.change24h;
  return {
    ...t, price: live, priceLive: true,
    mcap: t.mcap != null ? t.mcap * k : null,
    change24h: ch != null && ch > -100 ? ((1 + ch / 100) * k - 1) * 100 : ch,
  };
}
