#!/usr/bin/env node
/*
 * Price + liquidity enrichment for the StateraArc snapshot — DEX-agnostic.
 *
 * A token's pool is a contract that holds BOTH the token and a stablecoin. It shows up as one
 * of the token's top holders. So for each token we: fetch top holders (Blockscout), find the
 * holder that also holds USDC/WUSDC/EURC (via Arc RPC eth_call — NOT rate-limited like the
 * Blockscout API), then price = quoteReserve / tokenReserve and TVL ≈ 2× the quote side.
 *
 * Reads public/tokens-snapshot.json, adds { price, liq } to the top N tokens, writes it back.
 * Usage: PRICE_MAX=200 node scripts/prices.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCAN = process.env.ARC_SCAN || 'https://testnet.arcscan.app/api/v2';
const RPC = process.env.ARC_RPC || 'https://rpc.testnet.arc.io';
const MAX = Number(process.env.PRICE_MAX || 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quote stablecoins. Decimals are read from chain at startup (WUSDC is 18, not 6 — that
// mismatch produced astronomical garbage prices). USD peg approximate for EURC.
const QUOTES = [
  { addr: '0x3600000000000000000000000000000000000000', dec: 6, usd: 1, sym: 'USDC' },
  { addr: '0x911b4000d3422f482f4062a913885f7b035382df', dec: 18, usd: 1, sym: 'WUSDC' },
  { addr: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', dec: 6, usd: 1.08, sym: 'EURC' },
];
const addrOf = (o) => (o && (o.hash || o.address_hash || o.address)) || (typeof o === 'string' ? o : '');

// Known stablecoins price at their peg — pool-ratio discovery is unreliable for them.
const STABLES = {
  '0x3600000000000000000000000000000000000000': 1,     // USDC
  '0x911b4000d3422f482f4062a913885f7b035382df': 1,     // WUSDC
  '0x175cdb1d338945f0d851a741ccf787d343e57952': 1,     // USDT
  '0x2d84d79c852f6842abe0304b70bbaa1506add457': 1,     // USDC/EURC
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': 1.08,  // EURC
};
const PRICE_CEIL = 1e5; // no test token is credibly worth >$100k each — reject as a bad match

async function scan(pathq) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${SCAN}${pathq}`, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await sleep(1000 * (a + 1)); continue; }
    if (!r.ok) throw new Error('scan HTTP ' + r.status);
    return r.json();
  }
  throw new Error('scan 429');
}
async function ethCall(to, data) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  const j = await r.json();
  return j.result && j.result !== '0x' ? j.result : null;
}
const balanceOf = (token, holder) => ethCall(token, '0x70a08231000000000000000000000000' + holder.slice(2));
async function decimals(token) { const r = await ethCall(token, '0x313ce567'); return r ? parseInt(r, 16) : 18; }
const isContract = async (a) => { const c = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [a, 'latest'] }) }).then((r) => r.json()); return c.result && c.result !== '0x'; };

async function priceOf(token, tokenDec) {
  let holders;
  try { holders = await scan(`/tokens/${token}/holders`); } catch { return null; }
  const top = (holders.items || []).slice(0, 6);
  let best = null;
  for (const h of top) {
    const holder = addrOf(h.address).toLowerCase();
    const tokBal = Number(h.value || 0) / 10 ** tokenDec;
    if (!holder || tokBal <= 0) continue;
    for (const q of QUOTES) {
      const raw = await balanceOf(q.addr, holder);
      if (!raw) continue;
      const quoteHuman = Number(BigInt(raw)) / 10 ** q.dec;
      if (quoteHuman < 0.5) continue;                 // ignore dust balances
      const usd = quoteHuman * q.usd;
      const price = usd / tokBal;
      const liq = usd * 2;
      if (!(price > 0) || price > PRICE_CEIL) continue; // sanity backstop against garbage
      if (!best || liq > best.liq) best = { price, liq, quote: q.sym };
    }
  }
  return best;
}

(async () => {
  // Read quote decimals from chain (WUSDC is 18, not 6).
  for (const q of QUOTES) { try { q.dec = await decimals(q.addr); } catch {} }
  console.log('[prices] quotes:', QUOTES.map((q) => `${q.sym}=${q.dec}d`).join(' '));

  const file = path.join(__dirname, '..', 'public', 'tokens-snapshot.json');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tokens = snap.tokens;
  console.log(`[prices] enriching top ${Math.min(MAX, tokens.length)} of ${tokens.length}…`);
  let priced = 0;
  for (let i = 0; i < Math.min(MAX, tokens.length); i++) {
    const t = tokens[i];
    t.price = null; t.liq = null; t.quote = null; // clear any prior value so stale garbage can't survive
    try {
      const peg = STABLES[t.address.toLowerCase()];
      if (peg != null) {
        // Stablecoin: price at peg, still discover liquidity for the tile.
        const dec = await decimals(t.address);
        const p = await priceOf(t.address, dec);
        t.price = peg; t.liq = p ? p.liq : null; t.quote = 'peg'; priced++;
      } else {
        const dec = await decimals(t.address);
        const p = await priceOf(t.address, dec);
        if (p) { t.price = p.price; t.liq = p.liq; t.quote = p.quote; priced++; }
      }
    } catch { /* skip */ }
    if (i % 15 === 0) {
      fs.writeFileSync(file, JSON.stringify({ ...snap, pricedAt: new Date().toISOString(), tokens }));
      process.stdout.write(`\r[prices] ${i}/${MAX} — ${priced} priced`);
    }
    await sleep(120);
  }
  fs.writeFileSync(file, JSON.stringify({ ...snap, pricedAt: new Date().toISOString(), tokens }));
  console.log(`\n[prices] done — ${priced} tokens priced`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
