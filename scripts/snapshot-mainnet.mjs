#!/usr/bin/env node
/*
 * RICH mainnet (chain 5042) snapshot builder — the screener's source of truth.
 *
 * Runs on the VPS (which RadarDEX does NOT Cloudflare-block and which has solid RPC), bakes the COMPLETE
 * dataset into public/tokens-snapshot.json, and the browser just reads that one file — correct, complete
 * data every load, immune to the next third-party API block.
 *
 * ⛔⛔ ON-CHAIN IS THE SOURCE OF TRUTH (owner, 09-24: "we gotta read everything from on chain… the radar… is a
 * backup"). Merge order, by address — an EARLIER source's value is never overwritten by a later one:
 *   1. On-chain discovery (scripts/onchain-discover.mjs, V3+V4 pools straight from the chain) — price/liq/mcap/
 *      24h volume/change/spark for every token with a real USDC pool
 *   2. On-chain deep pools (the curated list below, incl. V2) — AUTHORITATIVE, overwrite 1 for their tokens
 *   3. Circle & Arc core tokens
 *   4. RadarDEX /tokens — BACKUP: only fills fields the chain left empty (holders, icons, socials, 5m/6h change,
 *      launchpad name) and adds tokens with no on-chain USDC pool found
 *   5. Warp /tokens — BACKUP, same rule (Warp bonding-curve tokens have no pool yet)
 * Every row carries `priceFrom`: 'chain' | 'radar' | 'warp', so the site can tell the two apart.
 * Usage: node scripts/snapshot-mainnet.mjs [maxTokens]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RADAR = process.env.RADAR_DIRECT || 'https://api.radardex.pro';
const WARP = 'https://warp-arc-production.up.railway.app/api';
const EXPLORER = 'https://explorer.arc.io/api/v2';
const RPCS = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org', 'https://arc.gateway.tenderly.co'];
const RPCS_BIG = ['https://arc.gateway.tenderly.co', 'https://rpc.blockdaemon.mainnet.arc.io']; // accept 95k-block getLogs
const MAX = Number(process.argv[2] || 500);
const NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
// Circle & Arc CORE — verified on-chain (docs.arc.io/arc/references/contract-addresses + arc-scan). Always
// present + flagged as ecosystem. ⛔ Decided by ADDRESS, never a name regex (a regex tagged "Chelsea USDC"
// and the third-party Animus suite as "core"). ARC is Circle's official 10B-supply token — no pool yet, so
// it carries no price/liq until it launches (the sniper watches for that); listed so it's the canonical ARC.
const ECO = [
  { address: NATIVE_USDC, name: 'USD Coin', symbol: 'USDC', iconUrl: '/coins/USDC.svg', price: 1, decimals: 6 },
  { address: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', name: 'Circle Wrapped Bitcoin', symbol: 'cirBTC', decimals: 8 },
  { address: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 },
  { address: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', name: 'EURC', symbol: 'EURC', decimals: 6 },
  { address: '0x8a5d989bbb96929f689b0200f435f53da42bf490', name: 'US Yield Coin', symbol: 'USYC', decimals: 6 },
  { address: '0xa12cd81d0f9988e3d60c4b6a0d52d368ef3c788d', name: 'Arc', symbol: 'ARC', decimals: 6 },
];
const ECO_ADDRS = new Set(ECO.map((e) => e.address.toLowerCase()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

// Deep V3 pools no indexer covers (token -> pool). Kept in sync with MAINNET_POOL in src/lib/arc.ts.
const POOLS = {
  '0xece5ca8bf9220718e5727754026757512212cb3c': { pool: '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02', name: 'Argus', symbol: 'ARGUS' },
  '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0': { pool: '0x0069cb6f70e2f848405f4483f232274c720ce6f9', name: 'Architects', symbol: 'Architects' },
  '0xbc43ce8dec648ea298c4275559b81d6261c90b67': { pool: '0x162df51c504e7b8321e07387932f333d9be16a72', name: 'Tolly', symbol: 'TOLLY' },
  '0x2164bb17a2d38c1b5170e987b2c0416df1efc752': { pool: '0xda9f3d166497ddfddf37c93cacfd8aa39b71e493', name: 'Long', symbol: 'LONG' },
  '0x07704b06981ea962b87296362a1281484d160000': { pool: '0xcf924acee7eb1f169a922bf19b0a732810971985', name: 'Arcat', symbol: 'ARCAT' },
  '0xeb64987643db71c76b2a2be7e723decc995e5b37': { pool: '0x40732e01ba7a829dea44f51a10e7c58cd9f37765', name: 'Cool', symbol: 'COOL' },
  '0x0bffa97f774824e9da843699aedd2835cb1b8022': { pool: '0x7dbcec05f12b14e21a79a0dc15ea9859322a4ab2', name: 'Arcash', symbol: 'ARCASH' },
  '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97': { pool: '0x482a249eb473b7de0ca8357b5496ccb7c55dfb72', name: 'Arcbat', symbol: 'ARCBAT' },
  '0xf3715bf5c2de299f08b81180ffb739a8372a175f': { pool: '0x6d8db35396b5eb98dee495e32b8cca992682316d', name: 'Arcanine', symbol: 'ARCANINE' },
  '0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b': { pool: '0x2e8180fa3967caf9abf57bbaeab9ae9063bcd7ba', name: 'CRCL', symbol: 'CRCL' },
  '0xd17014b731d33994e4e482c374ef375b68240087': { pool: '0x0f0333cf487a90ac7e56cba1541a1669e260cf22', name: 'MMM', symbol: 'MMM' },
};
const RADAR_LP = { argus: 'Argus', tolly: 'Tolly', long: 'Long', warp: 'Warp', dyor: 'DYOR', o1: 'O1' };
const ARCSCAN = 'https://api.arc-scan.org/v1'; // node CAN reach this (explorer.arc.io Cloudflare-blocks node fetch)
// Baked logos for the deep-pool tokens no aggregator covers (from CoinGecko via the explorer).
const ICON_MAP = {
  '0xece5ca8bf9220718e5727754026757512212cb3c': 'https://assets.coingecko.com/coins/images/102178392/small/argus-token.png?1789463380',
  '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0': 'https://assets.coingecko.com/coins/images/102178424/small/archi.jpg?1789536121',
  '0xbc43ce8dec648ea298c4275559b81d6261c90b67': 'https://assets.coingecko.com/coins/images/102178398/small/tolly.webp?1789479311',
  '0x2164bb17a2d38c1b5170e987b2c0416df1efc752': 'https://assets.coingecko.com/coins/images/102178399/small/long_400x400.jpg?1789480339',
  '0x0bffa97f774824e9da843699aedd2835cb1b8022': 'https://assets.coingecko.com/coins/images/102178425/small/arcash.jpg?1789536555',
  '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97': 'https://assets.coingecko.com/coins/images/102178427/small/arc_bat.jpg?1789537144',
  '0xf3715bf5c2de299f08b81180ffb739a8372a175f': 'https://assets.coingecko.com/coins/images/102178426/small/arcanine.jpg?1789536897',
};

async function getJson(url, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' } });
      const txt = await r.text();
      if (r.ok && txt && txt.trimStart()[0] !== '<') return JSON.parse(txt);
    } catch { /* retry */ }
    await sleep(300 * (a + 1));
  }
  return null;
}
let rpcI = 0;
async function rpc(method, params, tries = 4) {
  for (let a = 0; a < tries; a++) {
    const url = RPCS[(rpcI++) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j && j.result !== undefined && !j.error) return j.result;
    } catch { /* rotate */ }
    await sleep(200 * (a + 1));
  }
  return null;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const balOf = (token, who) => call(token, '0x70a08231000000000000000000000000' + who.slice(2).toLowerCase());
