#!/usr/bin/env node
/*
 * RICH mainnet (chain 5042) snapshot builder — the screener's source of truth.
 *
 * Runs on the VPS (which RadarDEX does NOT Cloudflare-block and which has solid RPC), bakes the COMPLETE
 * dataset into public/tokens-snapshot.json, and the browser just reads that one file — correct, complete
 * data every load, immune to the next third-party API block. Sources, merged by address:
 *   1. RadarDEX /tokens (500)  — price, liq, mcap, holders, 1h/24h change, 24h volume, sparkline, txns, icon, launchpad, socials, deploy time
 *   2. Warp /tokens            — adds Warp-only tokens + images, fills gaps
 *   3. On-chain deep V3 pools  — Argus/Tolly/Long/Architects/… that NO indexer covers: price+liq+mcap from
 *                                reserves, 24h volume + 24h change + sparkline from the pool's Swap events
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
const MAX = Number(process.argv[2] || 500);
const NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
// USDC + the Animus ecosystem suite (biggest holder base on Arc) — always in the Ecosystem card.
const ECO = [
  { address: NATIVE_USDC, name: 'USD Coin', symbol: 'USDC', iconUrl: '/coins/USDC.svg', price: 1 },
  { address: '0xf5b08979251f398180385b54381ee3d6fa1bbe09', name: 'Animus USD', symbol: 'AUSD', price: 1 },
  { address: '0x8cd7e5a2240a1a7efaa9b164caa1dc80e9ed23a3', name: 'Animus EUR', symbol: 'AEUR', price: 1.08 },
  { address: '0x04adf55844be2f4c8d23e3f5f2386b08400b0cd1', name: 'Animus WXT', symbol: 'AWXT' },
  { address: '0x26d1ffbbb8b310b090ee0536748b4adfc88ae644', name: 'Animus Wirex Reward', symbol: 'AWORP' },
  { address: '0x7ce5e3fb080545c8912cf93297d93441911e9e4d', name: 'Animus BTC', symbol: 'ABTC' },
];
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
const ECOSYSTEM = /animus|ausd|aeur|awxt|aworp|abtc/i;

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
  const blocks24h = Math.min(60000, Math.round(86400 / bt)); // cap the scan
  const CH = 2500n;
  let vol = 0, txns = 0;
  const pts = []; // {b, price}
  for (let from = H - BigInt(blocks24h); from < H; from += CH) {
    const to = from + CH > H ? H : from + CH;
    // Scan BOTH Uniswap-V3 and V2-style Swap events (ARCAT and other pools are V2, which the V3-only
    // scan silently missed → "$0 volume / no trades" on real, liquid tokens).
    const logs = await rpc('eth_getLogs', [{ address: pool, topics: [[SWAP_V3, SWAP_V2]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      try {
        const d = l.data.slice(2);
        const w = (i) => hexToInt('0x' + d.slice(i * 64, i * 64 + 64));
        let usdcAbs, tokAbs;
        if ((l.topics[0] || '').toLowerCase() === SWAP_V2) {
          // V2: amount0In, amount1In, amount0Out, amount1Out (all unsigned)
          const a0 = w(0) + w(2), a1 = w(1) + w(3);
          usdcAbs = usdcIsT0 ? a0 : a1; tokAbs = usdcIsT0 ? a1 : a0;
        } else {
          // V3: amount0, amount1 (signed int256)
          const s0 = w(0) >= (1n << 255n) ? w(0) - (1n << 256n) : w(0);
          const s1 = w(1) >= (1n << 255n) ? w(1) - (1n << 256n) : w(1);
          const ur = usdcIsT0 ? s0 : s1, tr = usdcIsT0 ? s1 : s0;
          usdcAbs = ur < 0n ? -ur : ur; tokAbs = tr < 0n ? -tr : tr;
        }
        vol += Number(usdcAbs) / 1e6; txns++;
        if (tokAbs > 0n) pts.push({ b: parseInt(l.blockNumber, 16), price: (Number(usdcAbs) / 1e6) / (Number(tokAbs) / 1e18) });
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

// Token metadata (icon + holder count) for tokens no aggregator covers. Icon = baked CoinGecko map;
// holders from arc-scan REST (node can reach it; explorer.arc.io Cloudflare-blocks node fetch → 403).
async function metaFor(addr) {
  let holders = null;
  const j = await getJson(`${ARCSCAN}/tokens/${addr}`);
  if (j) holders = num(j.holders ?? j.token?.holders ?? j.holders_count);
  return { icon: ICON_MAP[addr.toLowerCase()] || null, holders };
}

async function poolStats(token, pool) {
  const [uHex, bHex, supHex] = await Promise.all([balOf(NATIVE_USDC, pool), balOf(token, pool), call(token, '0x18160ddd')]);
  if (!uHex || uHex === '0x') return null;
  const usdc = Number(hexToInt(uHex)) / 1e6;
  const toks = bHex && bHex !== '0x' ? Number(hexToInt(bHex)) / 1e18 : 0;
  const price = toks > 0 ? usdc / toks : null;
  const supply = supHex && supHex !== '0x' ? Number(hexToInt(supHex)) / 1e18 : null;
  return { price, liq: usdc * 2, mcap: price != null && supply ? price * supply : null };
}

(async () => {
  const map = new Map();
  const mk = (o) => ({ holders: null, iconUrl: null, launchpad: null, isOurs: false, isEcosystem: false,
    price: null, liq: null, mcap: null, volume24h: null, change1h: null, change24h: null, spark: null,
    txns24: null, createdAt: null, ...o, address: o.address.toLowerCase() });
  const set = (t) => { const k = t.address.toLowerCase(); const c = map.get(k);
    if (!c) { map.set(k, mk(t)); return; }
    for (const key of Object.keys(t)) { const v = t[key]; if (v == null) continue; if (c[key] == null) c[key] = v; }
    c.isEcosystem = c.isEcosystem || t.isEcosystem; };

  // 1) RadarDEX — the rich backbone (VPS reaches it fine).
  console.log('[snap] RadarDEX…');
  const rd = await getJson(`${RADAR}/tokens?limit=${MAX}`);
  const rlist = rd?.tokens || rd || [];
  for (const t of rlist) {
    const address = (t.address || '').toLowerCase(); if (!address) continue;
    const lp = t.launchpad ? (RADAR_LP[t.launchpad] || (t.launchpad[0].toUpperCase() + t.launchpad.slice(1))) : null;
    set(mk({ address, name: t.name || t.symbol || '?', symbol: t.symbol || '?',
      holders: num(t.holderCount), iconUrl: t.icon || null, launchpad: lp,
      isEcosystem: ECOSYSTEM.test(`${t.name} ${t.symbol}`),
      price: num(t.price), liq: num(t.liquidityUsdc), mcap: num(t.mcap),
      volume24h: num(t.volume24 ?? t.volume24hFixed), change1h: num(t.change1h), change24h: num(t.change24h),
      txns24: num(t.txns24), spark: Array.isArray(t.spark) ? t.spark.filter((n) => typeof n === 'number' && isFinite(n)) : null,
      createdAt: num(t.deployTs ?? t.firstSeen) != null ? num(t.deployTs ?? t.firstSeen) * 1000 : null }));
  }
  console.log(`[snap] RadarDEX ${rlist.length} tokens`);

  // 2) Warp — adds Warp-only tokens + images.
  console.log('[snap] Warp…');
  const warp = await getJson(`${WARP}/tokens?sort=liquidity&limit=800`);
  for (const w of (Array.isArray(warp) ? warp : [])) {
    const address = (w.id || w.address || '').toLowerCase(); if (!address) continue;
    set(mk({ address, name: w.name || w.ticker || '?', symbol: w.ticker || w.symbol || '?',
      holders: num(w.holders), iconUrl: w.image || null, launchpad: w.migrated ? null : 'Warp',
      price: num(w.price), liq: num(w.liquidity), mcap: num(w.mcap),
      volume24h: num(w.volume24h), change24h: num(w.change24h), createdAt: num(w.createdAt) }));
  }

  // 3) On-chain deep pools — the tokens no indexer covers get FULL activity data.
  console.log('[snap] on-chain deep pools…');
  for (const [token, meta] of Object.entries(POOLS)) {
    const [stats, act, ex] = await Promise.all([poolStats(token, meta.pool), poolActivity(token, meta.pool), metaFor(token)]);
    const cur = map.get(token) || {};
    set(mk({ address: token, name: cur.name || meta.name, symbol: cur.symbol || meta.symbol,
      iconUrl: ex?.icon ?? null, holders: ex?.holders ?? null,
      price: stats?.price ?? null, liq: stats?.liq ?? null, mcap: stats?.mcap ?? null,
      volume24h: act?.volume24h ?? null, change1h: act?.change1h ?? null, change24h: act?.change24h ?? null, spark: act?.spark ?? null, txns24: act?.txns24 ?? null }));
    // deep-pool on-chain values are authoritative — overwrite radar/warp for price/liq/mcap/vol/change/spark
    const row = map.get(token);
    if (ex) { if (ex.icon && !row.iconUrl) row.iconUrl = ex.icon; if (ex.holders != null) row.holders = ex.holders; }
    if (stats) { if (stats.price != null) row.price = stats.price; if (stats.liq != null) row.liq = stats.liq; if (stats.mcap != null) row.mcap = stats.mcap; }
    if (act) { if (act.volume24h != null) row.volume24h = act.volume24h; if (act.change1h != null) row.change1h = act.change1h; if (act.change24h != null) row.change24h = act.change24h; if (act.spark) row.spark = act.spark; if (act.txns24 != null) row.txns24 = act.txns24; }
    console.log(`  ${meta.symbol}: price=${row.price} liq=${row.liq?.toFixed?.(0)} vol24=${row.volume24h?.toFixed?.(0)} chg24=${row.change24h?.toFixed?.(1)} holders=${row.holders} icon=${row.iconUrl ? 'yes' : 'no'} spark=${row.spark ? row.spark.length : 0}`);
  }

  // 4) Ecosystem suite (USDC + Animus) — always present + flagged for the Ecosystem card.
  for (const e of ECO) {
    set(mk({ address: e.address, name: e.name, symbol: e.symbol, iconUrl: e.iconUrl ?? null, price: e.price ?? null, isEcosystem: true }));
    const row = map.get(e.address.toLowerCase()); if (row) { row.isEcosystem = true; if (e.iconUrl && !row.iconUrl) row.iconUrl = e.iconUrl; }
  }

  const tokens = [...map.values()].sort((a, b) => (b.liq ?? -1) - (a.liq ?? -1));
  const file = path.join(__dirname, '..', 'public', 'tokens-snapshot.json');
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), count: tokens.length, tokens }));
  console.log(`[snap] wrote ${tokens.length} tokens, ${(fs.statSync(file).size / 1024).toFixed(0)}KB — ${tokens.filter((t) => t.volume24h != null).length} with volume, ${tokens.filter((t) => t.spark).length} with sparkline`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
