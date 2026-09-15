// Arc testnet on-chain intelligence: busiest wallets, most-hit contracts, top methods,
// named/verified projects. Samples recent validated txs from Blockscout + cross-refs contracts.
import fs from 'fs';
const API = 'https://testnet.arcscan.app/api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(1200 * (a + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(600); }
  }
  return null;
}
const short = (a) => a ? a.slice(0, 8) + '…' + a.slice(-4) : '?';
const inc = (m, k, n = 1) => { if (!k) return; m.set(k, (m.get(k) || 0) + n); };
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

(async () => {
  const stats = await get('/stats');
  console.log('=== CHAIN STATS ===');
  if (stats) console.log(`addresses ${Number(stats.total_addresses).toLocaleString()} | txs ${Number(stats.total_transactions).toLocaleString()} | today ${Number(stats.transactions_today).toLocaleString()} | blocks ${Number(stats.total_blocks).toLocaleString()} | blockTime ${stats.average_block_time}ms`);

  // 1) sample recent validated txs
  const toFreq = new Map(), fromFreq = new Map(), methodFreq = new Map(), toName = new Map();
  let path = '/transactions?filter=validated', pages = 0, txs = 0;
  const PAGES = 40;
  while (path && pages < PAGES) {
    const j = await get(path);
    if (!j || !j.items) break;
    for (const t of j.items) {
      txs++;
      const toH = (t.to?.hash || '').toLowerCase();
      const frH = (t.from?.hash || '').toLowerCase();
      inc(toFreq, toH); inc(fromFreq, frH);
      if (t.to?.name) toName.set(toH, t.to.name);
      if (t.to?.is_contract && !toName.has(toH) && t.to?.metadata?.tags?.[0]?.name) toName.set(toH, t.to.metadata.tags[0].name);
      const m = t.method || (t.raw_input && t.raw_input.length >= 10 ? t.raw_input.slice(0, 10) : null);
      inc(methodFreq, m);
    }
    pages++;
    const np = j.next_page_params;
    path = np ? '/transactions?filter=validated&' + new URLSearchParams(np).toString() : null;
    await sleep(350);
  }
  console.log(`\n[sampled ${txs} recent txs over ${pages} pages]`);

  // 2) verified/named contracts (what's built)
  const contractName = new Map();
  let cpath = '/smart-contracts?', cpages = 0;
  const named = [];
  while (cpath && cpages < 10) {
    const j = await get(cpath);
    if (!j || !j.items) break;
    for (const c of j.items) {
      const h = (c.address?.hash || '').toLowerCase();
      const nm = c.address?.name || null;
      if (nm) { contractName.set(h, nm); named.push({ h, nm, lang: c.language, verified: c.address?.is_verified }); }
    }
    cpages++;
    const np = j.next_page_params;
    cpath = np ? '/smart-contracts?' + new URLSearchParams(np).toString() : null;
    await sleep(350);
  }

  const nameFor = (h) => toName.get(h) || contractName.get(h) || null;

  console.log('\n=== TOP 20 MOST-CALLED CONTRACTS (hottest apps) ===');
  for (const [h, n] of top(toFreq, 20)) console.log(`${String(n).padStart(4)}  ${short(h)}  ${nameFor(h) || ''}`);

  console.log('\n=== TOP 20 BUSIEST WALLETS (senders) ===');
  for (const [h, n] of top(fromFreq, 20)) console.log(`${String(n).padStart(4)}  ${short(h)}  ${nameFor(h) ? '['+nameFor(h)+']' : ''}`);

  console.log('\n=== TOP METHODS / SELECTORS (what actions dominate) ===');
  for (const [m, n] of top(methodFreq, 20)) console.log(`${String(n).padStart(4)}  ${m}`);

  console.log(`\n=== NAMED / VERIFIED CONTRACTS (${named.length} found, sample) ===`);
  for (const c of named.slice(0, 40)) console.log(`  ${short(c.h)}  ${c.nm}${c.verified ? ' ✓' : ''}`);

  // 3) cross-ref token snapshot launchpad clusters
  try {
    const snap = JSON.parse(fs.readFileSync(new URL('../public/tokens-snapshot.json', import.meta.url)));
    const lp = {};
    for (const t of snap.tokens) if (t.launchpad) lp[t.launchpad] = (lp[t.launchpad] || 0) + 1;
    console.log('\n=== TOKEN LAUNCHPADS (from our snapshot) ===');
    for (const [k, v] of Object.entries(lp).sort((a, b) => b[1] - a[1])) console.log(`  ${v} tokens  ${k}`);
  } catch {}
  console.log('\n[intel done]');
})().catch((e) => console.error('FATAL', e.message));
