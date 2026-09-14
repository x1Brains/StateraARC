#!/usr/bin/env node
/*
 * Pre-bake a token snapshot for StateraArc so the app loads the whole screener from ONE small
 * file instead of hammering Blockscout's rate-limited public API from every browser.
 *
 * Fetches all ERC-20 tokens (paginated, with 429 backoff), computes the launchpad flag once
 * (per-token deployer), tags ecosystem + ours, and writes public/tokens-snapshot.json.
 *
 * Run it locally or on a cron; the client just fetches the JSON. Usage: node scripts/snapshot.js [maxTokens]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = process.env.ARC_SCAN || 'https://testnet.arcscan.app/api/v2';
const MAX = Number(process.argv[2] || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCHPADS = {
  '0x95d262c8ab207a54c08569887177fa301e7f9687': 'Memepad',
  '0x34a0b64a88bbd4bf6acba8a0ff8f27c8add67e9c': 'LP factory',
  '0x1594f838177784f4fcba8f4082d3ca53aeb2672b': 'Launcher',
  '0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad': 'Curve factory',
};
const OURS = new Set(['0xc8e1ffc83da48b347dd89a42a19fd510723f16bb']); // BRAINS
const ECOSYSTEM = /xylo|swaparc|synthra|arcflow|curve|cir|usyc|eurc|usdc|usdt/i;
const addrOf = (o) => (o && (o.hash || o.address_hash || o.address)) || (typeof o === 'string' ? o : '');

async function req(url) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(1000 * (a + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    } catch (e) { if (a >= 5) throw e; await sleep(500 * (a + 1)); }
  }
}

(async () => {
  console.log('[snapshot] fetching ERC-20 tokens…');
  const tokens = [];
  let params = new URLSearchParams({ type: 'ERC-20' });
  while (tokens.length < MAX) {
    const j = await req(`${API}/tokens?${params.toString()}`);
    for (const t of j.items || []) {
      const address = addrOf(t.address ?? t).toLowerCase();
      if (!address) continue;
      tokens.push({
        address,
        name: t.name || '(unnamed)',
        symbol: t.symbol || '?',
        holders: t.holders != null ? Number(t.holders) : null,
        iconUrl: t.icon_url || null,
        launchpad: null,
        isOurs: OURS.has(address),
        isEcosystem: ECOSYSTEM.test(`${t.name} ${t.symbol}`),
      });
    }
    if (!j.next_page_params || tokens.length >= MAX) break;
    params = new URLSearchParams({ type: 'ERC-20', ...j.next_page_params });
    await sleep(140);
  }
  // Launchpad flags need one deployer lookup per token — expensive and rate-limit-prone.
  // OFF by default (list-only snapshot is fast). Run with ENRICH=1 for a slow, full pass.
  let flagged = 0;
  if (process.env.ENRICH) {
    console.log(`[snapshot] ${tokens.length} tokens. Computing launchpad flags (ENRICH)…`);
    for (let i = 0; i < tokens.length; i++) {
      try {
        const a = await req(`${API}/addresses/${tokens[i].address}`);
        const creator = addrOf(a.creator_address_hash).toLowerCase();
        if (LAUNCHPADS[creator]) { tokens[i].launchpad = LAUNCHPADS[creator]; flagged++; }
      } catch { /* skip */ }
      if (i % 25 === 0) process.stdout.write(`\r[snapshot] enriched ${i}/${tokens.length} (${flagged} launchpad)`);
      await sleep(250);
    }
    process.stdout.write('\n');
  }

  tokens.sort((a, b) => (b.holders ?? -1) - (a.holders ?? -1));
  const out = { generatedAt: new Date().toISOString(), count: tokens.length, launchpad: flagged, tokens };
  const file = path.join(__dirname, '..', 'public', 'tokens-snapshot.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`[snapshot] wrote ${file} — ${tokens.length} tokens, ${flagged} launchpad, ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
