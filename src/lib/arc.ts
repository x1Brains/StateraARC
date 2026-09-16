// StateraArc — Arc chain data layer. Reads Blockscout's public API (no key, client-side).
// Flip NET to 'mainnet' when Arc mainnet + its explorer go live (Sept 16, 2026).
import { fetchWarpTokens, type Candle } from './warp';

export type Net = 'testnet' | 'mainnet';

export const NETS: Record<Net, { name: string; chainId: number; scan: string; api: string; rpc: string }> = {
  testnet: { name: 'Arc Testnet', chainId: 5042002, scan: 'https://testnet.arcscan.app', api: 'https://testnet.arcscan.app/api/v2', rpc: 'https://rpc.testnet.arc.io' },
  // ── MAINNET (pre-staged for Sept 16, 2026) ──────────────────────────────────────────────────────
  // chainId 5042 (0x13b2) is VERIFIED REAL. ✅ rpc.mainnet.arc.io is now PUBLIC + returns 0x13b2
  // (verified 2026-09-15) — the swap engine trades Warp/mainnet tokens against it (see swap.ts
  // setSwapMainnet), so live mainnet swaps work TODAY while the global NET stays 'testnet'.
  // STILL PENDING before a full global flip (MAINNET_LIVE = true):
  //   1. Mainnet explorer API: explorer.arc.io/api/v2 currently 302s and arc-scan.org is NOT Blockscout
  //      /api/v2 format — this app's screener depends on Blockscout. Until a compatible mainnet explorer
  //      API exists, mainnet token DATA flows through Warp (src/lib/warp.ts), not CHAIN.api. `scan` below
  //      = arc-scan.org (working block explorer, for tx/address links only).
  //   2. CCTP: confirm Arc is added to Circle's supported-chains table + its mainnet domain (Li.Fi/Polymer
  //      already bridges Ethereum→Arc today; see cctp-bridge.mjs / bridge.js).
  // RPC honors VITE_ARC_RPC / VITE_ARC_RPC_BACKUP overrides, so a trusted endpoint can be swapped in without a code change.
  mainnet: { name: 'Arc', chainId: 5042, scan: 'https://arc-scan.org', api: 'https://explorer.arc.io/api/v2', rpc: 'https://rpc.mainnet.arc.io' },
};

// Arc public mainnet — date VERIFIED from arc.io ("Arc Public Mainnet will launch on September 16, 2026").
export const MAINNET_LAUNCH_ISO = '2026-09-16T00:00:00Z';
export const MAINNET_LIVE = false; // flip to true on launch day AFTER the checklist above passes

// Mainnet reference facts (verified 2026-09-14) for the launch-day flip + CCTP onboarding.
export const MAINNET_INFO = {
  chainId: 5042,
  chainIdHex: '0x13b2',
  nativeUsdc: '0x3600000000000000000000000000000000000000', // same precompile address as testnet; gas token, 6-dec ERC-20 face
  attestationHost: 'https://iris-api.circle.com',           // Circle PROD attestation (testnet uses iris-api-sandbox)
  cctpDomain: null as number | null,                         // ⛔ TBD — Arc not yet in Circle's CCTP supported-chains table
  officialBridge: 'https://bridge.usdc.com',                 // Circle's hosted USDC bridge (verified)
};

export const NET: Net = (import.meta.env.VITE_ARC_NET as Net) || 'testnet';
export const CHAIN = NETS[NET];

// Known launchpads / factories from our radar (deployers that minted many tokens).
export const LAUNCHPADS: Record<string, string> = {
  '0x95d262c8ab207a54c08569887177fa301e7f9687': 'Memepad',
  '0x34a0b64a88bbd4bf6acba8a0ff8f27c8add67e9c': 'LP factory',
  '0x1594f838177784f4fcba8f4082d3ca53aeb2672b': 'Launcher',
  '0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad': 'Curve factory',
};

// Our own + notable ecosystem tokens, tagged for the views.
export const OURS = new Set(['0xc8e1ffc83da48b347dd89a42a19fd510723f16bb']); // BRAINS
export const ECOSYSTEM = /xylo|swaparc|synthra|arcflow|curve|cir|usyc|eurc|usdc|usdt/i;

export interface Token {
  address: string;
  name: string;
  symbol: string;
  holders: number | null;
  totalSupply: string | null;
  type: string;
  iconUrl: string | null;
  launchpad: string | null;
  isOurs: boolean;
  isEcosystem: boolean;
  price: number | null;
  liq: number | null;
  mcap: number | null;
  transfers?: number;      // pre-public (5042): transfer-event count in the scan window
  flags?: string[];        // pre-public: 'lookalike' | 'dup-symbol' | 'reserved-name'
  premain?: boolean;       // sourced from the unofficial 5042 index
}

