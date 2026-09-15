// Enrich: resolve the top most-called contracts to full identity (name, tags, token).
import fs from 'fs';
const API = 'https://testnet.arcscan.app/api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let a = 0; a < 6; a++) {
    try { const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(1200 * (a + 1)); continue; }
      if (!r.ok) return null; return await r.json(); } catch { await sleep(600); }
  } return null;
}
const inc = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
(async () => {
  const toFreq = new Map(); const toName = new Map();
  let path = '/transactions?filter=validated', pages = 0;
  while (path && pages < 30) {
    const j = await get(path); if (!j || !j.items) break;
    for (const t of j.items) { const h = (t.to?.hash || '').toLowerCase(); inc(toFreq, h); if (t.to?.name) toName.set(h, t.to.name); }
    pages++; const np = j.next_page_params;
    path = np ? '/transactions?filter=validated&' + new URLSearchParams(np).toString() : null;
    await sleep(350);
  }
  const top = [...toFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
  console.log('=== TOP CONTRACTS — FULL IDENTITY ===');
  for (const [h, n] of top) {
    const a = await get(`/addresses/${h}`); await sleep(300);
    const nm = a?.name || toName.get(h) || null;
    const tags = (a?.public_tags || []).map(t => t.display_name || t.label).filter(Boolean).join(',');
    let tokenInfo = '';
    if (a?.token) tokenInfo = `TOKEN:${a.token.symbol || a.token.name}`;
    const impl = a?.implementations?.[0]?.name ? `impl:${a.implementations[0].name}` : '';
    console.log(`${String(n).padStart(4)}  ${h}  ${nm || '(unnamed)'} ${tokenInfo} ${tags ? '#'+tags : ''} ${impl}`);
  }
  console.log('[done]');
})().catch(e => console.error('FATAL', e.message));
