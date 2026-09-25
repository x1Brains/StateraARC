#!/usr/bin/env node
/*
 * Token logo cache for the share cards (runs on the VPS, x1b-prod: /root/statera-logos, needs `sharp` there).
 *
 * ⛔ WHY (owner 09-25: "some token cards are loading too slow and don't show"): the X/Discord card (api/og.js) drew the
 * logo by fetching it live, with a 2.5s budget, from wherever the token points — and
 *   - 200 of the 330 listed tokens point at ipfs:// (GLITCH's is an 829KB PNG, 5.6s from the public gateway),
 *   - WebP logos (FAZE and every faze.fun coin) render BLANK in resvg,
 *   - Circle's own tokens (cirBTC, WETH, EURC) have no logo URL anywhere.
 * So a card for those tokens went out with no logo, every time.
 *
 * This job fetches each listed token's logo ONCE (generous timeouts, several IPFS gateways, on-chain imageURI/tokenURI,
 * Tolly Labs), converts it to a 192x192 PNG with sharp (WebP/SVG/GIF/AVIF all fine), and stores it at
 * /root/statera-live/logos/<address>.png. holdings-svc serves that folder (/holdings/logo/<address>, key-gated) and
 * api/og.js reads it from there first — a local file, milliseconds.
 *
 * Usage: node logo-cache.mjs [--all]      (default: only tokens with no cached file, or a failure older than 12h)
 *        node logo-cache.mjs 0xabc…       (one token — holdings-svc calls this on a cache miss)
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire('/root/statera-logos/');
const sharp = require('sharp');

const SNAP = '/root/statera-live/tokens-snapshot.json';
const DIR = '/root/statera-live/logos';
const FAILS = path.join(DIR, '_failed.json');
const SITE = 'https://www.stateraarc.com';
const RPC = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org', 'https://arc.gateway.tenderly.co'];
// Circle / Arc core tokens have no logo URL anywhere — use the site's own coin art (same assets the ticker uses).
const CORE = {
  '0x3600000000000000000000000000000000000000': '/coins/USDC.svg',
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': '/coins/BTC.png',   // cirBTC — Circle Wrapped Bitcoin
  '0x128cc466b61f542da60c70e3aa11c10e19b84edb': '/coins/ETH.png',   // WETH (canonical)
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': '/coins/EURC.svg',  // EURC
};
const GATEWAYS = ['https://gold-negative-silkworm-810.mypinata.cloud/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://w3s.link/ipfs/', 'https://dweb.link/ipfs/'];

fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readFails = () => { try { return JSON.parse(fs.readFileSync(FAILS, 'utf8')); } catch { return {}; } };

function candidates(raw) {
  if (!raw) return [];
  const u = String(raw).trim();
  if (u.startsWith('/')) return [SITE + u];
  const cid = u.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i)?.[1] || u.match(/\/ipfs\/(.+)$/i)?.[1];
  if (cid) return [...(u.startsWith('http') ? [u] : []), ...GATEWAYS.map((g) => g + cid)];
  if (u.startsWith('ar://')) return ['https://arweave.net/' + u.slice(5)];
  return /^https?:/i.test(u) ? [u] : [];
}
async function rpcCall(to, data) {
  for (const url of RPC) {
    try {
      const j = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(6000) }).then((r) => r.json());
      if (j?.result && j.result !== '0x') return j.result;
    } catch { /* next */ }
  }
  return null;
}
const abiStr = (h) => { try { if (!h || h.length < 130) return null; const len = parseInt(h.slice(66, 130), 16); return Buffer.from(h.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0/g, '') || null; } catch { return null; } };

/** Fetch one URL as an image buffer (rejects HTML/JSON/tiny bodies). */
async function getImage(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 StateraArc-logo-cache', accept: 'image/*,*/*' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 100 || ct.includes('html') || ct.includes('json') || ct.startsWith('text/plain')) return null;
    return b;
  } catch { return null; }
}
/** The token's logo as a 192x192 PNG, or null. Tries every source in order; the first image sharp can decode wins. */
async function logoFor(addr, iconUrl) {
  const a = addr.toLowerCase();
  const urls = [];
  if (CORE[a]) urls.push(...candidates(CORE[a]));
  urls.push(...candidates(iconUrl));
  const onchain = abiStr(await rpcCall(a, '0xfb7f21eb')); // imageURI() — launchpad tokens store their logo on-chain
  if (onchain && onchain !== iconUrl) urls.push(...candidates(onchain));
  urls.push(`https://api.tollylabs.com/token-image/${a}.png`);
  const turi = abiStr(await rpcCall(a, '0x3c130d90')); // tokenURI() → JSON metadata with an image field
  for (const u of [...new Set(urls)]) {
    const b = await getImage(u);
    if (!b) continue;
    try { return await sharp(b, { animated: false }).resize(192, 192, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer(); } catch { /* not an image sharp can read — next source */ }
  }
  if (turi) {
    for (const u of candidates(turi)) {
      try {
        const j = await fetch(u, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
        for (const iu of candidates(j?.image)) { const b = await getImage(iu); if (b) { try { return await sharp(b).resize(192, 192, { fit: 'cover' }).png().toBuffer(); } catch { /* next */ } } }
      } catch { /* next */ }
    }
  }
  return null;
}

async function one(addr, iconUrl, fails) {
  const a = addr.toLowerCase();
  const png = await logoFor(a, iconUrl);
  if (png) { fs.writeFileSync(path.join(DIR, a + '.png.tmp'), png); fs.renameSync(path.join(DIR, a + '.png.tmp'), path.join(DIR, a + '.png')); delete fails[a]; return true; }
  fails[a] = Date.now();
  return false;
}

const arg = process.argv[2];
const fails = readFails();
if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
  let icon = null;
  try { icon = JSON.parse(fs.readFileSync(SNAP, 'utf8')).tokens.find((t) => t.address.toLowerCase() === arg.toLowerCase())?.iconUrl ?? null; } catch { /* no snapshot */ }
  const ok = await one(arg, icon, fails);
  fs.writeFileSync(FAILS, JSON.stringify(fails));
  console.log(`[logo] ${arg} ${ok ? 'cached' : 'no logo found'}`);
} else {
  const all = arg === '--all';
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  // Every token the screener shows (>= 50 holders, or a Circle/Arc core asset) — the ones people share.
  const list = snap.tokens.filter((t) => t.isEcosystem || (t.holders ?? 0) >= 50 || CORE[t.address.toLowerCase()]);
  const todo = list.filter((t) => {
    const a = t.address.toLowerCase();
    if (all) return true;
    if (fs.existsSync(path.join(DIR, a + '.png'))) return false;
    return !fails[a] || Date.now() - fails[a] > 12 * 3600e3;
  });
  const t0 = Date.now(); let ok = 0, i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length) { const t = todo[i++]; if (await one(t.address, t.iconUrl, fails)) ok++; await sleep(100); }
  }));
  fs.writeFileSync(FAILS, JSON.stringify(fails));
  const have = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).length;
  console.log(`[logo] listed ${list.length}, tried ${todo.length}, cached ${ok}, failed ${todo.length - ok}; ${have} logos on disk; ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