export const addrOf = (o: any): string =>
  (o && (o.hash || o.address_hash || o.address)) || (typeof o === 'string' ? o : '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch with 429 backoff — Blockscout's public API rate-limits, so retry politely.
export async function req(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await sleep(800 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  throw new Error('rate-limited (429) — try again shortly');
}
async function api(path: string): Promise<any> { return req(`${CHAIN.api}${path}`); }

export async function fetchTokens(limit = 500): Promise<Token[]> {
  // FAST PATH: pre-baked snapshot (one small file, launchpad flags already computed) — the app
  // loads the whole screener instantly instead of hammering Blockscout's rate-limited API.
  try {
    // A cron can host a fresh snapshot at VITE_SNAPSHOT_URL; otherwise use the bundled one.
    const url = (import.meta.env.VITE_SNAPSHOT_URL as string) || '/tokens-snapshot.json';
    const r = await fetch(url, { cache: 'default' });
    if (r.ok) {
      const snap = await r.json();
      if (snap && Array.isArray(snap.tokens) && snap.tokens.length) {
        return snap.tokens.slice(0, limit).map((t: any): Token => ({
          address: t.address, name: t.name, symbol: t.symbol,
          holders: t.holders ?? null, totalSupply: null, type: 'ERC-20',
          iconUrl: t.iconUrl ?? null, launchpad: t.launchpad ?? null,
          isOurs: !!t.isOurs, isEcosystem: !!t.isEcosystem,
          price: t.price ?? null, liq: t.liq ?? null,
          // guard testnet supply-inflation: a $2T "market cap" is a minted-huge stablecoin, not real
          mcap: (typeof t.mcap === 'number' && t.mcap > 0 && t.mcap <= 1e10) ? t.mcap : null,
        }));
      }
    }
  } catch { /* fall through to the live path */ }

  // FALLBACK: live fetch (rate-limited) — only used before a snapshot exists.
  const out: Token[] = [];
  let params = new URLSearchParams({ type: 'ERC-20' });
  while (out.length < limit) {
    const j = await req(`${CHAIN.api}/tokens?${params.toString()}`);
    if (!j) break;
    for (const t of j.items || []) {
      const address = addrOf(t.address ?? t).toLowerCase();
      if (!address) continue;
      out.push({
        address,
        name: t.name || '(unnamed)',
        symbol: t.symbol || '?',
        holders: t.holders != null ? Number(t.holders) : (t.holder_count != null ? Number(t.holder_count) : null),
        totalSupply: t.total_supply ?? null,
        type: t.type || 'ERC-20',
        iconUrl: t.icon_url ?? null,
        launchpad: null, // filled lazily via enrichLaunchpad
        isOurs: OURS.has(address),
        isEcosystem: ECOSYSTEM.test(`${t.name} ${t.symbol}`),
        price: null, liq: null, mcap: null,
      });
    }
    if (!j.next_page_params) break;
    params = new URLSearchParams({ type: 'ERC-20', ...j.next_page_params });
    await sleep(160); // be gentle on the public API
  }
  return out.slice(0, limit);
}

// ── Pre-public Arc mainnet (chain 5042) token index ──────────────────────────────────────────
// Reads our baked, spam-filtered 5042 snapshot (source: arc-scan.org, UNOFFICIAL). Ranked by
// holders. No prices yet (the DEX is Uniswap v4 — pricing lands once we ID the v4 quoter).
export interface PremainMeta { generated: string; headBlock: string | null; tokenCount: number; source: string; }
export let premainMeta: PremainMeta | null = null;
export async function fetchPremainTokens(): Promise<Token[]> {
  const url = (import.meta.env.VITE_SNAPSHOT_5042_URL as string) || '/tokens-snapshot-5042.json';
  const r = await fetch(url, { cache: 'default' });
  if (!r.ok) return [];
  const snap = await r.json();
  premainMeta = { generated: snap.generated, headBlock: snap.headBlock ?? null, tokenCount: snap.tokenCount ?? 0, source: snap.source ?? '' };
  if (!Array.isArray(snap.tokens)) return [];
  return snap.tokens.map((t: any): Token => ({
    address: t.address, name: t.name || t.symbol, symbol: t.symbol,
    holders: t.holders ?? null, totalSupply: t.supply ?? null, type: 'ERC-20',
    iconUrl: null, launchpad: null, isOurs: false, isEcosystem: false,
    price: null, liq: null, mcap: null,
    transfers: t.transfers ?? undefined, flags: Array.isArray(t.flags) ? t.flags : [], premain: true,
  }));
}

// Fetch a token's deployer and tag it if the deployer is a known launchpad. Called sparingly
// (throttled by the caller) so we don't trip the public API rate limit.
export async function enrichLaunchpad(t: Token): Promise<Token> {
  try {
    const j = await req(`${CHAIN.api}/addresses/${t.address}`);
    const creator = addrOf(j.creator_address_hash).toLowerCase();
    return { ...t, launchpad: LAUNCHPADS[creator] || null };
  } catch { return t; }
}

export const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString());

// Market ticker — BTC/ETH/SOL from Coinbase's CORS-open spot API, plus the stables.
export interface MarketPx { sym: string; price: number | null; logo: string | null }
// The wider financial world — live via Coinbase spot (no key). Gold = PAXG (tokenized gold).
const MARKET_ASSETS = [
  { cb: 'BTC', sym: 'BTC', logo: '/coins/BTC.png' },
  { cb: 'ETH', sym: 'ETH', logo: '/coins/ETH.png' },
  { cb: 'SOL', sym: 'SOL', logo: '/coins/SOL.png' },
  { cb: 'XRP', sym: 'XRP', logo: '/coins/XRP.png' },
  { cb: 'SUI', sym: 'SUI', logo: '/coins/SUI.png' },
  { cb: 'DOGE', sym: 'DOGE', logo: '/coins/DOGE.png' },
  { cb: 'AVAX', sym: 'AVAX', logo: '/coins/AVAX.png' },
  { cb: 'LINK', sym: 'LINK', logo: '/coins/LINK.png' },
  { cb: 'PAXG', sym: 'GOLD', logo: '/coins/PAXG.png' },
];
// XNT (X1's native token) — live USD price via XDEX. CORS-blocked, so proxied at /api/xdex
// (Vercel rewrite in prod, vite proxy in dev). Mint So111…112 = X1 native.
async function fetchXnt(): Promise<number | null> {
  try {
    const r = await fetch('/api/xdex/api/token-price/price?network=X1%20Mainnet&token_address=So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return Number(j?.data?.price) || null;
  } catch { return null; }
}
export async function fetchMarket(): Promise<MarketPx[]> {
  const out: MarketPx[] = [];
  const [, xnt] = await Promise.all([
    Promise.all(MARKET_ASSETS.map(async (a) => {
      try {
        const r = await fetch(`https://api.coinbase.com/v2/prices/${a.cb}-USD/spot`);
        const j = await r.json();
        out.push({ sym: a.sym, price: Number(j.data.amount), logo: a.logo });
      } catch { out.push({ sym: a.sym, price: null, logo: a.logo }); }
    })),
    fetchXnt(),
  ]);
  out.sort((x, y) => MARKET_ASSETS.findIndex((a) => a.sym === x.sym) - MARKET_ASSETS.findIndex((a) => a.sym === y.sym));
  // XNT right after SOL.
  const solIdx = out.findIndex((a) => a.sym === 'SOL');
  const xntEntry: MarketPx = { sym: 'XNT', price: xnt, logo: '/coins/XNT.webp' };
  if (solIdx >= 0) out.splice(solIdx + 1, 0, xntEntry); else out.push(xntEntry);
  // Arc's own money (fixed peg).
  out.push({ sym: 'USDC', price: 1, logo: '/coins/USDC.svg' }, { sym: 'EURC', price: 1.08, logo: '/coins/EURC.svg' });
  return out;
}
export const price = (n: number | null) =>
  n == null ? '—' : n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(4);

export const usd = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + n.toFixed(2);
};
export const compact = (n: number | null) =>
  n == null ? '—' : n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(Math.round(n));

// Token price — handles both normal and sub-cent values.
export const tprice = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(4);
  if (n >= 1e-6) return '$' + n.toFixed(8).replace(/0+$/, '');
  return '$' + n.toExponential(2);
};

