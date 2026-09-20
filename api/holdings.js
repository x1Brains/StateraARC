// Wallet holdings, read straight from the chain — NOT from a single indexer.
// explorer.arc.io is Cloudflare-walled and RadarDEX /portfolio only knows tokens it pools, so a wallet's
// real bag (nanocaps, airdrops) went missing. This reads it the honest way, like a block explorer does:
//   1. discover every token the wallet RECEIVED via Transfer logs (topic2=wallet) over its active range,
//   2. balanceOf all of them via Multicall3 (one call per ~300),
//   3. name/symbol/decimals on-chain for anything our snapshot doesn't already know,
//   4. price from the snapshot, else the token's on-chain V3/V2 USDC pool.
// Multi-RPC rotation + retry (our 3 receipt-reliable Arc endpoints) so no single RPC's rate limit breaks it.

const RPCS = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org', 'https://arc.gateway.tenderly.co'];
const USDC = '0x3600000000000000000000000000000000000000';
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11'; // Multicall3 (canonical, present on Arc)
const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
const V2_FACTORY = '0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

const pad = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexN = (n) => '0x' + n.toString(16);

let rr = 0, rid = 0;
async function rpc(method, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rr++) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }), signal: AbortSignal.timeout(9000) }).then((x) => x.json());
      if (r && r.error && (r.error.code === -32005 || /rate/i.test(r.error.message || ''))) { await sleep(250 * (i + 1)); continue; }
      return r;
    } catch { await sleep(250 * (i + 1)); }
  }
  return { error: 'exhausted' };
}
async function mapPool(items, fn, conc = 6) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
function decStr(hex) { if (!hex || hex === '0x') return null; try { const d = hex.slice(2); if (d.length <= 128) { const s = Buffer.from(d, 'hex').toString('utf8').replace(/\0/g, '').trim(); return s || null; } const len = parseInt(d.slice(64, 128), 16); return Buffer.from(d.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '') || null; } catch { return null; } }

// Multicall3 aggregate3((address target,bool allowFailure,bytes callData)[]) -> (bool,bytes)[]
function encAggregate3(calls) {
  const n = calls.length;
  const heads = []; const tails = []; let off = n * 32;
  for (const c of calls) {
    const cd = c.data.slice(2);
    const cdPadded = cd + '0'.repeat((64 - (cd.length % 64)) % 64);
    const tuple = pad(c.target) + (1).toString(16).padStart(64, '0') + (96).toString(16).padStart(64, '0') + (cd.length / 2).toString(16).padStart(64, '0') + cdPadded;
    heads.push(off.toString(16).padStart(64, '0')); tails.push(tuple); off += tuple.length / 2;
  }
  return '0x82ad56cb' + (32).toString(16).padStart(64, '0') + n.toString(16).padStart(64, '0') + heads.join('') + tails.join('');
}
async function multicall(calls) {
  const r = await call(MC, encAggregate3(calls));
  if (!r || !r.result) return calls.map(() => ({ ok: false, data: '0x' }));
  const d = r.result.slice(2); const arrOff = parseInt(d.slice(0, 64), 16) * 2; const n = parseInt(d.slice(arrOff, arrOff + 64), 16); const base = arrOff + 64;
  const out = [];
  for (let k = 0; k < n; k++) {
    const elOff = base + parseInt(d.slice(base + k * 64, base + k * 64 + 64), 16) * 2;
    const ok = parseInt(d.slice(elOff, elOff + 64), 16) === 1;
    const bytesOff = elOff + parseInt(d.slice(elOff + 64, elOff + 128), 16) * 2;
    const len = parseInt(d.slice(bytesOff, bytesOff + 64), 16);
    out.push({ ok, data: '0x' + d.slice(bytesOff + 64, bytesOff + 64 + len * 2) });
  }
  return out;
}
async function multicallChunked(calls, size = 300) {
  const res = [];
  for (let i = 0; i < calls.length; i += size) res.push(...await multicall(calls.slice(i, i + size)));
  return res;
}