const hexToInt = (h) => { try { return BigInt(h); } catch { return 0n; } };

// getLogs over [from, to]: 95k-block ranges on the RPCs that allow them; a range that fails is re-read in 2.5k
// chunks on the normal RPCs. Logs come back in block order.
async function getLogsWide(filter, from, to) {
  const out = [];
  for (let f = from; f < to; f += 95000n) {
    const t = f + 95000n > to ? to : f + 95000n;
    let got = null;
    for (let a = 0; a < 4 && !got; a++) {
      try {
        const r = await fetch(RPCS_BIG[a % RPCS_BIG.length], { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ ...filter, fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }] }) }).then((x) => x.json());
        if (Array.isArray(r?.result)) got = r.result;
      } catch { /* next */ }
      if (!got) await sleep(300 * (a + 1));
    }
    if (!got) {
      got = [];
      for (let c = f; c < t; c += 2500n) {
        const ct = c + 2500n > t ? t : c + 2500n;
        const logs = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + c.toString(16), toBlock: '0x' + ct.toString(16) }]);
        if (Array.isArray(logs)) got.push(...logs);
      }
    }
    out.push(...got);
  }
  return out;
}

// 24h price series + volume for a deep V3 pool, straight from its Swap events.
async function poolActivity(token, pool) {
  const t0 = await call(pool, '0x0dfe1681'); // token0()
  const head = await rpc('eth_blockNumber', []);
  if (!t0 || !head) return null;
  const usdcIsT0 = ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC;
  const H = hexToInt(head);
  // estimate block time over 20k blocks to size a 24h window
  const [hb, ob] = await Promise.all([rpc('eth_getBlockByNumber', [head, false]), rpc('eth_getBlockByNumber', ['0x' + (H - 20000n).toString(16), false])]);
  const bt = (hb?.timestamp && ob?.timestamp) ? Math.max(0.1, (Number(hexToInt(hb.timestamp)) - Number(hexToInt(ob.timestamp))) / 20000) : 0.5;
  // ⛔⛔ This was capped at 60,000 blocks — at ~0.46s/block that is ~7.7 HOURS, not 24h, so every deep pool's
  // "24h" volume/change/spark was a third of a day (ARGUS $237K vs $727K real, 09-24). Now the full 24h
  // (same 400k safety cap as onchain-discover.mjs), read in wide ranges.
  const blocks24h = Math.min(400000, Math.round(86400 / bt));
  let vol = 0, txns = 0;
  const pts = []; // {b, price}
  {
    // Scan BOTH Uniswap-V3 and V2-style Swap events (ARCAT and other pools are V2, which the V3-only
    // scan silently missed → "$0 volume / no trades" on real, liquid tokens).
    const logs = await getLogsWide({ address: pool, topics: [[SWAP_V3, SWAP_V2]] }, H - BigInt(blocks24h), H);
    for (const l of logs) {
      try {
        const d = l.data.slice(2);
        const w = (i) => hexToInt('0x' + d.slice(i * 64, i * 64 + 64));
        const isV2 = (l.topics[0] || '').toLowerCase() === SWAP_V2;
        let usdcAbs, price = null;
        if (isV2) {
          // V2: amount0In/1In/0Out/1Out (unsigned). Price = execution price (no sqrtPrice available).
          const a0 = w(0) + w(2), a1 = w(1) + w(3);
          usdcAbs = usdcIsT0 ? a0 : a1; const tokAbs = usdcIsT0 ? a1 : a0;
          if (tokAbs > 0n) price = (Number(usdcAbs) / 1e6) / (Number(tokAbs) / 1e18);
        } else {
          // V3: volume from signed amounts; PRICE from sqrtPriceX96 (word 2) = accurate pool mid-price
          // (swap amounts include slippage → 2×+ off on thin pools like CRCL).
          const s0 = w(0) >= (1n << 255n) ? w(0) - (1n << 256n) : w(0);
          const s1 = w(1) >= (1n << 255n) ? w(1) - (1n << 256n) : w(1);
          const ur = usdcIsT0 ? s0 : s1; usdcAbs = ur < 0n ? -ur : ur;
          const sq = w(2);
          if (sq > 0n) { const ratio = (Number(sq) / 2 ** 96) ** 2; if (isFinite(ratio) && ratio > 0) price = (usdcIsT0 ? 1 / ratio : ratio) * 1e12; }
        }
        vol += Number(usdcAbs) / 1e6; txns++;
        if (price && isFinite(price) && price > 0) pts.push({ b: parseInt(l.blockNumber, 16), price });
      } catch { /* skip */ }
    }
  }
  pts.sort((x, y) => x.b - y.b);
  const last = pts.length ? pts[pts.length - 1].price : null;
  const change24h = pts.length >= 2 && pts[0].price > 0 ? ((last - pts[0].price) / pts[0].price) * 100 : null;
  // 1h change: price at the last swap on/before ~1h ago vs now
  let change1h = null;
  if (pts.length >= 2 && last) {
    const cutoff = Number(H) - Math.round(3600 / bt);
    let p1h = null; for (const p of pts) { if (p.b <= cutoff) p1h = p.price; else break; }
    if (p1h && p1h > 0) change1h = ((last - p1h) / p1h) * 100;
  }
  // downsample to ~24 sparkline points
  let spark = null;
  if (pts.length >= 2) { const step = Math.max(1, Math.floor(pts.length / 24)); spark = pts.filter((_, i) => i % step === 0).map((p) => p.price); if (spark.length < 2) spark = pts.map((p) => p.price); }
  return { volume24h: txns ? vol : null, txns24: txns || null, change24h, change1h, spark };
}