// ── token detail ──
export interface TokenDetail {
  address: string; name: string; symbol: string; decimals: number;
  totalSupply: number | null; holders: number | null; iconUrl: string | null;
  exchangeRate: number | null; marketCap: number | null; volume24h: number | null;
  creator: string | null; isVerified: boolean; transfersCount: number | null;
}
export async function fetchTokenDetail(address: string): Promise<TokenDetail> {
  const [tok, counters, addr] = await Promise.all([
    api(`/tokens/${address}`),
    api(`/tokens/${address}/counters`).catch(() => ({} as any)),
    api(`/addresses/${address}`).catch(() => ({} as any)),
  ]);
  const dec = Number(tok.decimals || 18);
  const supplyRaw = tok.total_supply != null ? Number(tok.total_supply) / 10 ** dec : null;
  return {
    address, name: tok.name || '(unnamed)', symbol: tok.symbol || '?', decimals: dec,
    totalSupply: supplyRaw,
    holders: tok.holders != null ? Number(tok.holders) : (counters.token_holders_count != null ? Number(counters.token_holders_count) : null),
    iconUrl: tok.icon_url ?? null,
    exchangeRate: tok.exchange_rate != null ? Number(tok.exchange_rate) : null,
    marketCap: tok.circulating_market_cap != null ? Number(tok.circulating_market_cap) : null,
    volume24h: tok.volume_24h != null ? Number(tok.volume_24h) : null,
    creator: addr.creator_address_hash ? addrOf(addr.creator_address_hash) : null,
    isVerified: !!(addr.is_verified),
    transfersCount: counters.transfers_count != null ? Number(counters.transfers_count) : null,
  };
}

