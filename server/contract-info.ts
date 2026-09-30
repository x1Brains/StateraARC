// CONTRACT INFO from chain (09-30, owner: "Statera builds its own data for everything"). Replaces arc-scan's REST
// /tokens/<a> for the token page's extended details: creator, contract size, transfers in 24h (+ name/symbol/decimals/
// supply straight from the contract). The creator is whoever sent the transaction in the deploy block that minted the
// token's first supply (a launchpad launch = the launcher's own tx); a token that minted nothing there shows no creator
// rather than a guess. Deploy block: binary search on eth_getCode at archive state (Arc's public RPC keeps history).
import fs from 'node:fs';
import path from 'node:path';
import { encAggregate3, decAggregate3 } from '../scripts/lib/multicall.mjs';

const ARCHIVE = ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org'];
const WIDE = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://arc.gateway.tenderly.co'];
const MC = '0xca11bde05977b3631167028862be2a173976ca11';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FILE = process.env.CONTRACT_INFO || '/root/statera-api-state/contract-info.json';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(urls: string[], method: string, params: unknown[]): Promise<any> {
  let last = '';
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(urls[i % urls.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
      const j: any = await r.json(); if (j.error) throw new Error(String(j.error.message)); return j.result;
    } catch (e) { last = (e as Error).message; await sleep(250 * (i + 1)); }
  }
  throw new Error(last || 'rpc unavailable');
}
const dec = (h: string | null) => { if (!h || h.length < 130) return null; try { const len = Number(BigInt('0x' + h.slice(66, 130))); return Buffer.from(h.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0+$/, ''); } catch { return null; } };

// the parts that never change (deploy block, creator, size) are saved; transfers24h / supply are read fresh
type Fixed = { deployBlock: number; creator: string | null; size: number; at: number };
let fixed: Record<string, Fixed> = {};
try { fixed = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
const saveFixed = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(fixed)); fs.renameSync(FILE + '.tmp', FILE); } catch { /* */ } };

async function fixedOf(t: string): Promise<Fixed | null> {
  if (fixed[t]) return fixed[t];
  const head = parseInt(await call(ARCHIVE, 'eth_blockNumber', []), 16);
  const code = await call(ARCHIVE, 'eth_getCode', [t, 'latest']);
  if (!code || code === '0x') return null;
  let lo = 0, hi = head;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const c = await call(ARCHIVE, 'eth_getCode', [t, '0x' + mid.toString(16)]); if (c && c !== '0x') hi = mid; else lo = mid + 1; }
  // creator = the sender of the transaction in the deploy block that created this contract: its receipt names it as the
  // created contract, or (a factory / launchpad clone, GLITCH is a 45-byte clone) it emitted a log from it. No match = no
  // creator shown (never a guess).
  let creator: string | null = null;
  const blk = await call(ARCHIVE, 'eth_getBlockByNumber', ['0x' + lo.toString(16), true]).catch(() => null);
  const txs: any[] = Array.isArray(blk?.transactions) ? blk.transactions.slice(0, 60) : [];
  for (const tx of txs) {
    const rc = await call(ARCHIVE, 'eth_getTransactionReceipt', [tx.hash]).catch(() => null);
    if (!rc) continue;
    const made = String(rc.contractAddress || '').toLowerCase() === t;
    // a launchpad factory's launch event names the new token in its topics or data (Argus Portal: PartsDeployed(token, …))
    const needle = t.slice(2);
    const touched = Array.isArray(rc.logs) && rc.logs.some((l: any) => String(l.address).toLowerCase() === t
      || (l.topics || []).some((x: string) => String(x).toLowerCase().endsWith(needle)) || String(l.data || '').toLowerCase().includes(needle));
    if (made || touched) { creator = String(tx.from).toLowerCase(); break; }
  }
  const f: Fixed = { deployBlock: lo, creator, size: (code.length - 2) / 2, at: Date.now() };
  fixed[t] = f; saveFixed();
  return f;
}

export interface ContractInfo { name: string | null; symbol: string | null; decimals: number | null; supply: number | null; deployBlock: number | null; creator: string | null; size: number | null; transfers24h: number | null }
export async function contractInfo(token: string): Promise<ContractInfo | null> {
  const t = token.toLowerCase();
  try {
    const [f, basics, head] = await Promise.all([
      fixedOf(t).catch(() => null),
      call(ARCHIVE, 'eth_call', [{ to: MC, data: encAggregate3([{ target: t, data: '0x06fdde03' }, { target: t, data: '0x95d89b41' }, { target: t, data: '0x313ce567' }, { target: t, data: '0x18160ddd' }]) }, 'latest']).then((r) => decAggregate3(r)).catch(() => [null, null, null, null]),
      call(WIDE, 'eth_blockNumber', []).then((h) => parseInt(h, 16)).catch(() => null),
    ]);
    const decimals = basics[2] && basics[2].length >= 66 ? Number(BigInt(basics[2].slice(0, 66))) : null;
    const supplyRaw = basics[3] && basics[3].length >= 66 ? BigInt(basics[3].slice(0, 66)) : null;
    // transfers in the last 24h: the chain's own block times (read, not assumed)
    let transfers24h: number | null = null;
    if (head) {
      try {
        const [hb, ob] = await Promise.all([call(WIDE, 'eth_getBlockByNumber', ['0x' + head.toString(16), false]), call(ARCHIVE, 'eth_getBlockByNumber', ['0x' + (head - 20000).toString(16), false])]);
        const bt = Math.max(0.1, (parseInt(hb.timestamp, 16) - parseInt(ob.timestamp, 16)) / 20000);
        const from = head - Math.ceil(86400 / bt);
        let n = 0;
        for (let lo = from; lo <= head; lo += 95000) { const r = await call(WIDE, 'eth_getLogs', [{ address: t, topics: [TRANSFER], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + Math.min(head, lo + 94999).toString(16) }]); n += Array.isArray(r) ? r.length : 0; }
        transfers24h = n;
      } catch { /* unknown, not 0 */ }
    }
    return { name: dec(basics[0]), symbol: dec(basics[1]), decimals, supply: supplyRaw != null && decimals != null ? Number(supplyRaw) / 10 ** decimals : null,
      deployBlock: f?.deployBlock ?? null, creator: f?.creator ?? null, size: f?.size ?? null, transfers24h };
  } catch { return null; }
}