// Warp-curve tokens (WARP itself, un-migrated launches) have no Uniswap V3/V4 pool, so poolActivity can't
// spark them (WARP's tiny V4 pool had 4 swaps/24h → empty). The Warp API DOES serve OHLC candles, so build
// the sparkline + 1h/24h change + 24h volume from them. Returns null if the API has no usable history.
async function warpActivity(addr) {
  const c = await getJson(`${WARP}/tokens/${addr}/candles?interval=1h`).catch(() => null);
  if (!Array.isArray(c) || c.length < 2) return null;
  const rows = c.map((k) => ({ t: Number(k.time), close: Number(k.close), vol: Number(k.volume) || 0 }))
    .filter((r) => isFinite(r.t) && isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.t - b.t);
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1].close;
  const nowT = rows[rows.length - 1].t;
  const dayRows = rows.filter((r) => r.t >= nowT - 86400);
  const first24 = (dayRows[0] || rows[0]).close;
  const change24h = first24 > 0 ? ((last - first24) / first24) * 100 : null;
  const prev1h = rows[rows.length - 2].close;
  const change1h = prev1h > 0 ? ((last - prev1h) / prev1h) * 100 : null;
  const volume24h = dayRows.reduce((s, r) => s + r.vol, 0) || null;
  const tail = rows.slice(-24).map((r) => r.close); // last up-to-24 closes
  return { volume24h, change24h, change1h, spark: tail.length >= 2 ? tail : null };
}