export interface Transfer { t: number; from: string; to: string; amount: number; tx: string; method: string; }
export async function fetchTransfers(address: string, limit = 50): Promise<Transfer[]> {
  const j = await api(`/tokens/${address}/transfers`).catch(() => ({ items: [] }));
  return (j.items || []).slice(0, limit).map((it: any) => ({
    t: new Date(it.timestamp).getTime(),
    from: addrOf(it.from), to: addrOf(it.to),
    amount: Number(it.total?.value || 0) / 10 ** Number(it.total?.decimals || 18),
    tx: it.transaction_hash || it.tx_hash || '',
    method: it.method || '',
  }));
}
// ── pool discovery + trade classification (detail page) ──
// Quote stablecoins — a token's liquidity pool is a top-holder that ALSO holds one of these.
const QUOTES = [
  { addr: '0x3600000000000000000000000000000000000000', dec: 6, sym: 'USDC' },
  { addr: '0x911b4000d3422f482f4062a913885f7b035382df', dec: 18, sym: 'WUSDC' },
  { addr: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', dec: 6, sym: 'EURC' },
];
// RPC failover: try each endpoint with a short retry on 429/error. Add alternate providers or
// our own read-only Arc node to RPCS for real redundancy (no single point of failure).
export const RPCS = [(import.meta.env.VITE_ARC_RPC as string) || CHAIN.rpc, ...((import.meta.env.VITE_ARC_RPC_BACKUP as string || '').split(',').map((s) => s.trim()).filter(Boolean))].filter(Boolean);
async function rpcCall(body: object): Promise<any> {
  for (const rpc of RPCS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 429) { await sleep(400 * (attempt + 1)); continue; }
        if (!r.ok) break; // dead endpoint — fail over to the next
        return await r.json();
      } catch { /* network error — retry, then next endpoint */ }
    }
  }
  return null;
}
async function ethCall(to: string, data: string): Promise<string | null> {
  const j = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  return j && j.result && j.result !== '0x' ? j.result : null;
}
const balanceOfRaw = (token: string, holder: string) => ethCall(token, '0x70a08231000000000000000000000000' + holder.slice(2));

export interface HolderRow { address: string; balance: number; pct: number | null; }
export async function fetchHolders(address: string, decimals: number, totalSupply: number | null): Promise<HolderRow[]> {
  const j = await api(`/tokens/${address}/holders`).catch(() => ({ items: [] as any[] }));
  return (j.items || []).slice(0, 20).map((h: any) => {
    const bal = Number(h.value || 0) / 10 ** decimals;
    return { address: addrOf(h.address), balance: bal, pct: totalSupply ? (bal / totalSupply) * 100 : null };
  });
}
export interface PoolInfo { pool: string; quoteSym: string; }
// The liquidity pool is whichever of the top holders also holds a quote stablecoin (read via RPC).
export async function findPool(holders: HolderRow[]): Promise<PoolInfo | null> {
  for (const h of holders.slice(0, 6)) {
    for (const q of QUOTES) {
      const raw = await balanceOfRaw(q.addr, h.address);
      if (raw && Number(BigInt(raw)) / 10 ** q.dec > 0.5) return { pool: h.address.toLowerCase(), quoteSym: q.sym };
    }
  }
  return null;
}

export interface Trade extends Transfer { side: 'buy' | 'sell' | 'xfer'; value: number | null; }
// Classify each transfer against the pool: tokens leaving the pool = a BUY, entering = a SELL.
export function classifyTrades(transfers: Transfer[], pool: string | null, price: number | null): Trade[] {
  const p = pool?.toLowerCase();
  const zero = '0x0000000000000000000000000000000000000000';
  return transfers.map((t) => {
    let side: 'buy' | 'sell' | 'xfer' = 'xfer';
    const from = t.from.toLowerCase(), to = t.to.toLowerCase();
    if (p && from !== zero && to !== zero) {
      if (from === p) side = 'buy';
      else if (to === p) side = 'sell';
    }
    return { ...t, side, value: price != null ? t.amount * price : null };
  });
}

export const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000); // clamp: block timestamps can read a hair ahead of local clock
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

// ── portfolio ──
export interface Holding { address: string; name: string; symbol: string; decimals: number; balance: number; iconUrl: string | null; }
export async function fetchHoldings(addr: string): Promise<Holding[]> {
  const j = await req(`${CHAIN.api}/addresses/${addr}/token-balances`).catch(() => []);
  const arr = Array.isArray(j) ? j : (j.items || []);
  return arr
    .filter((x: any) => !x.token?.type || String(x.token.type).includes('ERC-20'))
    .map((x: any) => {
      const dec = Number(x.token?.decimals || 18);
      return {
        address: addrOf(x.token?.address || x.token).toLowerCase(),
        name: x.token?.name || '?', symbol: x.token?.symbol || '?', decimals: dec,
        balance: Number(x.value || 0) / 10 ** dec, iconUrl: x.token?.icon_url || null,
      };
    })
    .filter((h: Holding) => h.balance > 0);
}

