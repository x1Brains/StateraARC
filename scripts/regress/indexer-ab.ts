// A/B for an indexer change: the old and new scripts/onchain-discover.mjs run from IDENTICAL state copies, then:
//  - no token the old output had may disappear (except ones the old run listed under the $100 liquidity floor edge);
//  - tokens in both: price / liquidity / volume must agree unless the change explains it (a new venue pool for that token);
//  - tokens only in the new output (new venues) must pass the site's HARD RULES (sanitizeToken): no junk reaches the page.
//   node scripts/regress/indexer-ab.ts <out-old.json> <out-new.json>
import fs from 'node:fs';
import { sanitizeToken, type Token } from '../../src/lib/rules.ts';
import { snapshotRow } from '../../src/lib/live.ts';

const [oldF, newF] = process.argv.slice(2);
const load = (f: string) => new Map<string, any>((JSON.parse(fs.readFileSync(f, 'utf8')).tokens as any[]).map((t) => [t.address.toLowerCase(), t]));
const A = load(oldF), B = load(newF);
const rel = (a: number | null, b: number | null) => (a == null || b == null ? (a == b ? 0 : Infinity) : a === 0 && b === 0 ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
const onlyOld = [...A.keys()].filter((k) => !B.has(k)), onlyNew = [...B.keys()].filter((k) => !A.has(k)), both = [...A.keys()].filter((k) => B.has(k));
const NEW_VENUES = new Set(['UniV2', 'Aero', 'Archery']);
const relabel = both.filter((k) => A.get(k).source !== B.get(k).source);
const priceMoves = both.filter((k) => rel(A.get(k).price, B.get(k).price) > 0.05);
const liqMoves = both.filter((k) => rel(A.get(k).liq, B.get(k).liq) > 0.05);
const volMoves = both.filter((k) => rel(A.get(k).volume24h, B.get(k).volume24h) > 0.10 && (A.get(k).volume24h ?? 0) + (B.get(k).volume24h ?? 0) > 1000);
const sum = (m: Map<string, any>, f: string, keys: string[]) => keys.reduce((s, k) => s + (m.get(k)[f] ?? 0), 0);

console.log(`old ${A.size} tokens · new ${B.size} tokens · in both ${both.length}`);
console.log(`only in OLD (dropped): ${onlyOld.length}`); for (const k of onlyOld.slice(0, 10)) { const t = A.get(k); console.log(`   ${t.symbol} ${k.slice(0, 10)} liq $${Math.round(t.liq)} src ${t.source}`); }
console.log(`only in NEW (added): ${onlyNew.length} — by source ${JSON.stringify(onlyNew.reduce((m: any, k) => { const s = B.get(k).source; m[s] = (m[s] || 0) + 1; return m; }, {}))}`);
const junk = onlyNew.map((k) => ({ k, t: sanitizeToken(snapshotRow(B.get(k)) as Token) })).filter((x) => (x.t as any).bad);
console.log(`   of the added: ${junk.length} flagged by the HARD RULES (hidden on the page): ${JSON.stringify(junk.reduce((m: any, x) => { const r = (x.t as any).bad; m[r] = (m[r] || 0) + 1; return m; }, {}))}`);
const top = onlyNew.map((k) => B.get(k)).sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0)).slice(0, 12);
for (const t of top) console.log(`   + ${t.symbol} (${t.source}) liq $${Math.round(t.liq ?? 0)} vol $${Math.round(t.volume24h ?? 0)} price ${t.price} holders ${t.holders}`);
console.log(`relabelled source: ${relabel.length} ${JSON.stringify(relabel.slice(0, 8).map((k) => `${A.get(k).symbol}:${A.get(k).source}->${B.get(k).source}`))}`);
const explain = (k: string) => NEW_VENUES.has(B.get(k).source) || relabel.includes(k);
for (const [name, list] of [['price >5%', priceMoves], ['liquidity >5%', liqMoves], ['volume >10%', volMoves]] as const) {
  const unexplained = list.filter((k) => !explain(k));
  console.log(`${name}: ${list.length} tokens moved (${list.length - unexplained.length} explained by a new venue/relabel)`);
  for (const k of unexplained.sort((a, b) => (B.get(b).liq ?? 0) - (B.get(a).liq ?? 0)).slice(0, 8)) { const a = A.get(k), b = B.get(k); console.log(`   ${a.symbol} ${k.slice(0, 10)} old ${name.startsWith('p') ? a.price : name.startsWith('l') ? Math.round(a.liq) : Math.round(a.volume24h ?? 0)} → new ${name.startsWith('p') ? b.price : name.startsWith('l') ? Math.round(b.liq) : Math.round(b.volume24h ?? 0)} (liq $${Math.round(b.liq)})`); }
}
console.log(`totals — liq: old $${(sum(A, 'liq', [...A.keys()]) / 1e6).toFixed(2)}M new $${(sum(B, 'liq', [...B.keys()]) / 1e6).toFixed(2)}M · 24h vol: old $${(sum(A, 'volume24h', [...A.keys()]) / 1e6).toFixed(2)}M new $${(sum(B, 'volume24h', [...B.keys()]) / 1e6).toFixed(2)}M`);
