// POOLS GAP (09-30): for every listed token with $1K+ liquidity, the token page's pools card total (detail ocPools) vs the
// screener row's liquidity. A card far below the row = a pool the page is missing (ARGUS showed V3 $615K of $1.26M).
//   node scripts/regress/pools-gap.mjs [https://www.stateraarc.com]
const BASE = process.argv[2] || 'https://www.stateraarc.com';
const rows = ((await (await fetch(`${BASE}/api/v2/board?per=500&page=1`)).json()).rows || []).filter((r) => (r.liq || 0) >= 1000);
console.log(`${rows.length} tokens with $1K+ liquidity`);
const bad = [];
for (let i = 0; i < rows.length; i += 4) await Promise.all(rows.slice(i, i + 4).map(async (r) => {
  try {
    const d = await (await fetch(`${BASE}/api/v2/token/${r.address}/detail`, { signal: AbortSignal.timeout(60000) })).json();
    const ps = d.ocPools || [];
    const sum = ps.reduce((s, p) => s + (p.liquidityUsdc || 0), 0);
    const ratio = r.liq ? sum / r.liq : 0;
    if (ratio < 0.8) bad.push({ sym: r.symbol, addr: r.address, liq: Math.round(r.liq), card: Math.round(sum), pools: ps.map((p) => p.version).join('+') || 'none', v4: !!(r.v4PoolId || r.poolId) });
  } catch (e) { bad.push({ sym: r.symbol, addr: r.address, liq: Math.round(r.liq), err: String(e).slice(0, 60) }); }
}));
console.log(`card < 80% of row liquidity: ${bad.length}`);
for (const b of bad.sort((a, c) => c.liq - a.liq)) console.log(`  ${String(b.sym).padEnd(12)} ${b.addr} row $${b.liq} card $${b.card ?? '-'} ${b.pools ?? ''} v4=${b.v4 ?? ''} ${b.err ?? ''}`);