// ── Mainnet holdings (chain 5042) ─────────────────────────────────────────────
// No indexer lists a wallet's mainnet tokens (arc-scan's /address/{a}/tokens 500s, explorer.arc.io
// isn't Blockscout), so we scan a curated + board candidate set ON-CHAIN via the mainnet RPC. Not
// exhaustive, but returns REAL balances for the tokens that matter (WARP, watchlist, stablecoins).
const MAINNET_RPC = (import.meta.env.VITE_ARC_MAINNET_RPC as string) || 'https://rpc.mainnet.arc.io';
// rpc.mainnet.arc.io rate-limits bursts (HTTP 429), so retry with backoff on failure/429.
async function mrpc(method: string, params: any[], tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(MAINNET_RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) { await sleep(200 * (i + 1) + Math.random() * 200); continue; }
      const j = await r.json();
      return j.error ? null : j.result;
    } catch { await sleep(200 * (i + 1)); }
  }
  return null;
}
// Run async tasks with bounded concurrency (keeps us under the RPC's rate limit).
async function runLimited<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) { const idx = i++; out[idx] = await tasks[idx](); }
  }));
  return out;
}
const mCall = (to: string, data: string) => mrpc('eth_call', [{ to, data }, 'latest']);
const mHexToStr = (hex: string) => { let s = ''; for (let i = 0; i + 1 < hex.length; i += 2) { const c = parseInt(hex.substr(i, 2), 16); if (c) s += String.fromCharCode(c); } return s; };
const mReadStr = async (t: string, sel: string): Promise<string | null> => {
  const r = await mCall(t, sel); if (!r || r === '0x' || r.length < 130) return null;
  try { const len = Number(BigInt('0x' + r.slice(66, 130))); return mHexToStr(r.slice(130, 130 + len * 2)) || null; } catch { return null; }
};
const NATIVE_USDC_ADDR = '0x3600000000000000000000000000000000000000';
// Curated notable mainnet tokens (symbol/decimals known) — always scanned.
const MAINNET_CORE: { address: string; name: string; symbol: string; decimals: number }[] = [
  { address: '0x384c60f98ecd4c26345499345c03d677e40f115e', name: 'Warp', symbol: 'WARP', decimals: 18 },
  { address: '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0', name: 'Architects', symbol: 'Architects', decimals: 18 },
  { address: '0xece5ca8bf9220718e5727754026757512212cb3c', name: 'Argus', symbol: 'ARGUS', decimals: 18 },
  { address: '0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b', name: 'CRCL', symbol: 'CRCL', decimals: 18 },
  { address: '0xbc43ce8dec648ea298c4275559b81d6261c90b67', name: 'Tolly', symbol: 'TOLLY', decimals: 18 },
  { address: '0xf3715bf5c2de299f08b81180ffb739a8372a175f', name: 'Arcanine', symbol: 'ARCANINE', decimals: 18 },
  { address: '0x12ce1f970722ca6e08364b60099b3d25c09b5434', name: 'Arc Index 10', symbol: 'ARCX10', decimals: 18 },
  { address: '0xd17014b731d33994e4e482c374ef375b68240087', name: 'Machines Muxing Money', symbol: 'MMM', decimals: 18 },
  { address: '0x07704b06981ea962b87296362a1281484d160000', name: 'Arcat', symbol: 'ARCAT', decimals: 18 },
  { address: '0xeb64987643db71c76b2a2be7e723decc995e5b37', name: 'Cool', symbol: 'COOL', decimals: 18 },
  { address: '0x0bffa97f774824e9da843699aedd2835cb1b8022', name: 'Arcash', symbol: 'ARCASH', decimals: 18 },
  { address: '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97', name: 'Arcbat', symbol: 'ARCBAT', decimals: 18 },
  { address: '0x2164bb17a2d38c1b5170e987b2c0416df1efc752', name: 'Long', symbol: 'LONG', decimals: 18 },
];
export async function fetchHoldingsMainnet(addr: string, extra: { address: string; name?: string; symbol?: string }[] = []): Promise<Holding[]> {
  const seen = new Set(MAINNET_CORE.map((t) => t.address.toLowerCase()));
  const cands: { address: string; name?: string; symbol?: string; decimals?: number }[] = [...MAINNET_CORE];
  for (const t of extra) { const k = t.address?.toLowerCase(); if (k && !seen.has(k)) { seen.add(k); cands.push(t); } }
  const out: Holding[] = [];
  // native USDC (gas token, 18-dec native face)
  const nb = await mrpc('eth_getBalance', [addr, 'latest']);
  if (nb) { const bal = Number(BigInt(nb)) / 1e18; if (bal > 0) out.push({ address: NATIVE_USDC_ADDR, name: 'USD Coin', symbol: 'USDC', decimals: 6, balance: bal, iconUrl: null }); }
  const balSel = '0x70a08231000000000000000000000000' + addr.slice(2).toLowerCase();
  await runLimited(cands.map((t) => async () => {
    const r = await mCall(t.address, balSel);
    if (!r || r === '0x') return;
    let raw: bigint; try { raw = BigInt(r); } catch { return; }
    if (raw <= 0n) return;
    const dec = t.decimals ?? Number(BigInt((await mCall(t.address, '0x313ce567')) || '0x12'));
    const bal = Number(raw) / 10 ** dec;
    if (bal <= 0) return;
    const sym = t.symbol || (await mReadStr(t.address, '0x95d89b41')) || '?';
    const name = t.name || (await mReadStr(t.address, '0x06fdde03')) || sym;
    out.push({ address: t.address.toLowerCase(), name, symbol: sym, decimals: dec, balance: bal, iconUrl: null });
  }), 4);
  return out.sort((a, b) => b.balance - a.balance);
}

