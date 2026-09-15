// StateraArc — Arc chain data layer. Reads Blockscout's public API (no key, client-side).
// Flip NET to 'mainnet' when Arc mainnet + its explorer go live (Sept 16, 2026).

export type Net = 'testnet' | 'mainnet';

export const NETS: Record<Net, { name: string; chainId: number; scan: string; api: string; rpc: string }> = {
  testnet: { name: 'Arc Testnet', chainId: 5042002, scan: 'https://testnet.arcscan.app', api: 'https://testnet.arcscan.app/api/v2', rpc: 'https://rpc.testnet.arc.io' },
  // ── MAINNET (pre-staged for Sept 16, 2026) ──────────────────────────────────────────────────────
  // chainId 5042 (0x13b2) is VERIFIED REAL (canonical registry + a live tx's signature recovered for
  // chainId 5042). scan/api/rpc below are the ANTICIPATED official Circle endpoints — today they're
  // Cloudflare/auth-gated (private mainnet) and open publicly on launch day.
  // LAUNCH-DAY CHECKLIST (then flip MAINNET_LIVE = true — the one switch):
  //   1. Confirm rpc.mainnet.arc.io returns 0x13b2 publicly (or set VITE_ARC_RPC to a builder/partner endpoint).
  //   2. Confirm the mainnet explorer host + that its API is Blockscout /api/v2 compatible (this app depends on it).
  //      Candidates to check: explorer.arc.io , arcscan.app , mainnet.arcscan.app. Update scan+api to whichever works.
  //   3. Repopulate the swap router set (src/lib/swap.ts CFG.mainnet) once Uniswap v4 / Aerodrome / Curve are live.
  //   4. CCTP: confirm Arc is added to Circle's supported-chains table + its mainnet domain, then bridge (see cctp-bridge.mjs).
  // RPC honors VITE_ARC_RPC / VITE_ARC_RPC_BACKUP overrides, so a trusted endpoint can be swapped in without a code change.
  mainnet: { name: 'Arc', chainId: 5042, scan: 'https://explorer.arc.io', api: 'https://explorer.arc.io/api/v2', rpc: 'https://rpc.mainnet.arc.io' },
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
