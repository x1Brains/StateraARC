// Multicall3.aggregate3 ABI encode/decode — shared by the indexer (scripts/onchain-discover.mjs) and its correctness check
// (scripts/regress/multicall-check.mjs), so the check tests the exact code the indexer runs.
const pad = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
export function encAggregate3(calls) {
  const parts = calls.map((c) => {
    const d = (c.data || '0x').replace(/^0x/, ''), len = d.length / 2;
    return pad(c.target) + w32(1) + w32(96) + w32(len) + d.padEnd(Math.ceil(len / 32) * 64, '0');
  });
  let cur = calls.length * 32; const offs = parts.map((p) => { const o = w32(cur); cur += p.length / 2; return o; });
  return '0x82ad56cb' + w32(32) + w32(calls.length) + offs.join('') + parts.join('');
}
export function decAggregate3(hex) {
  const h = (hex || '').replace(/^0x/, ''), W = (at) => parseInt(h.slice(at, at + 64), 16);
  const arr = W(0) * 2, n = W(arr), el = arr + 64, out = [];
  for (let i = 0; i < n; i++) {
    const tup = el + W(el + i * 64) * 2, ok = W(tup) === 1, dat = tup + W(tup + 64) * 2, len = W(dat);
    out.push(ok ? '0x' + h.slice(dat + 64, dat + 64 + len * 2) : '0x');
  }
  return out;
}