// USDC pools (token→pool) discovered on-chain 2026-09-16. Live spot price = pool's native-USDC
// balance ÷ pool's token balance (verified consistent with the WarpV2 getAmountsOut quote for WARP;
// Warp's own API price lagged live). All these tokens are 18-dec. No pool = not priced (CRCL/ARCX10).
const MAINNET_POOL: Record<string, string> = {
  '0x384c60f98ecd4c26345499345c03d677e40f115e': '0x507a494fde26960cb36d50912cab83c71ecc7ea7', // WARP (WarpV2)
  '0xece5ca8bf9220718e5727754026757512212cb3c': '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02', // ARGUS
  '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0': '0x0069cb6f70e2f848405f4483f232274c720ce6f9', // Architects
  '0xbc43ce8dec648ea298c4275559b81d6261c90b67': '0x162df51c504e7b8321e07387932f333d9be16a72', // TOLLY
  '0xf3715bf5c2de299f08b81180ffb739a8372a175f': '0x6d8db35396b5eb98dee495e32b8cca992682316d', // ARCANINE
  '0x07704b06981ea962b87296362a1281484d160000': '0xcf924acee7eb1f169a922bf19b0a732810971985', // ARCAT
  '0xeb64987643db71c76b2a2be7e723decc995e5b37': '0x40732e01ba7a829dea44f51a10e7c58cd9f37765', // COOL
  '0x0bffa97f774824e9da843699aedd2835cb1b8022': '0x7dbcec05f12b14e21a79a0dc15ea9859322a4ab2', // ARCASH
  '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97': '0x482a249eb473b7de0ca8357b5496ccb7c55dfb72', // ARCBAT
  // Found via Transfer-log scan (their pools hold few tokens so they never rank as top holders).
  '0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b': '0x2e8180fa3967caf9abf57bbaeab9ae9063bcd7ba', // CRCL (thin, high unit price)
  // ARCX10 omitted: its V3 pool is dead ($16); real liquidity is a hooked Uniswap-v4 pool we don't price.
  '0x2164bb17a2d38c1b5170e987b2c0416df1efc752': '0xda9f3d166497ddfddf37c93cacfd8aa39b71e493', // LONG (Uni V3, ~$113k)
  '0xd17014b731d33994e4e482c374ef375b68240087': '0x0f0333cf487a90ac7e56cba1541a1669e260cf22', // MMM (thin)
};
// NOTE: these are Uniswap-V3 pools (Argus factory). balanceOf-ratio is an APPROXIMATION of the V3
// spot price (concentrated liquidity), close enough for portfolio display; exact pricing = slot0.
// Live USD prices for mainnet tokens, read straight from each token's USDC pool reserves.
export async function priceMainnet(addrs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => a === NATIVE_USDC_ADDR.toLowerCase() || MAINNET_POOL[a]);
  const balOf = (token: string, who: string) => mCall(token, '0x70a08231000000000000000000000000' + who.slice(2).toLowerCase());
  await runLimited(uniq.map((a) => async () => {
    if (a === NATIVE_USDC_ADDR.toLowerCase()) { out[a] = 1; return; }
    const pool = MAINNET_POOL[a];
    // Both sides via ERC-20 balanceOf so calls are uniform + retryable: USDC face is 6-dec, token 18-dec.
    const [uHex, bHex] = await Promise.all([balOf(NATIVE_USDC_ADDR, pool), balOf(a, pool)]);
    if (!uHex || !bHex || bHex === '0x' || uHex === '0x') return;
    let usdc: number, toks: number;
    try { usdc = Number(BigInt(uHex)) / 1e6; toks = Number(BigInt(bHex)) / 1e18; } catch { return; }
    if (usdc > 0 && toks > 0) out[a] = usdc / toks;
  }), 4);
  return out;
}

// Combined price + USD liquidity for every tracked mainnet pool (one throttled on-chain pass).
async function mainnetStats(): Promise<Record<string, { price: number | null; liq: number | null }>> {
  const out: Record<string, { price: number | null; liq: number | null }> = {};
  const balOf = (token: string, who: string) => mCall(token, '0x70a08231000000000000000000000000' + who.slice(2).toLowerCase());
  await runLimited(Object.entries(MAINNET_POOL).map(([token, pool]) => async () => {
    const [uHex, bHex] = await Promise.all([balOf(NATIVE_USDC_ADDR, pool), balOf(token, pool)]);
    if (!uHex || uHex === '0x') { out[token] = { price: null, liq: null }; return; }
    try {
      const usdc = Number(BigInt(uHex)) / 1e6;
      const toks = bHex && bHex !== '0x' ? Number(BigInt(bHex)) / 1e18 : 0;
      out[token] = { price: toks > 0 ? usdc / toks : null, liq: usdc * 2 }; // full pool ≈ 2× the USDC side
    } catch { out[token] = { price: null, liq: null }; }
  }), 4);
  return out;
}

