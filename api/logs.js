// Wallet-history log relay for the VPS (server/wallet-index.ts), 10-15.
// ⛔ WHY: the VPS's IP is rate-limited on every Arc node that still serves older logs (Tenderly 429s it even for
// eth_blockNumber; rpc.mainnet / QuickNode 429 its getLogs; Blockdaemon has pruned them). A wallet whose saved history
// fell behind could never catch up, so the Portfolio's P&L sat on "…". From Vercel's IPs the same nodes answer.
// Key-gated (the VPS key, HOLDINGS_KEY) and ONE query shape only: Transfer logs to or from one wallet, optionally only the
// native-USDC emitter, ≤ 95k blocks — it is not a general RPC proxy.
const KEY = process.env.HOLDINGS_KEY;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';
const WIDE = ['https://arc.gateway.tenderly.co', 'https://rpc.blockdaemon.mainnet.arc.io'];   // 95k-block getLogs
const NARROW = ['https://rpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'];         // smaller ranges only
const SPLIT = 10_000;

async function getLogs(url, filter) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [filter] }), signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => null);
  if (!j || j.error || !Array.isArray(j.result)) throw new Error(j?.error?.message || `http ${r.status}`);
  return j.result;
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (!KEY || req.headers['x-relay-key'] !== KEY) return res.status(403).json({ error: 'nope' });
  const q = req.query;
  const lo = Number(q.lo), hi = Number(q.hi), side = String(q.side || ''), wallet = String(q.wallet || '').toLowerCase();
  const address = q.address ? String(q.address).toLowerCase() : null;
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi - lo >= 95_000
    || (side !== 'from' && side !== 'to') || (address && address !== NATIVE_LOG)) return res.status(400).json({ error: 'bad query' });
  const pad = '0x' + wallet.slice(2).padStart(64, '0');
  const topics = side === 'from' ? [TRANSFER, pad] : [TRANSFER, null, pad];
  const filter = (a, b) => ({ ...(address ? { address } : {}), topics, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) });
  let last = '';
  for (const url of WIDE) { try { return res.status(200).json({ logs: await getLogs(url, filter(lo, hi)), via: url }); } catch (e) { last = e.message; } }
  // the wide nodes said no: the same range in 10k pieces on the narrow ones
  for (const url of NARROW) {
    try {
      const out = [];
      for (let a = lo; a <= hi; a += SPLIT) out.push(...await getLogs(url, filter(a, Math.min(hi, a + SPLIT - 1))));
      return res.status(200).json({ logs: out, via: url });
    } catch (e) { last = e.message; }
  }
  return res.status(502).json({ error: String(last).slice(0, 200) });
}