// Token metadata (icon + holder count) for tokens no aggregator covers. Icon = baked CoinGecko map;
// holders from arc-scan REST (node can reach it; explorer.arc.io Cloudflare-blocks node fetch → 403).
async function metaFor(addr) {
  let holders = null, createdAt = null;
  const j = await getJson(`${ARCSCAN}/tokens/${addr}`);
  if (j) {
    holders = num(j.holders ?? j.token?.holders ?? j.holders_count);
    // Deploy time for the deep tokens no indexer dates: arc-scan gives the creation tx (block unset),
    // so resolve the tx's block timestamp on-chain (fixes AGE showing "—" for ARGUS/TOLLY/…).
    const tx = j.contract?.creation?.tx_hash;
    if (tx) {
      try {
        const t = await rpc('eth_getTransactionByHash', [tx]);
        if (t?.blockNumber) { const b = await rpc('eth_getBlockByNumber', [t.blockNumber, false]); if (b?.timestamp) createdAt = Number(BigInt(b.timestamp)) * 1000; }
      } catch { /* leave null */ }
    }
  }
  return { icon: ICON_MAP[addr.toLowerCase()] || null, holders, createdAt };
}

async function poolStats(token, pool) {
  const [uHex, bHex, supHex, slot0, t0] = await Promise.all([
    balOf(NATIVE_USDC, pool), balOf(token, pool), call(token, '0x18160ddd'),
    call(pool, '0x3850c7bd'), call(pool, '0x0dfe1681'), // slot0(), token0()
  ]);
  if (!uHex || uHex === '0x') return null;
  // ⛔⛔ 09-25: a FAILED token0() read defaulted to "USDC is not token0", which inverts a V3 price — ARC BAT (a healthy $17.9K
  // pool, real price $0.0001436) went out at $6.97e27 with a $1e36 "liquidity". No orientation, no price — never a guess.
  if (!t0 || t0 === '0x') return null;
  const usdc = Number(hexToInt(uHex)) / 1e6;
  const supply = supHex && supHex !== '0x' ? Number(hexToInt(supHex)) / 1e18 : null;
  const usdcIsT0 = ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC;
  let price = null;
  // Uniswap V3: price = slot0 sqrtPriceX96. ⛔ The reserve ratio (balance/balance) is NOT the price for
  // concentrated liquidity — it gave CRCL $36 when the real market price is $84 (matches the chart).
  if (slot0 && slot0 !== '0x' && slot0.length >= 66) {
    const sqrtP = hexToInt('0x' + slot0.slice(2, 66)); // first word = sqrtPriceX96
    if (sqrtP > 0n) { const ratio = (Number(sqrtP) / 2 ** 96) ** 2; if (isFinite(ratio) && ratio > 0) price = (usdcIsT0 ? 1 / ratio : ratio) * 1e12; }
  }
  // Uniswap V2 (no slot0): the reserve ratio IS the price.
  const toks = bHex && bHex !== '0x' ? Number(hexToInt(bHex)) / 1e18 : 0;
  if (price == null) { price = toks > 0 ? usdc / toks : null; }
  // TVL = both sides of the pool = USDC held + token held × price (usdc×2 assumed a balanced V2 pool and
  // understated V3 concentrated liquidity, e.g. CRCL $77k vs the real ~$129k).
  const liq = price != null ? usdc + toks * price : usdc * 2;
  return { price, liq, mcap: price != null && supply ? price * supply : null, usdcIsT0 };
}