// Arc ecosystem assets (Animus wrapped suite — biggest holder base on chain) for the Ecosystem card.
const ECOSYSTEM_TOKENS: { address: string; name: string; symbol: string; price: number | null; holders: number }[] = [
  { address: '0xf5b08979251f398180385b54381ee3d6fa1bbe09', name: 'Animus USD', symbol: 'AUSD', price: 1, holders: 21268 },
  { address: '0x8cd7e5a2240a1a7efaa9b164caa1dc80e9ed23a3', name: 'Animus EUR', symbol: 'AEUR', price: 1.08, holders: 22237 },
  { address: '0x04adf55844be2f4c8d23e3f5f2386b08400b0cd1', name: 'Animus WXT', symbol: 'AWXT', price: null, holders: 20485 },
  { address: '0x26d1ffbbb8b310b090ee0536748b4adfc88ae644', name: 'Animus Wirex Reward', symbol: 'AWORP', price: null, holders: 14773 },
  { address: '0x7ce5e3fb080545c8912cf93297d93441911e9e4d', name: 'Animus BTC', symbol: 'ABTC', price: null, holders: 5566 },
];

// The FULL mainnet token universe for the screener + home cards. Merges every source we have so the
// screener shows pages of tokens with price/liquidity/holders — like before:
//   1. USDC + Animus ecosystem suite   2. every Warp token (~390, full price/liq/mcap/holders)
//   3. the arc-scan holder snapshot (~146 — adds non-Warp tokens like the Animus suite / externals)
//   4. our tracked deep V3/WarpV2 pools OVERWRITE with accurate on-chain price + liquidity (ARGUS,
//      TOLLY, LONG, COOL, Architects… — the deepest tokens, which Warp doesn't index).
// Deduped by address; nothing filtered out (dust sorts to the back), so the count is in the hundreds.
export async function fetchMainnetTokens(): Promise<Token[]> {
  const map = new Map<string, Token>();
  const coreMeta: Record<string, { name: string; symbol: string }> = {};
  for (const t of MAINNET_CORE) coreMeta[t.address.toLowerCase()] = { name: t.name, symbol: t.symbol };
  const mk = (o: Partial<Token> & { address: string; name: string; symbol: string }): Token => ({
    holders: null, totalSupply: null, type: 'ERC-20', iconUrl: null, launchpad: null, isOurs: false,
    isEcosystem: false, price: null, liq: null, mcap: null, ...o, address: o.address.toLowerCase(),
  });
  const set = (t: Token, overwrite = false) => { const k = t.address.toLowerCase(); if (!map.has(k) || overwrite) map.set(k, t); };

  // 1) USDC + Animus ecosystem
  set(mk({ address: NATIVE_USDC_ADDR, name: 'USD Coin', symbol: 'USDC', iconUrl: '/coins/USDC.svg', isEcosystem: true, price: 1 }));
  for (const e of ECOSYSTEM_TOKENS) set(mk({ address: e.address, name: e.name, symbol: e.symbol, holders: e.holders, isEcosystem: true, price: e.price }));

  // 2) every Warp token (full data)
  try {
    const warp = await fetchWarpTokens('liquidity', 800);
    for (const w of warp) if (w.address) set(mk({
      address: w.address, name: w.name, symbol: w.ticker, holders: w.holders, iconUrl: w.image,
      launchpad: w.migrated ? null : 'Warp', isEcosystem: /^(usdc|eurc|usyc|wusdc|usdt|dusdt|ausd|aeur)$/i.test(w.ticker),
      price: w.price, liq: w.liquidity, mcap: w.mcap,
    }));
  } catch { /* Warp optional */ }

  // 3) arc-scan holder snapshot — adds non-Warp tokens (holders known, price/liq land from pools if tracked)
  try { for (const t of await fetchPremainTokens()) set(t); } catch { /* snapshot optional */ }

  // 4) tracked deep pools — overwrite with accurate on-chain price + liquidity
  const stats = await mainnetStats().catch(() => ({} as Record<string, { price: number | null; liq: number | null }>));
  for (const addr of Object.keys(MAINNET_POOL)) {
    const s = stats[addr] || { price: null, liq: null }; const cur = map.get(addr); const m = coreMeta[addr];
    set(mk({
      address: addr, name: m?.name || cur?.name || addr.slice(0, 10), symbol: m?.symbol || cur?.symbol || '?',
      holders: cur?.holders ?? null, iconUrl: cur?.iconUrl ?? null, launchpad: cur?.launchpad ?? null,
      price: s.price ?? cur?.price ?? null, liq: s.liq ?? cur?.liq ?? null, mcap: cur?.mcap ?? null,
    }), true);
  }
  return [...map.values()];
}

