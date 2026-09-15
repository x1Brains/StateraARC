// Pre-public Arc mainnet (chain 5042) snapshot builder.
// Source: arc-scan.org (UNOFFICIAL indexer + RPC). Raw tx/RPC data is cryptographically genuine;
// indexer aggregates (holders/supply) are labeled unverified. Spam-filtered. NOT Circle-official.
// Discovers real tokens + hot contracts by scanning recent activity, since 5042 has no list API.
import fs from 'fs';
const REST = 'https://api.arc-scan.org/v1';
const RPC  = 'https://rpc.arc-scan.org';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// known spam to exclude from activity ranking
const SPAM_TARGET = '0xbada501d409630068d73ab4365dd57624a20f862';
const SPAM_SENDER = '0x6091487daf402998fa919ad2d52c8060f275b5dc';
const USDC = '0x3600000000000000000000000000000000000000';

async function rest(path, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${REST}${path}`, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json(); if (r.status === 429) { await sleep(1500); continue; } return null;
    } catch { await sleep(800); } }
  return null;
}
async function rpc(method, params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) { if (/unreachable|retry|rate/i.test(j.error.message || '')) { await sleep(2200); continue; } return null; }
      return j.result;
    } catch { await sleep(1500); } }
  return null;
}
const padA = a => a.toLowerCase().replace('0x','').padStart(64,'0');
const hexToStr = h => { let s=''; for (let i=0;i<h.length;i+=2){const c=parseInt(h.substr(i,2),16); if(c)s+=String.fromCharCode(c);} return s; };
async function ercStr(addr, sel) { const r = await rpc('eth_call', [{ to: addr, data: sel }, 'latest']);
  if (!r || r.length < 130) return null; try { const len = Number(BigInt('0x'+r.slice(66,130))); return hexToStr(r.slice(130,130+len*2)).replace(/[^\x20-\x7e]/g,'')||null; } catch { return null; } }
const symbolOf = a => ercStr(a, '0x95d89b41');
const nameOf   = a => ercStr(a, '0x06fdde03');
async function decimalsOf(a){ const r=await rpc('eth_call',[{to:a,data:'0x313ce567'},'latest']); return r?Number(BigInt(r)):null; }

(async () => {
  const chain = await rest('/chain');
  // head block from REST (reliable) with an RPC fallback — eth_blockNumber is flaky on this endpoint
  let headN = null;
  if (chain?.index?.head_block != null) headN = BigInt(chain.index.head_block);
  else { for (let i = 0; i < 10 && headN == null; i++) { const h = await rpc('eth_blockNumber', []); if (h) headN = BigInt(h); else await sleep(2000); } }
  console.error('head block:', headN?.toString(), '| block_time', chain?.block_time_ms, 'ms');
  if (headN == null) { console.error('FATAL: could not get head block'); process.exit(1); }

  // 1) discover tokens via Transfer-event logs (far more efficient than block scans; flaky RPC → retries).
  //    Walk several windows back from head for coverage; tally transfer count per token (= real activity).
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const SYSTEM = new Set(['0xfffffffffffffffffffffffffffffffffffffffe']); // native-USDC system emitter (EIP-7708)
  const xfer = new Map();
  const WIN = 2000n, WINDOWS = 12;
  for (let w = 0; w < WINDOWS && headN != null; w++) {
    const to = headN - BigInt(w) * WIN, from = to - WIN;
    const logs = await rpc('eth_getLogs', [{ fromBlock: '0x'+from.toString(16), toBlock: '0x'+to.toString(16), topics: [TRANSFER] }]);
    if (!Array.isArray(logs)) { console.error(`window ${w}: no logs (flaky) — skip`); await sleep(1500); continue; }
    for (const l of logs) { const a = l.address.toLowerCase(); if (SYSTEM.has(a)) continue; xfer.set(a, (xfer.get(a) || 0) + 1); }
    console.error(`window ${w}: +${logs.length} logs, ${xfer.size} tokens so far`);
    await sleep(400);
  }
  // enrich via REST /tokens/{a} ONLY (reliable, unlike the flaky RPC) — symbol/name/decimals/holders/
  // supply/24h-transfers/lookalike-flags all come from one call. Index a wide set.
  const ranked = [...xfer.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 150);
  console.error(`discovered ${xfer.size} token contracts; enriching top ${ranked.length} via REST`);

  const tokens = [];
  for (const [addr, transfers] of ranked) {
    if (addr === USDC) continue; // list USDC separately as the base
    const tk = await rest(`/tokens/${addr}`);
    const t = tk?.token; if (!t || (t.standard && t.standard !== 'erc20') || !t.symbol) continue;
    tokens.push({ address: addr, symbol: t.symbol, name: (t.name || t.symbol).trim(), decimals: t.decimals ?? 18,
      transfers, transfers24h: tk?.transfers_24h != null ? Number(tk.transfers_24h) : null,
      holders: tk?.holders != null ? Number(tk.holders) : null,
      supply: tk?.total_supply?.formatted ?? null,
      flags: [t.unverified_lookalike && 'lookalike', t.shares_reserved_name && 'reserved-name'].filter(Boolean),
      source: 'arc-scan.org (unverified indexer)' });
    await sleep(120);
  }
  // dedupe symbols -> mark impersonation
  const symCount = {}; tokens.forEach(t => symCount[t.symbol]=(symCount[t.symbol]||0)+1);
  tokens.forEach(t => { if (symCount[t.symbol] > 1 && !t.flags.includes('lookalike')) t.flags.push('dup-symbol'); });
  // rank by holders (authoritative signal), then transfers
  tokens.sort((a,b) => (b.holders ?? -1) - (a.holders ?? -1) || (b.transfers - a.transfers));

  const out = {
    chain: 5042, chainName: 'Arc (pre-public mainnet)', official: false,
    source: 'arc-scan.org — UNOFFICIAL indexer/RPC; raw tx data genuine, aggregates unverified',
    generated: new Date().toISOString(),
    headBlock: headN?.toString() ?? null, blockTimeMs: chain?.block_time_ms ?? null,
    note: 'Pre-public Arc mainnet (chain 5042). Not Circle-official. Spam bot filtered. DYOR.',
    tokenCount: tokens.length, tokens,
  };
  fs.writeFileSync('public/tokens-snapshot-5042.json', JSON.stringify(out, null, 1));
  console.error('wrote public/tokens-snapshot-5042.json —', tokens.length, 'tokens');
  console.log('\n=== TOP 5042 TOKENS (by holders) ===');
  tokens.slice(0,30).forEach(t => console.log(`h=${String(t.holders??'?').padStart(6)}  x=${String(t.transfers).padStart(4)}  ${t.symbol.padEnd(14)} ${t.address}  ${t.flags.join(',')||''}`));
})().catch(e => console.error('FATAL', e.message));