(async () => {
  const map = new Map();
  const mk = (o) => ({ holders: null, iconUrl: null, launchpad: null, isOurs: false, isEcosystem: false,
    price: null, liq: null, mcap: null, fdv: null, volume24h: null, change5m: null, change1h: null, change6h: null,
    change24h: null, spark: null, txns24: null, source: null, createdAt: null, ...o, address: o.address.toLowerCase() });
  const chainPriced = new Set();
  const ocPriceOf = new Map(); // token -> the on-chain indexer's price (cross-check for the hand-picked deep pools)
  const set = (t) => { const k = t.address.toLowerCase(); const c = map.get(k);
    if (!c) { map.set(k, mk(t)); return; }
    for (const key of Object.keys(t)) { const v = t[key]; if (v == null) continue; if (c[key] == null) c[key] = v; }
    // 'onchain' is only a placeholder launchpad; an indexer's real launchpad NAME is metadata, not market data
    if (c.launchpad === 'onchain' && t.launchpad && t.launchpad !== 'onchain') c.launchpad = t.launchpad;
    c.isEcosystem = c.isEcosystem || t.isEcosystem; };

  // 1) ON-CHAIN discovery FIRST (V3 + V4, read straight from chain by scripts/onchain-discover.mjs) — every
  // token with a real USDC pool. This is the primary source; nothing later overwrites what it set.
  try {
    const ocFile = process.env.ONCHAIN_OUT || '/root/arc-indexer/onchain-tokens.json';
    if (fs.existsSync(ocFile)) {
      const oc = JSON.parse(fs.readFileSync(ocFile, 'utf8'));
      let added = 0;
      for (const t of (oc.tokens || [])) {
        const a = (t.address || '').toLowerCase(); if (!a) continue;
        if (t.price != null) ocPriceOf.set(a, t.price);
        if (map.has(a)) { const row = map.get(a); if (row.price == null && t.price != null) row.price = t.price; if (row.liq == null && t.liq != null) row.liq = t.liq; if (row.mcap == null && t.mcap != null) row.mcap = t.mcap; if (row.volume24h == null && t.volume24h != null) row.volume24h = t.volume24h; if (row.change24h == null && t.change24h != null) row.change24h = t.change24h; if (!row.iconUrl && t.iconUrl) row.iconUrl = t.iconUrl; if (row.holders == null && t.holders != null) row.holders = t.holders; if (!row.poolId && t.poolId) { row.poolId = t.poolId; row.usdcIsC0 = !!t.usdcIsC0; } if (row.decimals == null && t.decimals != null) row.decimals = t.decimals; if (!row.pool && t.pool) row.pool = t.pool; if (t.hooked) row.hooked = true; if (row.v4fee == null && t.v4fee != null) { row.v4fee = t.v4fee; row.v4tick = t.v4tick; row.hooks = t.hooks; } continue; }
        const row = mk({ address: a, name: t.name, symbol: t.symbol, price: t.price ?? null, liq: t.liq ?? null, mcap: t.mcap ?? null, launchpad: t.launchpad ?? null, source: t.source ?? 'onchain', iconUrl: t.iconUrl ?? null, holders: t.holders ?? null });
        row.volume24h = t.volume24h ?? null; row.change24h = t.change24h ?? null; row.change1h = t.change1h ?? null; row.createdAt = t.createdAt ?? null; if (Array.isArray(t.spark)) row.spark = t.spark;
        row.pool = t.pool ?? null; row.poolId = t.poolId ?? null; row.usdcIsC0 = !!t.usdcIsC0; row.decimals = t.decimals ?? 18; row.hooked = !!t.hooked;
        row.v4fee = t.v4fee ?? null; row.v4tick = t.v4tick ?? null; row.hooks = t.hooks ?? null; // V4 PoolKey → in-app swap routes it
        set(row); chainPriced.add(a);
        added++;
      }
      console.log(`[snap] on-chain discovery merged: +${added} new (of ${oc.tokens?.length || 0})`);
    } else { console.log('[snap] no on-chain discovery file yet'); }
  } catch (e) { console.log('[snap] on-chain merge skipped:', e.message); }

  // 4) RadarDEX — BACKUP only: fills what the chain left empty, adds tokens with no on-chain pool.
  console.log('[snap] RadarDEX…');
  const rd = await getJson(`${RADAR}/tokens?limit=${MAX}`);
  const rlist = rd?.tokens || rd || [];
  for (const t of rlist) {
    const address = (t.address || '').toLowerCase(); if (!address) continue;
    const lp = t.launchpad ? (RADAR_LP[t.launchpad] || (t.launchpad[0].toUpperCase() + t.launchpad.slice(1))) : null;
    set(mk({ address, name: t.name || t.symbol || '?', symbol: t.symbol || '?',
      holders: num(t.holderCount), iconUrl: t.icon || null, launchpad: lp,
      isEcosystem: ECO_ADDRS.has(address),
      price: num(t.price), liq: num(t.liquidityUsdc), mcap: num(t.mcap), fdv: num(t.fdv),
      volume24h: num(t.volume24 ?? t.volume24hFixed), change5m: num(t.change5m), change1h: num(t.change1h),
      change6h: num(t.change6h), change24h: num(t.change24h),
      source: t.topDex || (Array.isArray(t.versions) && t.versions.length ? t.versions[t.versions.length - 1].toUpperCase() : (t.topVersion ? String(t.topVersion).toUpperCase() : null)),
      txns24: num(t.txns24), spark: Array.isArray(t.spark) ? t.spark.filter((n) => typeof n === 'number' && isFinite(n)) : null,
      createdAt: num(t.deployTs ?? t.firstSeen) != null ? num(t.deployTs ?? t.firstSeen) * 1000 : null }));
  }
  console.log(`[snap] RadarDEX ${rlist.length} tokens`);

  // 5) Warp — BACKUP only, same rule.
  console.log('[snap] Warp…');
  const warp = await getJson(`${WARP}/tokens?sort=liquidity&limit=800`);
  for (const w of (Array.isArray(warp) ? warp : [])) {
    const address = (w.id || w.address || '').toLowerCase(); if (!address) continue;
    set(mk({ address, name: w.name || w.ticker || '?', symbol: w.ticker || w.symbol || '?',
      holders: num(w.holders), iconUrl: w.image || null, launchpad: w.migrated ? null : 'Warp',
      price: num(w.price), liq: num(w.liquidity), mcap: num(w.mcap),
      volume24h: num(w.volume24h), change24h: num(w.change24h), createdAt: num(w.createdAt) }));
  }

  // 2.5) Warp candle backfill — Warp-curve tokens with real liquidity but no sparkline (WARP itself, and any
  // un-migrated Warp launch the indexer can't spark). Bounded to the top by liquidity so the bake stays fast.
  const WARP_TOKEN = '0x384c60f98ecd4c26345499345c03d677e40f115e';
  const warpFill = [...map.values()]
    .filter((t) => (t.launchpad === 'Warp' || t.address === WARP_TOKEN) && (t.liq ?? 0) >= 5000 && (!t.spark || t.spark.length < 2))
    .sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0)).slice(0, 25);
  console.log(`[snap] Warp candle backfill: ${warpFill.length} tokens`);
  await Promise.all(warpFill.map(async (t) => {
    const act = await warpActivity(t.address);
    if (!act) return;
    if (act.spark) t.spark = act.spark;
    if (t.change24h == null && act.change24h != null) t.change24h = act.change24h;
    if (t.change1h == null && act.change1h != null) t.change1h = act.change1h;
    if (t.volume24h == null && act.volume24h != null) t.volume24h = act.volume24h;
    if (!t.source) t.source = 'Warp'; // so the row shows a source badge
  }));

  // 2) On-chain deep pools — AUTHORITATIVE for their tokens (overwrite step 1).
  console.log('[snap] on-chain deep pools…');
  for (const [token, meta] of Object.entries(POOLS)) {
    const [stats, act, ex] = await Promise.all([poolStats(token, meta.pool), poolActivity(token, meta.pool), metaFor(token)]);
    const cur = map.get(token) || {};
    set(mk({ address: token, name: cur.name || meta.name, symbol: cur.symbol || meta.symbol,
      iconUrl: ex?.icon ?? null, holders: ex?.holders ?? null, createdAt: ex?.createdAt ?? null, source: 'V3',
      price: stats?.price ?? null, liq: stats?.liq ?? null, mcap: stats?.mcap ?? null,
      volume24h: act?.volume24h ?? null, change1h: act?.change1h ?? null, change24h: act?.change24h ?? null, spark: act?.spark ?? null, txns24: act?.txns24 ?? null }));
    // deep-pool on-chain values are authoritative — overwrite radar/warp for price/liq/mcap/vol/change/spark
    const row = map.get(token);
    if (ex) { if (ex.icon && !row.iconUrl) row.iconUrl = ex.icon; if (ex.holders != null) row.holders = ex.holders; }
    // A hand-picked pool is authoritative only while it AGREES with the indexer's own read of the same token (within 20x)
    // and actually holds USDC — a dead or mis-read pool must never overwrite a good price.
    const ocPrice = ocPriceOf.get(token);
    if (stats && (stats.price == null || !isFinite(stats.price) || stats.price <= 0 || (ocPrice && (stats.price / ocPrice > 20 || ocPrice / stats.price > 20)))) {
      console.log(`  ${meta.symbol}: deep pool REJECTED (price ${stats?.price} vs indexer ${ocPrice}) — keeping the indexer's values`);
      continue;
    }
    if (stats && stats.price != null) chainPriced.add(token);
    // ⛔ 09-25 audit: this pool is ONE of the token's pools — its liquidity/volume may never REPLACE a bigger total the indexer
    // summed across all of them (ARGUS: this V3 pool ~$1.0M/24h, its V4 pool $2.09M — the site said $1.0M, chain $2.85M).
    const ocVol = row.volume24h, ocLiq = row.liq;
    if (stats) { if (stats.price != null) row.price = stats.price; if (stats.liq != null) row.liq = Math.max(stats.liq, ocLiq ?? 0); if (stats.mcap != null) row.mcap = stats.mcap; }
    // ⛔ The row's pool must be the pool its PRICE came from. The indexer may have tagged these tokens with a V4
    // poolId; the site's live re-price and the token page read poolId FIRST, so the price flipped between the V3
    // deep pool and that V4 pool every refresh (ARGUS 0.02409 vs 0.0234, 09-25). Point them at the V3 pool.
    if (stats && stats.price != null) { row.pool = meta.pool; row.poolId = null; row.usdcIsC0 = stats.usdcIsT0; row.decimals = 18; row.v4fee = null; row.v4tick = null; }
    if (act) { if (act.volume24h != null && act.volume24h >= (ocVol ?? 0)) { row.volume24h = act.volume24h; if (act.txns24 != null) row.txns24 = act.txns24; } if (act.change1h != null) row.change1h = act.change1h; if (act.change24h != null) row.change24h = act.change24h; if (act.spark) row.spark = act.spark; }
    console.log(`  ${meta.symbol}: price=${row.price} liq=${row.liq?.toFixed?.(0)} vol24=${row.volume24h?.toFixed?.(0)} chg24=${row.change24h?.toFixed?.(1)} holders=${row.holders} icon=${row.iconUrl ? 'yes' : 'no'} spark=${row.spark ? row.spark.length : 0}`);
  }

  // Logos: Circle's core tokens have no logo URL anywhere → the site's own coin art; any other token without one points at
  // the VPS logo cache (scripts/logo-cache.mjs, served via /api/logo/<addr>) when it holds a file. 09-25 audit: 100 of the
  // 290 shown tokens (cirBTC, EURC, CRCL, WETH…) had no logo url.
  const CORE_ICON = { '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': '/coins/BTC.png', '0x128cc466b61f542da60c70e3aa11c10e19b84edb': '/coins/ETH.png', '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': '/coins/EURC.svg' };
  const LOGO_DIR = '/root/statera-live/logos';
  for (const t of map.values()) {
    if (CORE_ICON[t.address]) t.iconUrl = CORE_ICON[t.address];
    else if (!t.iconUrl && fs.existsSync(path.join(LOGO_DIR, t.address + '.png'))) t.iconUrl = `/api/logo/${t.address}`;
  }

  // 3) Circle & Arc core (USDC, cirBTC, WETH, EURC, USYC, ARC) — always present + flagged as ecosystem.
  for (const e of ECO) {
    set(mk({ address: e.address, name: e.name, symbol: e.symbol, iconUrl: e.iconUrl ?? null, price: e.price ?? null, decimals: e.decimals ?? null, isEcosystem: true }));
    const row = map.get(e.address.toLowerCase()); if (row) { row.isEcosystem = true; if (e.iconUrl && !row.iconUrl) row.iconUrl = e.iconUrl; }
  }

  // ⛔ Drop true-DUST from the whole snapshot universe: a pool with a KNOWN liquidity under $100 AND under 50
  // holders is noise (a dead/rug micro-launch like ARCPAD — $0.26 liq, 3 holders). The indexer's $100 floor
  // only covers indexer-sourced tokens; RadarDEX-sourced dust bypassed it, so half the snapshot (≈1100/2263)
  // was sub-$100. Ecosystem tokens are always kept; unknown-liq (liq=null) tokens are kept (not proven dust);
  // a direct address lookup still renders the token page from on-chain, so nothing becomes unviewable.
  // ═══ HARD RULES (09-25) — same as the site's sanitizeToken (src/lib/arc.ts): no impossible number leaves this builder. ═══
  const PINNED = new Set([...ECO.map((e) => e.address), ...Object.keys(POOLS)].map((a) => a.toLowerCase()));