// Top holders of a mainnet token (arc-scan indexer). share is a fraction (0.0512 = 5.12%).
export interface Holder { address: string; balance: number; share: number | null; rank: number; isContract: boolean; }
export async function fetchTokenHolders(address: string, limit = 20): Promise<Holder[]> {
  try {
    const r = await fetch(`https://api.arc-scan.org/v1/tokens/${address}/holders?limit=${limit}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.items || []).map((h: any) => ({
      address: (h.address?.address || h.address || '').toString(),
      balance: Number(h.balance?.formatted ?? 0),
      share: h.share != null ? Number(h.share) * 100 : null,
      rank: h.rank ?? 0,
      isContract: !!h.address?.is_contract,
    })).filter((h: Holder) => h.address);
  } catch { return []; }
}

// Build OHLC candles for a mainnet pooled token straight from its Uniswap-V3 pool Swap events.
// (Warp tokens use Warp's candles; the deep V3 tokens — ARGUS/TOLLY/LONG/COOL… — aren't on Warp,
// so we chart them from chain.) Price is read from each swap's sqrtPriceX96; timestamps are
// approximated from block height (blocks are ~sub-second on Arc), which is fine for a chart.
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
export async function fetchPoolCandles(token: string, decimals: number, intervalSec: number): Promise<Candle[]> {
  const pool = MAINNET_POOL[token.toLowerCase()]; if (!pool) return [];
  const [t0hex, headHex] = await Promise.all([mCall(pool, '0x0dfe1681'), mrpc('eth_blockNumber', [])]); // token0(), head
  if (!t0hex || !headHex) return [];
  const usdcIsToken0 = ('0x' + t0hex.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR.toLowerCase();
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const spanBlocks = Math.min(120000, Math.ceil((intervalSec * 120) / blockTime)); // ~120 candles of history
  const dexp = 10 ** (decimals - 6); // USDC is 6-dec, the token `decimals`-dec
  const swaps: { ts: number; price: number }[] = [];
  const CH = 2500n;
  for (let from = head - BigInt(spanBlocks); from < head && swaps.length < 4000; from += CH) {
    const to = from + CH > head ? head : from + CH;
    const logs = await mrpc('eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      try {
        const sqrtP = BigInt('0x' + l.data.slice(2).slice(128, 192)); // 3rd word of Swap data = sqrtPriceX96
        if (sqrtP <= 0n) continue;
        const ratio = (Number(sqrtP) / 2 ** 96) ** 2; // token1_raw / token0_raw
        if (!isFinite(ratio) || ratio <= 0) continue;
        const price = (usdcIsToken0 ? 1 / ratio : ratio) * dexp;
        if (!isFinite(price) || price <= 0) continue;
        swaps.push({ ts: Math.round(headTs - Number(head - BigInt(l.blockNumber)) * blockTime), price });
      } catch { /* skip */ }
    }
  }
  if (!swaps.length) return [];
  swaps.sort((a, b) => a.ts - b.ts);
  const buckets = new Map<number, { o: number; h: number; l: number; c: number }>();
  for (const s of swaps) {
    const b = Math.floor(s.ts / intervalSec) * intervalSec;
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { o: s.price, h: s.price, l: s.price, c: s.price });
    else { cur.h = Math.max(cur.h, s.price); cur.l = Math.min(cur.l, s.price); cur.c = s.price; }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, v]) => ({ time, open: v.o, high: v.h, low: v.l, close: v.c }));
}

// Recent on-chain Transfer events for a token (mainnet RPC eth_getLogs) — works for ANY token.
export interface TokenTransfer { from: string; to: string; amount: number; tx: string; }
export async function fetchTokenTransfers(address: string, decimals = 18, want = 15): Promise<TokenTransfer[]> {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const head = await mrpc('eth_blockNumber', []); if (!head) return [];
  const h = BigInt(head); const out: TokenTransfer[] = [];
  for (let i = 0; i < 8 && out.length < want; i++) {
    const hi = h - BigInt(i * 1500), lo = hi - 1500n;
    const logs = await mrpc('eth_getLogs', [{ address, topics: [TRANSFER], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
    if (Array.isArray(logs)) for (const l of [...logs].reverse()) {
      if (out.length >= want) break;
      if (!l.topics || l.topics.length < 3) continue;
      try { out.push({ from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: Number(BigInt(l.data)) / 10 ** decimals, tx: l.transactionHash }); } catch { /* skip */ }
    }
  }
  return out.slice(0, want);
}
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

// ── wallet (EIP-1193 injected, e.g. MetaMask) ──
export async function connectWallet(): Promise<string | null> {
  const eth = (window as any).ethereum;
  if (!eth) { window.open('https://rabby.io', '_blank'); return null; } // no injected wallet — send them to get one
  const accts = await eth.request({ method: 'eth_requestAccounts' });
  const hexId = '0x' + CHAIN.chainId.toString(16);
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] }); }
  catch (e: any) {
    if (e.code === 4902) {
      await eth.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: hexId, chainName: CHAIN.name,
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.scan],
      }] });
    }
  }
  return accts?.[0] || null;
}