export default async function handler(req, res) {
  const origin = `https://${req.headers.host}`;
  const url = new URL(req.url, origin);
  const addr = (url.searchParams.get('addr') || url.searchParams.get('address') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad address' })); }

  try {
    // Snapshot = free metadata + prices for the tokens we already track.
    const snap = await fetch(`${origin}/tokens-snapshot.json`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ tokens: [] }));
    const meta = new Map((snap.tokens || []).map((t) => [t.address.toLowerCase(), t]));

    const head = BigInt((await rpc('eth_blockNumber', [])).result || '0x0');
    if (head === 0n) throw new Error('no head');

    // Wallet's active range (bounds the log scan to a handful of calls, not the whole chain).
    let oldest = null, page = '', guard = 0;
    do {
      const j = await fetch(`https://api.arc-scan.org/v1/address/${addr}/txs?limit=100${page ? '&page=' + page : ''}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({}));
      const items = j.items || []; if (items.length) oldest = items[items.length - 1].block;
      page = j.page && j.page.next ? j.page.next : ''; guard++;
    } while (page && guard < 15);
    const from = BigInt(oldest != null ? oldest : Number(head) - 800000);

    // Discover received tokens via Transfer logs (topic2 = wallet) in 9.5k chunks, rotated across RPCs.
    const CH = 9500n; const ranges = [];
    for (let f = from; f < head; f += CH) ranges.push([f, f + CH > head ? head : f + CH]);
    const contracts = new Set([USDC]);
    await mapPool(ranges, async ([f, t]) => {
      const r = await rpc('eth_getLogs', [{ fromBlock: hexN(f), toBlock: hexN(t), topics: [TRANSFER, null, '0x' + pad(addr)] }]);
      if (Array.isArray(r.result)) for (const l of r.result) contracts.add((l.address || '').toLowerCase());
    }, 6);
    contracts.delete(''); contracts.delete(ZERO);
    const list = [...contracts];

    // USDC is Arc's NATIVE gas token (0x3600) — the real balance is the native balance (18-dec),
    // NOT balanceOf on the precompile (that reads as dust). Read it directly and exclude 0x3600 below.
    const nativeRaw = BigInt((await rpc('eth_getBalance', [addr, 'latest'])).result || '0x0');
    const nativeUsdc = Number(nativeRaw) / 1e18;

    // balanceOf every candidate (except native USDC), keep non-zero.
    const scanList = list.filter((a) => a !== USDC);
    const balRes = await multicallChunked(scanList.map((a) => ({ target: a, data: '0x70a08231' + pad(addr) })));
    const held = [];
    if (nativeUsdc > 0) held.push({ address: USDC, raw: nativeRaw, native: true });
    scanList.forEach((a, i) => { const b = balRes[i]; if (b && b.ok && b.data.length >= 66) { const raw = BigInt(b.data.slice(0, 66)); if (raw > 0n) held.push({ address: a, raw }); } });

    // Metadata for tokens the snapshot doesn't know (symbol/name/decimals on-chain, batched).
    const unknown = held.filter((h) => !meta.has(h.address));
    if (unknown.length) {
      const calls = [];
      for (const h of unknown) { calls.push({ target: h.address, data: '0x95d89b41' }, { target: h.address, data: '0x06fdde03' }, { target: h.address, data: '0x313ce567' }); }
      const mr = await multicallChunked(calls, 150);
      unknown.forEach((h, i) => {
        const sym = decStr(mr[i * 3]?.data), nm = decStr(mr[i * 3 + 1]?.data);
        const decHex = mr[i * 3 + 2]?.data; const dec = decHex && decHex !== '0x' ? parseInt(decHex.slice(0, 66), 16) : 18;
        h.on = { symbol: sym, name: nm, decimals: Number.isFinite(dec) && dec <= 36 ? dec : 18 };
      });
    }

    // Price unknowns from their on-chain V3/V2 USDC pool (best-effort, batched).
    const priceMap = new Map(); // addr -> price
    if (unknown.length) {
      // 1) find a USDC pool per token (V3 fees + V2), one multicall.
      const poolCalls = [];
      for (const h of unknown) {
        for (const fee of [10000, 3000, 500, 100]) poolCalls.push({ target: V3_FACTORY, data: '0x1698ee82' + pad(h.address) + pad(USDC) + fee.toString(16).padStart(64, '0'), _t: h.address, _v: 'v3' });
        poolCalls.push({ target: V2_FACTORY, data: '0xe6a43905' + pad(h.address) + pad(USDC), _t: h.address, _v: 'v2' });
      }
      const pr = await multicallChunked(poolCalls, 200);
      const poolOf = new Map(); // token -> {pool, v}
      poolCalls.forEach((c, i) => {
        if (poolOf.has(c._t)) return; const d = pr[i]; if (!d || !d.ok || d.data.length < 66) return;
        const p = ('0x' + d.data.slice(26, 66)).toLowerCase(); if (p !== ZERO) poolOf.set(c._t, { pool: p, v: c._v });
      });
      // 2) for each pool: USDC balance (depth), token0, and V3 slot0 / V2 reserves — one multicall.
      const ptoks = [...poolOf.entries()];
      const priceCalls = [];
      for (const [tok, { pool }] of ptoks) {
        priceCalls.push({ target: USDC, data: '0x70a08231' + pad(pool), _t: tok, _k: 'usdc' });
        priceCalls.push({ target: pool, data: '0x0dfe1681', _t: tok, _k: 't0' });        // token0()
        priceCalls.push({ target: pool, data: '0x3850c7bd', _t: tok, _k: 'slot0' });      // slot0() (V3)
        priceCalls.push({ target: tok, data: '0x70a08231' + pad(pool), _t: tok, _k: 'tokbal' }); // token balance in pool (V2 fallback)
      }
      const cr = await multicallChunked(priceCalls, 200);
      const grp = new Map();
      priceCalls.forEach((c, i) => { const g = grp.get(c._t) || {}; g[c._k] = cr[i]; grp.set(c._t, g); });
      for (const [tok, g] of grp) {
        const dec = (meta.get(tok)?.decimals) ?? unknown.find((u) => u.address === tok)?.on?.decimals ?? 18;
        const usdcBal = g.usdc?.ok && g.usdc.data.length >= 66 ? Number(BigInt(g.usdc.data.slice(0, 66))) / 1e6 : 0;
        const t0 = g.t0?.ok && g.t0.data.length >= 66 ? ('0x' + g.t0.data.slice(26, 66)).toLowerCase() : null;
        const usdcIsToken0 = t0 === USDC;
        let price = null;
        if (g.slot0?.ok && g.slot0.data.length >= 66) {
          const sqrtP = BigInt(g.slot0.data.slice(0, 66));
          if (sqrtP > 0n) { const ratio = (Number(sqrtP) / 2 ** 96) ** 2; const dexp = 10 ** (dec - 6); if (isFinite(ratio) && ratio > 0) price = (usdcIsToken0 ? 1 / ratio : ratio) * dexp; }
        }
        if (price == null && usdcBal > 0) { // V2: price = USDC reserve / token reserve
          const tokBal = g.tokbal?.ok && g.tokbal.data.length >= 66 ? Number(BigInt(g.tokbal.data.slice(0, 66))) / 10 ** dec : 0;
          if (tokBal > 0) price = usdcBal / tokBal;
        }
        if (price != null && isFinite(price) && price > 0) priceMap.set(tok, price);
      }
    }

    // Warp bonding-curve price for anything a V3/V2 USDC pool didn't cover — many nanocaps only trade on
    // the Warp curve. ⚠️ Warp reports price IGNORING token decimals, so correct by 10^(dec-18).
    const warpPrice = new Map();
    const stillUnpriced = held.filter((h) => h.address !== USDC && meta.get(h.address)?.price == null && !priceMap.has(h.address));
    await mapPool(stillUnpriced, async (h) => {
      try {
        const w = await fetch(`${origin}/api/warp/tokens/${h.address}`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
        const raw = w?.price ?? w?.data?.price;
        const n = Number(raw);
        if (raw != null && isFinite(n) && n > 0) {
          const dec = meta.get(h.address)?.decimals ?? h.on?.decimals ?? 18;
          warpPrice.set(h.address, n * Math.pow(10, dec - 18));
        }
      } catch { /* no warp price */ }
    }, 6);

    // Price sanity: no Arc token is worth >$1M/unit — anything above is a decimals / degenerate-pool
    // error (e.g. DUKE mispriced at 1e44 blew up the whole total). Reject it rather than show garbage.
    const PX_MAX = 1e6;
    const sane = (p) => (p != null && isFinite(p) && p > 0 && p < PX_MAX ? p : null);

    // Assemble holdings.
    const holdings = held.map((h) => {
      const m = meta.get(h.address);
      const decimals = h.native ? 6 : (m?.decimals ?? h.on?.decimals ?? 18);
      const amount = Number(h.raw) / 10 ** (h.native ? 18 : decimals); // native USDC is 18-dec on-chain
      let price = h.address === USDC ? 1 : (sane(m?.price) ?? sane(priceMap.get(h.address)) ?? sane(warpPrice.get(h.address)));
      let usd = price != null ? amount * price : null;
      if (usd != null && usd > 1e9) { price = null; usd = null; } // no single nanocap position is worth $1B
      return {
        address: h.address,
        symbol: h.native ? 'USDC' : (m?.symbol ?? h.on?.symbol ?? '?'),
        name: h.native ? 'USD Coin' : (m?.name ?? h.on?.name ?? m?.symbol ?? h.on?.symbol ?? ''),
        decimals, amount, price: price ?? null, usd,
        iconUrl: m?.iconUrl ?? null,
      };
    })
      .filter((h) => h.amount > 0)
      .filter((h) => !(h.usd == null && h.amount < 1e-6)); // drop unpriced 1e-18 airdrop dust
    holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    const total = holdings.reduce((s, h) => s + (h.usd ?? 0), 0);

    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=30, s-maxage=90, stale-while-revalidate=600');
    res.statusCode = 200;
    res.end(JSON.stringify({ address: addr, count: holdings.length, total, holdings, generatedAt: Date.now() }));
  } catch (e) {
    res.statusCode = 500; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'holdings failed: ' + (e?.message || String(e)) }));
  }
}
