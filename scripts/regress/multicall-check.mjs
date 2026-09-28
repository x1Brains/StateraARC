// Gate for the indexer's Multicall3 bundling: the same reads done one-by-one and bundled must return IDENTICAL bytes.
// Mixed on purpose: slot0 (V3/CL pools), getReserves (V2), V4 extsload, balanceOf, totalSupply, decimals, symbol (dynamic
// string), native USDC via getEthBalance vs eth_getBalance, and a call that REVERTS (must come back '0x' both ways).
//   node scripts/regress/multicall-check.mjs <onchain-tokens.json>
import fs from 'node:fs';
import { encAggregate3, decAggregate3 } from '../lib/multicall.mjs';
const NODES = ['https://arc.drpc.org', 'https://rpc.blockdaemon.mainnet.arc.io'];
const MC = '0xca11bde05977b3631167028862be2a173976ca11', PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const pad = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
let k = 0;
async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    const j = await fetch(NODES[k++ % NODES.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()).catch(() => null);
    if (j && 'result' in j) return j.result;
    if (j?.error && /revert/i.test(j.error.message || '')) return 'REVERT';
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error('rpc failed: ' + method);
}
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).tokens.filter((t) => t.liq > 1000).slice(0, 25);
const calls = [], singles = [];
for (const t of rows) {
  if (t.pool) calls.push({ target: t.pool, data: t.source === 'V2' || t.source === 'WarpV2' || t.source === 'DyorSwap' ? '0x0902f1ac' : '0x3850c7bd' });
  calls.push({ target: t.address, data: '0x70a08231' + pad(PM) }, { target: t.address, data: '0x18160ddd' }, { target: t.address, data: '0x313ce567' }, { target: t.address, data: '0x95d89b41' });
  if (t.pool) calls.push({ target: MC, data: '0x4d2301cc' + pad(t.pool), _native: t.pool });
}
calls.push({ target: rows[0].address, data: '0xdeadbeef' }); // no such function → reverts
for (const c of calls) {
  let r = await rpc('eth_call', [{ to: c.target, data: c.data }, 'latest']);
  if (r === 'REVERT') r = '0x';
  singles.push(r); await new Promise((x) => setTimeout(x, 120));
}
const bundled = decAggregate3(await rpc('eth_call', [{ to: MC, data: encAggregate3(calls) }, 'latest']));
let diff = 0, native = 0;
for (let i = 0; i < calls.length; i++) {
  if (singles[i] !== bundled[i]) { diff++; if (diff <= 5) console.log('DIFF', calls[i].target, calls[i].data.slice(0, 10), singles[i]?.slice(0, 70), '|', bundled[i]?.slice(0, 70)); }
  if (calls[i]._native) { const b = await rpc('eth_getBalance', [calls[i]._native, 'latest']); if (BigInt(b) !== BigInt(bundled[i])) { native++; console.log('NATIVE DIFF', calls[i]._native, b, bundled[i]); } }
}
console.log(`${calls.length} calls: ${diff} byte differences (single vs bundled), ${native} getEthBalance≠eth_getBalance → ${diff || native ? 'FAIL' : 'PASS'}`);
process.exit(diff || native ? 1 : 0);
