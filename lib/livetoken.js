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
// ── A token that isn't in the list, built straight from chain ────────────────────────────────────────────────────────
// ⛔ 09-25: a shared link for a token the snapshot doesn't carry (Builders 0xa37c…: its V3 pool predates the indexer's
// first sweep) unfurled as a generic "$TOKEN —" card with no name, logo or price. A card must NEVER be blank: read the
// ERC-20 itself, its deepest V3 USDC pool (price = slot0, liquidity = both sides, token side capped 3x like the site),
// supply → mcap, holders from arc-scan, and Warp's price only if no pool answers.
const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
const USDC = '0x3600000000000000000000000000000000000000';
const pad = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const abiStr = (h) => { try { if (!h || h.length < 130) return null; const len = parseInt(h.slice(66, 130), 16); return Buffer.from(h.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0/g, '').trim() || null; } catch { return null; } };
async function rpcRaw(method, params) {
  for (const url of RPCS) {
    try { const j = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(3000) }).then((r) => r.json()); if (j && j.result != null) return j.result; } catch { /* next */ }
  }
  return null;
}
export async function chainRow(origin, addr) {
  const [symH, nameH, decH, supH, ...pools] = await Promise.all([
    ethCall(addr, '0x95d89b41'), ethCall(addr, '0x06fdde03'), ethCall(addr, '0x313ce567'), ethCall(addr, '0x18160ddd'),
    ...[100, 500, 3000, 10000].map((f) => ethCall(V3_FACTORY, '0x1698ee82' + pad(addr) + pad(USDC) + f.toString(16).padStart(64, '0'))),
  ]);
  const symbol = abiStr(symH); if (!symbol) return null; // not an ERC-20 we can read
  const decimals = decH ? Number(BigInt(decH)) : 18;
  const supply = supH ? Number(BigInt(supH)) / 10 ** decimals : null;
  const cands = pools.map((r) => (r && r.length >= 66 ? '0x' + r.slice(-40).toLowerCase() : null)).filter((p) => p && !/^0x0+$/.test(p));
  let best = null;
  for (const p of cands) {
    const [bal, t0, s0, tb] = await Promise.all([rpcRaw('eth_getBalance', [p, 'latest']), ethCall(p, '0x0dfe1681'), ethCall(p, '0x3850c7bd'), ethCall(addr, '0x70a08231' + pad(p))]);
    const usdc = bal ? Number(BigInt(bal)) / 1e18 : 0;
    if (!best || usdc > best.usdc) best = { pool: p, usdc, usdcIsC0: t0 ? ('0x' + t0.slice(-40)).toLowerCase() === USDC : false, s0, tok: tb ? Number(BigInt(tb)) / 10 ** decimals : 0 };
  }
  let price = null, liq = null, pool = null, usdcIsC0 = false;
  if (best && best.usdc >= 1 && best.s0) {
    try { const sq = BigInt(best.s0.slice(0, 66)); const ra = (Number(sq) / 2 ** 96) ** 2; const p = (best.usdcIsC0 ? 1 / ra : ra) * 10 ** (decimals - 6); if (isFinite(p) && p > 0 && p < 1e6) price = p; } catch { /* */ }
    if (price != null) { liq = best.usdc + Math.min(best.tok * price, best.usdc * 3); pool = best.pool; usdcIsC0 = best.usdcIsC0; }
  }
  const [warp, scan] = await Promise.all([
    fetch(`${origin}/api/warp/tokens/${addr}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null),
    fetch(`https://api.arc-scan.org/v1/tokens/${addr}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null),
  ]);
  if (price == null && warp && Number(warp.price) > 0) price = Number(warp.price) * 10 ** (decimals - 18); // Warp ignores decimals
  const holders = scan?.holders != null ? Number(scan.holders) : (warp?.holders ?? null);
  const change24h = warp?.change24h != null && isFinite(Number(warp.change24h)) ? Number(warp.change24h) : null;
  return { address: addr, symbol, name: abiStr(nameH) || symbol, decimals, price, liq, mcap: price != null && supply ? price * supply : null,
    holders, change24h, volume24h: warp?.volume24h != null ? Number(warp.volume24h) : null, iconUrl: warp?.image || null, pool, usdcIsC0, poolId: null, fromChain: true };
}

export async function liveToken(origin, addr) {
  let t = await snapshotRow(origin, addr);
  if (!t) { t = await chainRow(origin, addr).catch(() => null); return t; } // not listed → built from chain (price already live)
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