// Impersonator = claims to BE a Circle / major asset: that exact ticker, or a name that starts like the real one. (Was any
  // name containing circle/usdc — the 09-25 audit found it hid meme tokens that only MENTION Circle: "Circled" 2,076 holders,
  // "Circle Inu", "DogInCircle", "USDC Bull". Every fake from the owner's screenshots still matches this narrower rule.)
  const IMPOSTOR_SYM = /^(usdc|usdt|eurc|usyc|cirbtc|crcl|weth|wbtc|dai|usd)$/i;
  const IMPOSTOR_NAME = /^\s*(usd coin|circle internet|circle wrapped|euro coin|us yield coin|tether|wrapped ether|wrapped bitcoin)/i;
  let scrubbed = 0;
  for (const t of map.values()) {
    const pinned = PINNED.has(t.address) || t.isEcosystem; const before = JSON.stringify([t.price, t.liq, t.mcap, t.volume24h]);
    const fin = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    t.price = fin(t.price); t.liq = fin(t.liq); t.mcap = fin(t.mcap); t.volume24h = fin(t.volume24h);
    if (t.price != null && (t.price <= 0 || t.price >= 1e6)) { t.price = t.liq = t.mcap = t.volume24h = null; t.spark = null; t.bad = 'price'; }
    if (!pinned) {
      if (t.mcap != null && t.mcap > 5e8) { t.mcap = null; t.bad = t.bad || 'mcap'; }
      if (t.liq != null && t.liq > 5e7) { t.liq = null; t.bad = t.bad || 'liq'; }
      if (t.volume24h != null && t.volume24h > 5e7) { t.volume24h = null; t.bad = t.bad || 'vol'; }
      if (t.volume24h != null && t.liq > 0 && t.volume24h > t.liq * 20) t.volume24h = null; // wash
      if (IMPOSTOR_SYM.test((t.symbol || '').trim()) || IMPOSTOR_NAME.test(t.name || '')) t.bad = t.bad || 'impersonator';
    }
    if (Array.isArray(t.spark) && t.spark.some((x) => !isFinite(x) || x <= 0 || x >= 1e6)) t.spark = null;
    if (JSON.stringify([t.price, t.liq, t.mcap, t.volume24h]) !== before || t.bad) scrubbed++;
  }
  console.log(`[snap] hard rules: ${scrubbed} rows scrubbed/flagged`);
  const DUST_LIQ = 100, DUST_HOLDERS = 50;
  const all = [...map.values()];
  const radarSet = new Set(rlist.map((t) => (t.address || '').toLowerCase()));
  for (const t of all) t.priceFrom = t.price == null ? null : chainPriced.has(t.address) ? 'chain' : radarSet.has(t.address) ? 'radar' : 'warp';
  const tokens = all
    .filter((t) => t.isEcosystem || !(t.liq != null && t.liq < DUST_LIQ && (t.holders ?? 0) < DUST_HOLDERS))
    .sort((a, b) => (b.liq ?? -1) - (a.liq ?? -1));
  const file = path.join(__dirname, '..', 'public', 'tokens-snapshot.json');
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), count: tokens.length, tokens }));
  console.log(`[snap] price source: chain ${tokens.filter((t) => t.priceFrom === 'chain').length} · radar ${tokens.filter((t) => t.priceFrom === 'radar').length} · warp ${tokens.filter((t) => t.priceFrom === 'warp').length}`);
  console.log(`[snap] wrote ${tokens.length} tokens (dropped ${all.length - tokens.length} sub-$100/sub-50-holder dust), ${(fs.statSync(file).size / 1024).toFixed(0)}KB — ${tokens.filter((t) => t.volume24h != null).length} with volume, ${tokens.filter((t) => t.spark).length} with sparkline`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
