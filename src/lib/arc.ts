// StateraArc — Arc chain data layer. Reads Blockscout's public API (no key, client-side).
// Flip NET to 'mainnet' when Arc mainnet + its explorer go live (Sept 16, 2026).
import { fetchWarpTokens, type Candle } from './warp';
import { keccak_256 } from '@noble/hashes/sha3';

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

// Mainnet-only app: wallet connect + all chain data target Arc mainnet (5042 / 0x13b2 / rpc.mainnet.arc.io).
// (testnet override kept behind an explicit env flag for local debugging, but the shipped default is mainnet.)
export const NET: Net = (import.meta.env.VITE_ARC_NET as Net) === 'testnet' ? 'testnet' : 'mainnet';
export const CHAIN = NETS[NET];

// Known launchpads / factories from our radar (deployers that minted many tokens).
export const LAUNCHPADS: Record<string, string> = {
  '0x95d262c8ab207a54c08569887177fa301e7f9687': 'Memepad',
  '0x34a0b64a88bbd4bf6acba8a0ff8f27c8add67e9c': 'LP factory',
  '0x1594f838177784f4fcba8f4082d3ca53aeb2672b': 'Launcher',
  '0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad': 'Curve factory',
};

// Our own token. Ecosystem membership is decided by ADDRESS (ECOSYSTEM_ADDRS), never a symbol regex — a
// regex on name/symbol tagged squatters ("Chelsea USDC", any *cir* meme) as Circle & Arc core.
export const OURS = new Set(['0xc8e1ffc83da48b347dd89a42a19fd510723f16bb']); // BRAINS

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
  createdAt?: number | null; // ms epoch the token was deployed (for "recent launches" sorting)
  volume24h?: number | null; // 24h USDC volume (RadarDEX aggregate)
  change5m?: number | null;  // 5m price change, percent
  change24h?: number | null; // 24h price change, percent (RadarDEX)
  change1h?: number | null;  // 1h price change, percent
  change6h?: number | null;  // 6h price change, percent
  fdv?: number | null;       // fully-diluted valuation
  source?: string | null;    // top DEX / pool version (e.g. Uni V3, WarpV2)
  pool?: string | null;      // on-chain: the token's V3 pool address (for live re-pricing)
  poolId?: string | null;    // on-chain: the token's V4 poolId (for live re-pricing)
  usdcIsC0?: boolean;        // on-chain: USDC is currency0/token0 in that pool
  decimals?: number;         // on-chain: token decimals (for live re-pricing)
  hooked?: boolean;          // on-chain: V4 pool has a hook (may charge a swap tax)
  txns24?: number | null;    // 24h transaction count
  spark?: number[] | null;   // sparkline price series (recent → last)
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
          fdv: (typeof t.fdv === 'number' && t.fdv > 0 && t.fdv <= 1e11) ? t.fdv : null,
          volume24h: t.volume24h ?? null, change5m: t.change5m ?? null, change1h: t.change1h ?? null,
          change6h: t.change6h ?? null, change24h: t.change24h ?? null, txns24: t.txns24 ?? null,
          source: t.source ?? null, spark: Array.isArray(t.spark) ? t.spark : null, createdAt: t.createdAt ?? null,
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
        isEcosystem: ECOSYSTEM_ADDRS.has(address), // by ADDRESS only — a symbol regex tagged "Chelsea USDC" etc. as core
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

// ── RadarDEX aggregator (api.radardex.pro via /api/radar proxy) ─────────────────────────────────
// The one source that indexes EVERY Arc launchpad + DEX (argus/tolly/long/dyor/o1/warp/…): 500 tokens
// with real token ICONS, price, mcap, liquidity, 24h volume, holders and deploy time — all in human
// USDC units (verified: TOLLY mcap $10.2M, WARP liq $39k). This is what powers the screener coverage,
// the "recent launches from all launchpads" card, and the logos everywhere.
const RADAR = '/api/radar';
async function radarGet(path: string): Promise<any> {
  // The proxy is resilient, but if a Cloudflare challenge ever slips through we get HTML, not JSON —
  // reject it (leading '<') and retry rather than throwing a parse error that blanks the UI.
  let lastErr: any = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${RADAR}${path}`, { headers: { accept: 'application/json' } });
      const text = await r.text();
      if (r.ok && text && text.trimStart()[0] !== '<') return JSON.parse(text);
      lastErr = new Error(`radar ${r.status}`);
    } catch (e) { lastErr = e; }
    await sleep(250 * (i + 1));
  }
  throw lastErr || new Error('radar unavailable');
}
const rnum = (v: any): number | null => (v == null || isNaN(Number(v)) ? null : Number(v));
// Unwrap Next.js image-optimizer URLs (e.g. arguspad.io/_next/image?url=<ipfs>&w=128) to the underlying
// image. Those optimizer endpoints rate-limit (HTTP 429) so the <img> fails and falls back to a letter
// tile; the wrapped source (IPFS/pinata) loads reliably. Applies to every launchpad's logos.
function normIcon(u: string | null | undefined): string | null {
  if (!u) return null;
  const m = u.match(/\/_next\/image\?url=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return u; } }
  return u;
}
// Launchpad display names (radar uses lowercase slugs). Falls back to a capitalized slug.
const RADAR_LP: Record<string, string> = {
  argus: 'Argus', tolly: 'Tolly', long: 'LONG', dyor: 'DYOR', o1: 'O1', warp: 'Warp',
  synthra: 'Synthra', ayoo: 'Ayoo', poolstrade: 'PoolsTrade', archemist: 'Archemist', noxa: 'Noxa',
  lotus: 'Lotus', arcfun: 'Arc.fun', arcorigin: 'ArcOrigin', basedpad: 'BasedPad', rwarc: 'RWArc',
  sharc: 'Sharc', pegd: 'PEGD', cusp: 'Cusp', klik: 'Klik', cambo: 'Cambo', dagg: 'Dagg',
};
export async function fetchRadarTokens(limit = 500): Promise<Token[]> {
  try {
    const j = await radarGet(`/tokens?limit=${limit}`);
    const arr: any[] = j.tokens || j || [];
    return arr.map((t): Token => {
      const lp = t.launchpad ? (RADAR_LP[t.launchpad] || (t.launchpad[0].toUpperCase() + t.launchpad.slice(1))) : null;
      const deploy = rnum(t.deployTs ?? t.firstSeen);
      return {
        address: (t.address || '').toLowerCase(), name: t.name || t.symbol || '?', symbol: t.symbol || '?',
        holders: t.holderCount != null ? Number(t.holderCount) : null, totalSupply: null, type: 'ERC-20',
        iconUrl: normIcon(t.icon), launchpad: lp, isOurs: false, isEcosystem: false,
        price: rnum(t.price), liq: rnum(t.liquidityUsdc), mcap: rnum(t.mcap),
        volume24h: rnum(t.volume24 ?? t.volume24hFixed), change24h: rnum(t.change24h),
        change1h: rnum(t.change1h), txns24: rnum(t.txns24),
        spark: Array.isArray(t.spark) ? t.spark.filter((n: any) => typeof n === 'number' && isFinite(n)) : null,
        createdAt: deploy != null ? deploy * 1000 : null,
      };
    }).filter((t) => /^0x[0-9a-f]{40}$/.test(t.address));
  } catch { return []; }
}

export interface RadarHolding { address: string; symbol: string; name: string; decimals: number; icon: string | null; price: number | null; amount: number; usd: number | null; }

// ⭐ PRIMARY portfolio source (09-19): our own /api/holdings endpoint reads the wallet's FULL bag straight
// from the chain (Transfer-log discovery + Multicall3 balanceOf across our 3 Arc RPCs) — not one indexer.
// explorer.arc.io is Cloudflare-walled and RadarDEX /portfolio only knows pooled tokens, so both dropped
// the nanocaps/airdrops a wallet actually holds. This returns them, native USDC included, priced on-chain.
export async function fetchHoldingsOnchain(addr: string): Promise<{ total: number | null; holdings: RadarHolding[] }> {
  try {
    // Cap the wait so a cold scan can never hang the "loading" indicator indefinitely — the VPS finishes
    // and caches in the background regardless, so a re-load lands the full bag fast.
    const j = await fetch(`/api/holdings?addr=${addr.toLowerCase()}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(105000) }).then((r) => r.json());
    if (!j || !Array.isArray(j.holdings)) return { total: null, holdings: [] };
    const holdings: RadarHolding[] = j.holdings.map((h: any) => ({
      address: (h.address || '').toLowerCase(), symbol: h.symbol || '?', name: h.name || h.symbol || '?',
      decimals: h.decimals ?? 18, icon: h.iconUrl ?? null, price: rnum(h.price),
      amount: Number(h.amount ?? 0), usd: rnum(h.usd),
    })).filter((h: RadarHolding) => h.address && h.amount > 0);
    return { total: rnum(j.total), holdings };
  } catch { return { total: null, holdings: [] }; }
}
// One-call wallet holdings with value + icons — makes the portfolio tracker instant (no on-chain scan).
export async function fetchRadarPortfolio(addr: string): Promise<{ total: number | null; holdings: RadarHolding[] }> {
  try {
    const j = await radarGet(`/portfolio/${addr.toLowerCase()}`);
    const holdings: RadarHolding[] = (Array.isArray(j.holdings) ? j.holdings : []).map((h: any) => ({
      address: (h.address || '').toLowerCase(), symbol: h.symbol || '?', name: h.name || h.symbol || '?',
      decimals: h.decimals ?? 18, icon: normIcon(h.icon), price: rnum(h.price),
      amount: Number(h.amount ?? h.balance ?? 0), usd: rnum(h.usd ?? h.value),
    })).filter((h: RadarHolding) => h.address && h.amount > 0);
    return { total: rnum(j.total), holdings };
  } catch { return { total: null, holdings: [] }; }
}

// One-call mainnet holdings from the OFFICIAL Arc explorer (Blockscout /token-balances). Returns EVERY
// token the wallet holds — balance, decimals, icon, and (where the explorer indexes it) price — in the
// same shape as fetchRadarPortfolio. RadarDEX's /portfolio proved unreliable (frequently returned only
// USDC and dropped the rest of the bag), so this explorer call is now the PRIMARY portfolio source.
export async function fetchPortfolioMainnet(addr: string): Promise<{ total: number | null; holdings: RadarHolding[] }> {
  try {
    const j = await req(`${CHAIN.api}/addresses/${addr.toLowerCase()}/token-balances`);
    const arr: any[] = Array.isArray(j) ? j : (j?.items || []);
    const holdings: RadarHolding[] = arr
      .filter((x: any) => !x?.token?.type || String(x.token.type).includes('ERC-20'))
      .map((x: any) => {
        const t = x.token || {};
        const decimals = Number(t.decimals || 18);
        const amount = Number(x.value || 0) / 10 ** decimals;
        const price = rnum(t.exchange_rate);
        return {
          address: addrOf(t.address_hash || t.address || '').toLowerCase(),
          symbol: t.symbol || '?', name: t.name || t.symbol || '?', decimals,
          icon: normIcon(t.icon_url), price, amount, usd: price != null ? amount * price : null,
        } as RadarHolding;
      })
      .filter((h: RadarHolding) => h.address && h.amount > 0)
      .sort((a: RadarHolding, b: RadarHolding) => (b.usd ?? 0) - (a.usd ?? 0) || b.amount - a.amount);
    const total = holdings.reduce((s, h) => s + (h.usd ?? 0), 0);
    return { total: holdings.some((h) => h.usd != null) ? total : null, holdings };
  } catch { return { total: null, holdings: [] }; }
}

// ── DEX-style token detail + holders (RadarDEX) ───────────────────────────────────────────────
export interface RadarPool { pool: string; version: string; dex: string | null; feeTier: number | null; quote: string; liquidityUsdc: number | null; volumeAll: number | null; swaps: number | null; }
export interface RadarTokenDetail {
  burnedPct: number | null; buys24: number | null; sells24: number | null; traders24: number | null;
  txns24: number | null; volume24: number | null; change5m: number | null; change1h: number | null;
  change6h: number | null; change24h: number | null; verified: boolean; deployer: string | null;
  bondingProgress: number | null; fdv: number | null; decimals: number; bestPool: string | null;
  website: string | null; twitter: string | null; telegram: string | null; discord: string | null;
  // Extended (for the pool-health / liquidity panels): pulled straight from the RadarDEX payload.
  ageSec: number | null; liquidityUsdc: number | null; mcap: number | null; totalSupply: number | null;
  mintable: boolean; poolCount: number; poolSwaps: number | null; quoteSymbol: string | null;
  reserveBase: number | null; reserveQuote: number | null; volume6h: number | null; volume1h: number | null;
  pools: RadarPool[]; liquidityTotal: number | null; // every pool + summed depth (per-pair breakdown)
  burnedSupply: number | null; circulating: number | null; reflection: boolean; lpTokenId: string | null;
}
export async function fetchRadarTokenDetail(addr: string): Promise<RadarTokenDetail | null> {
  try {
    const t = await radarGet(`/token/${addr.toLowerCase()}`);
    if (!t || !t.address) return null;
    const pools = Array.isArray(t.pools) ? t.pools : [];
    const bp = (t.bestPool ? pools.find((p: any) => (p.pool || '').toLowerCase() === String(t.bestPool).toLowerCase()) : null) || pools[0] || null;
    const dec = t.decimals ?? 18;
    // Pool reserves for the liquidity-depth panel: base = token side, quote = USDC/BRAINS side.
    const reserveQuote = bp ? (rnum(bp.liquidityUsdc) ?? (bp._reserveRaw != null ? Number(BigInt(bp._reserveRaw)) / 1e6 : null)) : null;
    const price = rnum(t.price);
    const reserveBase = reserveQuote != null && price ? reserveQuote / price : null; // tokens ≈ USDC depth / price
    // Full per-pool breakdown (all trading pairs) + aggregated depth across them.
    const poolList: RadarPool[] = pools.map((p: any) => ({
      pool: (p.pool || '').toLowerCase(),
      version: p.version || (p.hooks && p.hooks !== '0x0000000000000000000000000000000000000000' ? 'v4' : 'v3'),
      dex: p.dex || null, feeTier: rnum(p.feeTier), quote: (p.quoteToken || '').toLowerCase(),
      liquidityUsdc: rnum(p.liquidityUsdc) ?? (p._reserveRaw != null ? (() => { try { return Number(BigInt(p._reserveRaw)) / 1e6; } catch { return null; } })() : null),
      volumeAll: rnum(p.volumeAll), swaps: rnum(p.swaps),
    })).filter((p: RadarPool) => p.pool).sort((a: RadarPool, b: RadarPool) => (b.liquidityUsdc ?? 0) - (a.liquidityUsdc ?? 0));
    const liquidityTotal = poolList.length ? poolList.reduce((s, p) => s + (p.liquidityUsdc ?? 0), 0) : null;
    return {
      burnedPct: rnum(t.burnedPct), buys24: rnum(t.buys24), sells24: rnum(t.sells24), traders24: rnum(t.traders24),
      txns24: rnum(t.txns24), volume24: rnum(t.volume24), change5m: rnum(t.change5m), change1h: rnum(t.change1h),
      change6h: rnum(t.change6h), change24h: rnum(t.change24h), verified: !!t.verified, deployer: t.deployer || null,
      bondingProgress: rnum(t.bondingProgress), fdv: rnum(t.fdv), decimals: dec,
      bestPool: (t.bestPool || bp?.pool || null)?.toLowerCase?.() || null,
      website: t.website || null, twitter: t.twitter || null, telegram: t.telegram || null, discord: t.discord || null,
      ageSec: rnum(t.ageSec), liquidityUsdc: rnum(t.liquidityUsdc) ?? reserveQuote, mcap: rnum(t.mcap),
      totalSupply: t.totalSupply != null ? (() => { try { return Number(BigInt(t.totalSupply)) / 10 ** dec; } catch { return rnum(t.totalSupply); } })() : null,
      mintable: !!t.mintable, poolCount: pools.length, poolSwaps: bp ? rnum(bp.swaps) : null,
      quoteSymbol: t.quoteSymbol || (bp?.quoteToken === '0x3600000000000000000000000000000000000000' ? 'USDC' : null),
      reserveBase, reserveQuote, volume6h: rnum(t.volume6h), volume1h: rnum(t.volume1h),
      pools: poolList, liquidityTotal,
      burnedSupply: t.burnedSupply != null ? (() => { try { return Number(BigInt(t.burnedSupply)) / 10 ** dec; } catch { return null; } })() : null,
      circulating: (() => { const ts = t.totalSupply != null ? (() => { try { return Number(BigInt(t.totalSupply)) / 10 ** dec; } catch { return null; } })() : null; const bs = t.burnedSupply != null ? (() => { try { return Number(BigInt(t.burnedSupply)) / 10 ** dec; } catch { return null; } })() : null; return ts != null ? ts - (bs ?? 0) : null; })(),
      reflection: !!t.reflection, lpTokenId: t.lpTokenId != null ? String(t.lpTokenId) : null,
    };
  } catch { return null; }
}

// Real DEX trades for the token (RadarDEX indexes every swap): the Transactions table's live feed.
// side buy/sell, usd = trade value in USD, amount = token qty, price = execution price, trader = maker.
export interface RadarSwap { side: 'buy' | 'sell'; usd: number | null; amount: number; price: number | null; trader: string; tx: string; time: number; }
export async function fetchRadarSwaps(addr: string, decimals = 18, limit = 40): Promise<RadarSwap[]> {
  try {
    const j = await radarGet(`/token/${addr.toLowerCase()}/swaps?limit=${limit}`);
    const arr: any[] = Array.isArray(j.swaps) ? j.swaps : [];
    return arr.map((s) => ({
      side: (s.side === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
      usd: rnum(s.usdc), price: rnum(s.price),
      amount: (() => { const n = Number(s.token); return isFinite(n) ? n / 10 ** decimals : 0; })(),
      trader: (s.trader || '').toLowerCase(), tx: s.txHash || '', time: Number(s.time) || 0,
    })).filter((s) => s.tx);
  } catch { return []; }
}
export interface RadarHolder { rank: number; address: string; amount: number; percent: number | null; isPool: boolean; isDeployer: boolean; }
export async function fetchRadarHolders(addr: string, decimals = 18, limit = 50): Promise<{ holderCount: number | null; holders: RadarHolder[] }> {
  try {
    const j = await radarGet(`/token/${addr.toLowerCase()}/holders`);
    const arr: any[] = Array.isArray(j.holders) ? j.holders : [];
    const holders: RadarHolder[] = arr.slice(0, limit).map((h) => ({
      rank: Number(h.rank), address: (h.address || '').toLowerCase(),
      amount: (() => { try { return Number(BigInt(h.balance)) / 10 ** decimals; } catch { return Number(h.balance) / 10 ** decimals; } })(),
      percent: rnum(h.percent), isPool: !!h.isPool, isDeployer: !!h.isDeployer,
    })).filter((h) => h.address);
    return { holderCount: rnum(j.holderCount), holders };
  } catch { return { holderCount: null, holders: [] }; }
}

// ── Wallet P&L (cost basis reconstructed from on-chain swaps) ─────────────────────────────────────
// No indexer exposes per-wallet P&L, so we rebuild it: pull the wallet's txs (arc-scan), fetch each
// receipt, and in each one pair the token leg (to/from wallet) with its USDC counter-leg to classify a
// BUY (USDC out, token in) or SELL (token out, USDC in). ⚠️ USDC is emitted TWICE in a V3 swap — once as
// the native precompile 0xffff…fe (18-dec) and once as the 0x3600 ERC-20 (6-dec) for the SAME amount —
// so we take the 0x3600 leg when present, else the native, never both. Verified vs a known wallet 2026-09-16.
const ARCSCAN_REST = 'https://api.arc-scan.org/v1';
const NATIVE_USDC_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export interface TokenPnl { invested: number; qtyBought: number; proceeds: number; qtySold: number; avgCost: number | null; realized: number; }
export async function fetchWalletPnl(wallet: string, decimalsByToken: Record<string, number>, maxTxs = 160): Promise<Record<string, TokenPnl>> {
  const w = wallet.toLowerCase();
  // 1) the wallet's txs (skip approvals — no value legs), paginated via the arc-scan cursor.
  const hashes: string[] = [];
  let cursor = '';
  for (let p = 0; p < 3 && hashes.length < maxTxs; p++) {
    let j: any;
    try { j = await (await fetch(`${ARCSCAN_REST}/address/${w}/txs?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { headers: { accept: 'application/json' } })).json(); }
    catch { break; }
    for (const t of j.items || []) { if ((t.method?.name || '') !== 'approve') hashes.push(t.hash); }
    if (!j.page?.has_more) break;
    cursor = j.page?.next || ''; if (!cursor) break;
  }
  // 2) receipts → per-token buy/sell aggregates (bounded concurrency to respect RPC limits).
  const agg: Record<string, { cost: number; qb: number; proc: number; qs: number }> = {};
  await runLimited(hashes.map((h) => async () => {
    const rc = await mrpc('eth_getTransactionReceipt', [h]);
    if (!rc || !rc.logs) return;
    let u6o = 0, u6i = 0, uno = 0, uni = 0;
    const tin: Record<string, number> = {}, tout: Record<string, number> = {};
    for (const l of rc.logs) {
      const tp: string[] = l.topics || [];
      if (!tp[0] || tp[0].toLowerCase() !== TRANSFER_TOPIC || tp.length < 3) continue;
      const frm = ('0x' + tp[1].slice(-40)).toLowerCase(), to = ('0x' + tp[2].slice(-40)).toLowerCase();
      if (frm !== w && to !== w) continue;
      const a = l.address.toLowerCase();
      let raw: bigint; try { raw = BigInt(l.data); } catch { continue; }
      if (a === NATIVE_USDC_ADDR) { const v = Number(raw) / 1e6; if (frm === w) u6o += v; if (to === w) u6i += v; }
      else if (a === NATIVE_USDC_LOG) { const v = Number(raw) / 1e18; if (frm === w) uno += v; if (to === w) uni += v; }
      else { const d = decimalsByToken[a]; if (d == null) continue; const v = Number(raw) / 10 ** d; if (to === w) tin[a] = (tin[a] || 0) + v; if (frm === w) tout[a] = (tout[a] || 0) + v; }
    }
    const uo = u6o > 0 ? u6o : uno, ui = u6i > 0 ? u6i : uni; // 0x3600 leg preferred, else native — never both
    for (const a of new Set([...Object.keys(tin), ...Object.keys(tout)])) {
      const g = agg[a] || (agg[a] = { cost: 0, qb: 0, proc: 0, qs: 0 });
      if ((tin[a] || 0) > 0 && uo > 0) { g.cost += uo; g.qb += tin[a]; }
      else if ((tout[a] || 0) > 0 && ui > 0) { g.proc += ui; g.qs += tout[a]; }
    }
  }), 5);
  const out: Record<string, TokenPnl> = {};
  for (const [a, g] of Object.entries(agg)) {
    const avgCost = g.qb > 0 ? g.cost / g.qb : null;
    out[a] = { invested: g.cost, qtyBought: g.qb, proceeds: g.proc, qtySold: g.qs, avgCost, realized: avgCost != null ? g.proc - avgCost * g.qs : 0 };
  }
  return out;
}

// ── Wallet activity feed (arc-scan REST) — the connected wallet's recent transactions ─────────────
export interface WalletTx { hash: string; ts: number; method: string; value: number | null; symbol: string | null; status: boolean; to: string | null; from: string | null; }
export async function fetchAddressTxs(addr: string, limit = 12): Promise<WalletTx[]> {
  try {
    const r = await fetch(`https://api.arc-scan.org/v1/address/${addr.toLowerCase()}/txs`, { headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    const items: any[] = Array.isArray(j.items) ? j.items : [];
    return items.slice(0, limit).map((t): WalletTx => {
      const m = t.method || {}; const v = t.value || {};
      return {
        hash: t.hash, ts: t.timestamp ? Number(t.timestamp) * 1000 : 0,
        method: m.name || (m.is_creation ? 'deploy' : 'transfer'),
        value: v.formatted != null && isFinite(Number(v.formatted)) ? Number(v.formatted) : null,
        symbol: v.symbol || null,
        status: t.status === 'success' || t.status === true || t.status === 1,
        to: t.to?.address ?? null, from: t.from?.address ?? null,
      };
    }).filter((t) => t.hash);
  } catch { return []; }
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
// Clean, consistent price formatting: ~4 significant figures for sub-dollar prices (no long messy
// tails like $0.00609479), K/M for big ones. Keeps every row the same visual width on the screener.
// DEX-style USD price. Tiny prices use subscript-zero notation ($0.0₄994 = 0.0000994) instead of
// scientific ($9.94e-5), which reads far clearer. Subscript = count of leading zeros after the decimal.
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
const subDigits = (z: number) => String(z).split('').map((d) => SUBSCRIPTS[+d] || d).join('');
export const tprice = (n: number | null) => {
  if (n == null) return '—';
  if (!isFinite(n) || n <= 0) return '$0';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.001) return '$' + n.toFixed(4);
  // tiny: e.g. 0.00009940 -> $0.0₄994  (4 leading zeros compressed into the subscript, then sig figs)
  const s = n.toFixed(12);
  const m = s.match(/^0\.(0*)(\d+?)0*$/);
  if (!m) return '$' + n.toPrecision(3);
  const zeros = m[1].length;
  const sig = m[2].slice(0, 4);
  return zeros >= 4 ? `$0.0${subDigits(zeros)}${sig}` : `$0.${m[1]}${sig}`;
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
// Public Arc-mainnet RPCs, re-benchmarked 2026-09-17 (chainId 0x13b2 / latency / receipts / getLogs).
// Only nodes that reliably return HISTORICAL RECEIPTS (P&L needs them) are used — verified 3/3 on real
// txs:
//   • rpc.mainnet.arc.io       — official (~200ms), receipts ✓, getLogs ≤10k  → PRIMARY
//   • arc.drpc.org             — (~180ms), receipts ✓, getLogs ≤10k           → FALLBACK
//   • arc.gateway.tenderly.co  — (~240ms), receipts ✓, getLogs ≤20k results   → FALLBACK
//   ⛔ DROPPED arc-rpc.publicnode.com — fastest but load-balanced over PRUNED nodes: returned 0/3
//      historical receipts, which silently broke P&L. Keep it for the bots (fresh txs) but NOT here.
//   ⛔ dead/wrong-chain: 0xrpc.io/arc, blastapi, ankr.
// We rotate on timeout / 429 / 5xx / JSON-error (and a null receipt) so a slow/stale node fails over.
// A 7s per-try timeout keeps a hung node from blocking the whole call.
const MAINNET_RPCS = [
  (import.meta.env.VITE_ARC_MAINNET_RPC as string) || 'https://rpc.mainnet.arc.io',
  'https://arc.drpc.org',
  'https://arc.gateway.tenderly.co',
].filter((v, i, a) => v && a.indexOf(v) === i);
// Lowest common getLogs block-range across our RPCs (arc.io caps at 10k) — chunk to stay under it.
export const MRPC_LOG_RANGE = 9000;
async function mrpc(method: string, params: any[], tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const url = MAINNET_RPCS[i % MAINNET_RPCS.length];
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal }).finally(() => clearTimeout(to));
      if (r.status === 429 || r.status >= 500) { await sleep(150 * (i + 1) + Math.random() * 200); continue; }
      const j = await r.json();
      if (j.error) { await sleep(120 * (i + 1)); continue; } // method/range error on this node → try the next
      // A node that pruned a receipt returns null — don't accept it as the answer, try another node.
      if (j.result == null && method === 'eth_getTransactionReceipt' && i < tries - 1) { await sleep(120 * (i + 1)); continue; }
      return j.result;
    } catch { await sleep(150 * (i + 1)); }
  }
  return null;
}
// getLogs over a LARGE block range. rpc.mainnet.arc.io caps ranges at 10k, but tenderly & blockdaemon
// accept up to 100k — so a full chain-life pool scan is ~10 calls instead of ~95 (much faster ALL/1W).
// `seed` spreads the first attempt across both nodes so concurrent chunks don't all hammer one.
const BIG_RANGE_RPCS = ['https://arc.gateway.tenderly.co', 'https://rpc.blockdaemon.mainnet.arc.io'];
export const BIG_LOG_RANGE = 95000;
async function getLogsBig(params: any, seed = 0, tries = 4): Promise<any[] | null> {
  for (let i = 0; i < tries; i++) {
    const url = BIG_RANGE_RPCS[(i + seed) % BIG_RANGE_RPCS.length];
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [params] }), signal: ctrl.signal }).finally(() => clearTimeout(to));
      if (r.status === 429 || r.status >= 500) { await sleep(150 * (i + 1) + Math.random() * 200); continue; }
      const j = await r.json();
      if (j.error) { await sleep(120 * (i + 1)); continue; } // range/pruned error on this node → next node
      if (Array.isArray(j.result)) return j.result;
    } catch { await sleep(150 * (i + 1)); }
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
  }), 6);
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

// LIVE prices for the deep-pool tokens (Argus/Tolly/Long/CRCL… not on RadarDEX) straight from chain,
// for the screener's live overlay. V3 price = slot0 sqrtPriceX96 (⛔ NOT reserve ratio); V2 = reserves.
export async function fetchDeepPoolPrices(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const balOf = (token: string, who: string) => mCall(token, '0x70a08231000000000000000000000000' + who.slice(2).toLowerCase());
  await runLimited(Object.entries(MAINNET_POOL).map(([token, pool]) => async () => {
    const [slot0, t0] = await Promise.all([mCall(pool, '0x3850c7bd'), mCall(pool, '0x0dfe1681')]); // slot0(), token0()
    const usdcIsT0 = t0 ? ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR.toLowerCase() : false;
    let price: number | null = null;
    if (slot0 && slot0 !== '0x' && slot0.length >= 66) {
      try { const sqrtP = BigInt('0x' + slot0.slice(2, 66)); if (sqrtP > 0n) { const r = (Number(sqrtP) / 2 ** 96) ** 2; if (isFinite(r) && r > 0) price = (usdcIsT0 ? 1 / r : r) * 1e12; } } catch { /* skip */ }
    }
    if (price == null) { // V2 pool: reserve ratio
      const [uHex, bHex] = await Promise.all([balOf(NATIVE_USDC_ADDR, pool), balOf(token, pool)]);
      try { const u = Number(BigInt(uHex)) / 1e6, tk = Number(BigInt(bHex)) / 1e18; if (tk > 0) price = u / tk; } catch { /* skip */ }
    }
    if (price != null && isFinite(price) && price > 0) out[token] = price;
  }), 5);
  return out;
}
// Live price for a set of ON-CHAIN screener rows (V3 slot0 / V4 extsload), so the top rows aren't ~15 min
// stale between indexer bakes. Bounded to whatever list the caller passes (the visible top rows).
export async function fetchOnchainScreenerPrices(rows: { address: string; pool?: string | null; poolId?: string | null; usdcIsC0?: boolean; decimals?: number }[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await runLimited(rows.map((t) => async () => {
    const dexp = 10 ** ((t.decimals ?? 18) - 6);
    let price: number | null = null;
    if (t.poolId) { const sq = await v4Slot0Sqrt(t.poolId); if (sq != null && sq > 0n) { const r = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / r : r) * dexp; } }
    else if (t.pool) { const s0 = await mCall(t.pool, '0x3850c7bd').catch(() => null); if (s0 && s0.length >= 66) { try { const sq = BigInt(s0.slice(0, 66)); if (sq > 0n) { const r = (Number(sq) / 2 ** 96) ** 2; price = (t.usdcIsC0 ? 1 / r : r) * dexp; } } catch { /* */ } } }
    if (price != null && isFinite(price) && price > 0 && price < 1e6) out[t.address.toLowerCase()] = price;
  }), 8);
  return out;
}

// Combined price + USD liquidity + market cap for every tracked mainnet pool (one throttled pass).
// mcap = price × total supply (all these tokens are 18-dec).
async function mainnetStats(): Promise<Record<string, { price: number | null; liq: number | null; mcap: number | null }>> {
  const out: Record<string, { price: number | null; liq: number | null; mcap: number | null }> = {};
  const balOf = (token: string, who: string) => mCall(token, '0x70a08231000000000000000000000000' + who.slice(2).toLowerCase());
  await runLimited(Object.entries(MAINNET_POOL).map(([token, pool]) => async () => {
    const [uHex, bHex, supHex] = await Promise.all([balOf(NATIVE_USDC_ADDR, pool), balOf(token, pool), mCall(token, '0x18160ddd')]); // + totalSupply()
    if (!uHex || uHex === '0x') { out[token] = { price: null, liq: null, mcap: null }; return; }
    try {
      const usdc = Number(BigInt(uHex)) / 1e6;
      const toks = bHex && bHex !== '0x' ? Number(BigInt(bHex)) / 1e18 : 0;
      const price = toks > 0 ? usdc / toks : null;
      const supply = supHex && supHex !== '0x' ? Number(BigInt(supHex)) / 1e18 : null;
      out[token] = { price, liq: usdc * 2, mcap: price != null && supply ? price * supply : null };
    } catch { out[token] = { price: null, liq: null, mcap: null }; }
  }), 4);
  return out;
}

// CIRCLE & ARC CORE ecosystem assets — Circle's own infra on Arc, NOT third-party projects. USDC is the
// native gas token (added separately). Every address here is VERIFIED on-chain (name/symbol/decimals via
// arc-scan + eth_call) — never a symbol regex, which tagged squatters like "Chelsea USDC" as core.
// ⛔ Only list a token whose address is confirmed. cirETH / the ARC token have no pool yet + the explorer is
// Cloudflare-blocked, so they are pending the owner's addresses rather than a guess (a wrong address here
// would show a squatter's price as "core").
const ECOSYSTEM_TOKENS: { address: string; name: string; symbol: string; price: number | null; holders: number; decimals?: number }[] = [
  // All verified on Arc mainnet (arc-scan + Circle docs docs.arc.io/arc/references/contract-addresses).
  { address: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', name: 'Circle Wrapped Bitcoin', symbol: 'cirBTC', price: null, holders: 3826, decimals: 8 },
  { address: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', name: 'Wrapped Ether', symbol: 'WETH', price: null, holders: 822, decimals: 18 },   // Arc's canonical WETH (NOT 0xd02d, a different one)
  { address: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', name: 'EURC', symbol: 'EURC', price: null, holders: 4310, decimals: 6 },           // Circle euro stablecoin (official)
  { address: '0x8a5d989bbb96929f689b0200f435f53da42bf490', name: 'US Yield Coin', symbol: 'USYC', price: null, holders: 0, decimals: 6 },     // Circle yield token
];
// Ecosystem is decided by ADDRESS, never symbol — a fake "USDC" lookalike must NOT be tagged ECO.
const ECOSYSTEM_ADDRS = new Set<string>([NATIVE_USDC_ADDR.toLowerCase(), ...ECOSYSTEM_TOKENS.map((e) => e.address.toLowerCase())]);

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
  // Field-merge upsert. 'fill' (default) only fills fields the existing row is missing (keeps the first
  // real logo/mcap we saw); 'over' overwrites with any non-null incoming field (for the accurate
  // on-chain pool pass). Never wipes a real value to null. isEcosystem/isOurs are OR-ed (sticky true).
  const NEVER_NULL = new Set(['address', 'name', 'symbol', 'type']);
  const set = (t: Token, mode: 'fill' | 'over' = 'fill') => {
    const k = t.address.toLowerCase();
    const cur = map.get(k);
    if (!cur) { map.set(k, { ...t, address: k }); return; }
    const merged: any = { ...cur };
    for (const key of Object.keys(t) as (keyof Token)[]) {
      const nv = (t as any)[key];
      if (nv == null && !NEVER_NULL.has(key)) continue;
      if (mode === 'over' || (cur as any)[key] == null) merged[key] = nv;
    }
    merged.isEcosystem = cur.isEcosystem || t.isEcosystem;
    merged.isOurs = cur.isOurs || t.isOurs;
    map.set(k, merged);
  };

  // 1) USDC + Animus ecosystem
  set(mk({ address: NATIVE_USDC_ADDR, name: 'USD Coin', symbol: 'USDC', iconUrl: '/coins/USDC.svg', isEcosystem: true, price: 1 }));
  for (const e of ECOSYSTEM_TOKENS) set(mk({ address: e.address, name: e.name, symbol: e.symbol, holders: e.holders, isEcosystem: true, price: e.price }));

  // 2) RadarDEX aggregate — EVERY launchpad (500 tokens) with icons + price/mcap/liq/vol/holders/deployTs.
  //    This is the primary coverage + logo + market-cap source for the whole screener.
  try {
    for (const t of await fetchRadarTokens(500)) set(mk({ ...t, isEcosystem: ECOSYSTEM_ADDRS.has(t.address) }));
  } catch { /* radar optional */ }

  // 3) every Warp token (adds any Warp-only tokens + Warp's own image; fills gaps radar missed)
  try {
    const warp = await fetchWarpTokens('liquidity', 800);
    for (const w of warp) if (w.address) set(mk({
      address: w.address, name: w.name, symbol: w.ticker, holders: w.holders, iconUrl: w.image,
      launchpad: w.migrated ? null : 'Warp', isEcosystem: ECOSYSTEM_ADDRS.has(w.address.toLowerCase()),
      price: w.price, liq: w.liquidity, mcap: w.mcap, createdAt: w.createdAt ?? null, volume24h: w.volume24h ?? null, change24h: w.change24h ?? null,
    }));
  } catch { /* Warp optional */ }

  // 4) arc-scan holder snapshot — adds non-Warp tokens (holders known, price/liq land from pools if tracked)
  try { for (const t of await fetchPremainTokens()) set(t); } catch { /* snapshot optional */ }

  // 5) tracked deep pools — overwrite with accurate on-chain price + liquidity + market cap (the ones
  //    Radar/Warp may lag on). 'over' only replaces the price/liq/mcap fields we pass (non-null), so
  //    the radar icon/holders/launchpad/createdAt survive.
  const stats = await mainnetStats().catch(() => ({} as Record<string, { price: number | null; liq: number | null; mcap: number | null }>));
  for (const addr of Object.keys(MAINNET_POOL)) {
    const s = stats[addr]; if (!s) continue; const cur = map.get(addr); const m = coreMeta[addr];
    set(mk({
      address: addr, name: m?.name || cur?.name || addr.slice(0, 10), symbol: m?.symbol || cur?.symbol || '?',
      isEcosystem: ECOSYSTEM_ADDRS.has(addr),
      price: s.price, liq: s.liq, mcap: s.mcap,
    }), 'over');
  }
  return [...map.values()];
}

// SCREENER SOURCE OF TRUTH: the rich snapshot baked on the VPS (scripts/snapshot-mainnet.mjs) — one
// small file with price/liq/mcap/holders/change/volume/sparkline for EVERY token, including the deep
// V3 pools no indexer covers. The browser reads this instead of hammering live (Cloudflare-blockable)
// APIs, so the screener is complete + correct every load. Falls back to the live merge if it's missing.
export async function fetchScreenerTokens(): Promise<{ tokens: Token[]; asOf: number | null }> {
  try {
    const url = (import.meta.env.VITE_SNAPSHOT_URL as string) || '/tokens-snapshot.json';
    const r = await fetch(url, { cache: 'default' });
    if (r.ok) {
      const snap = await r.json();
      if (snap && Array.isArray(snap.tokens) && snap.tokens.length) {
        const tokens = snap.tokens.map((t: any): Token => ({
          address: t.address, name: t.name, symbol: t.symbol,
          holders: t.holders ?? null, totalSupply: null, type: 'ERC-20',
          iconUrl: normIcon(t.iconUrl) ?? null, launchpad: t.launchpad ?? null,
          isOurs: !!t.isOurs, isEcosystem: !!t.isEcosystem,
          price: rnum(t.price), liq: rnum(t.liq), mcap: rnum(t.mcap),
          volume24h: rnum(t.volume24h), change24h: rnum(t.change24h), change1h: rnum(t.change1h),
          txns24: rnum(t.txns24), spark: Array.isArray(t.spark) ? t.spark.filter((n: any) => typeof n === 'number' && isFinite(n)) : null,
          createdAt: rnum(t.createdAt), source: t.source ?? null,
          pool: t.pool ?? null, poolId: t.poolId ?? null, usdcIsC0: !!t.usdcIsC0, decimals: t.decimals ?? 18, hooked: !!t.hooked,
        }));
        const asOf = snap.generatedAt ? Date.parse(snap.generatedAt) : null;
        return { tokens, asOf: Number.isFinite(asOf) ? asOf : null };
      }
    }
  } catch { /* fall through to the live merge */ }
  return { tokens: await fetchMainnetTokens(), asOf: null };
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
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'; // Uniswap V3
const SWAP_V2_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'; // Uniswap V2 (ARCAT etc.)
// ── Uniswap V4 (hooked pools on the PoolManager SINGLETON) ─────────────────────────────────────────
// V4 has no per-pool address: a pool is a KEY hashed to a poolId, and ALL pools emit from one singleton.
// Launchpad tokens (potato.fm / "Argus pad" — GLITCH etc.) launch as V4-only, so V3/V2 discovery finds
// nothing and their token page was blank. We find the pool by scanning Initialize, price it via extsload,
// and chart it from the singleton's Swap events filtered by poolId. ⛔ Anyone can open a decoy pool for the
// same pair (GLITCH had 11); the REAL one is the one with actual swap volume, so we pick by swap count.
const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const V4_INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const V4_SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const v4HexToU8 = (h: string) => { h = h.replace(/^0x/, ''); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
// state lives at _pools[poolId] (mapping slot 6); slot0 (sqrtPriceX96 in low 160 bits) is its base slot.
const v4StateSlot = (poolId: string) => '0x' + Array.from(keccak_256(v4HexToU8(poolId.replace(/^0x/, '').padStart(64, '0') + (6).toString(16).padStart(64, '0')))).map((b) => b.toString(16).padStart(2, '0')).join('');
export interface V4Pool { poolId: string; usdcIsC0: boolean; }
const v4PoolCache = new Map<string, V4Pool | null>();
export async function findV4Pool(token: string): Promise<V4Pool | null> {
  const t = token.toLowerCase();
  if (v4PoolCache.has(t)) return v4PoolCache.get(t)!;
  const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
  const headHex = await mrpc('eth_blockNumber', []); if (!headHex) return null; // don't cache a transient failure
  const head = BigInt(headHex);
  const CH = BigInt(BIG_LOG_RANGE);
  const ranges: [bigint, bigint][] = [];
  for (let f = head - 900000n; f < head; f += CH) ranges.push([f, f + CH > head ? head : f + CH]);
  const found = new Map<string, { c0: string; c1: string }>();
  for (const idx of [2, 3]) { // token can be currency0 (topic2) or currency1 (topic3)
    const topics: (string | null)[] = [V4_INIT_TOPIC, null, null, null];
    topics[idx] = '0x' + pad(t);
    const res = await runLimited(ranges.map(([f, to], i) => () => getLogsBig({ address: PM_V4, topics, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }, i)), 10);
    for (const logs of res) if (Array.isArray(logs)) for (const l of logs) {
      const c0 = ('0x' + l.topics[2].slice(26)).toLowerCase(), c1 = ('0x' + l.topics[3].slice(26)).toLowerCase();
      found.set(l.topics[1], { c0, c1 });
    }
  }
  const cands = [...found.entries()].filter(([, v]) => v.c0 === NATIVE_USDC_ADDR || v.c1 === NATIVE_USDC_ADDR);
  if (!cands.length) { v4PoolCache.set(t, null); return null; }
  // Pick the pool with real swap volume (decoys have ~none).
  const counts = await runLimited(cands.map(([pid]) => async () => {
    const sw = await getLogsBig({ address: PM_V4, topics: [V4_SWAP_TOPIC, pid], fromBlock: '0x' + (head - 95000n).toString(16), toBlock: '0x' + head.toString(16) }).catch(() => null);
    return Array.isArray(sw) ? sw.length : 0;
  }), 8);
  let best = -1, bestI = -1;
  counts.forEach((c, i) => { if (c > best) { best = c; bestI = i; } });
  if (bestI < 0 || best <= 0) { v4PoolCache.set(t, null); return null; }
  const [poolId, v] = cands[bestI];
  const pool: V4Pool = { poolId, usdcIsC0: v.c0 === NATIVE_USDC_ADDR };
  v4PoolCache.set(t, pool);
  return pool;
}
// Curated actively-traded V4 launchpad tokens (potato.fm / "Argus pad") that NO aggregator indexes.
// Until the chain-wide V4 discovery bake lands (28k candidate pools, mostly decoys → must filter to real
// volume), these are added to the screener by hand so they're findable/searchable. Priced + supply on-chain.
const CURATED_V4: { address: string; symbol: string; name: string; launchpad?: string; poolId: string; usdcIsC0: boolean }[] = [
  { address: '0x08adbf431569a1aacac2606d2adcd18f4ebf2a71', symbol: 'GLITCH', name: 'Glitch', launchpad: 'potato',
    poolId: '0x278eab5f794ccbaa85dd7cd275e56bf563d8d26e35fd717800f39340f9730c3a', usdcIsC0: false },
];
export async function fetchCuratedV4Tokens(): Promise<Token[]> {
  const out: Token[] = [];
  await Promise.all(CURATED_V4.map(async (c) => {
    try {
      const v4: V4Pool = { poolId: c.poolId, usdcIsC0: c.usdcIsC0 }; // known — skip the discovery scan (fast+reliable)
      const dec = 18; // launchpad coins are 18-dec
      const [price, supHex] = await Promise.all([
        v4PriceOf(v4.poolId, v4.usdcIsC0, dec),
        mCall(c.address, '0x18160ddd').catch(() => null), // totalSupply()
      ]);
      let supply: number | null = null; try { if (supHex && supHex !== '0x') supply = Number(BigInt(supHex)) / 10 ** dec; } catch { /* */ }
      const mcap = price != null && supply ? price * supply : null;
      out.push({ address: c.address.toLowerCase(), name: c.name, symbol: c.symbol, holders: null, totalSupply: null,
        type: 'ERC-20', iconUrl: null, launchpad: c.launchpad ?? null, isOurs: false, isEcosystem: false,
        price, liq: null, mcap: mcap && mcap <= 1e10 ? mcap : null, fdv: mcap && mcap <= 1e11 ? mcap : null,
        volume24h: null, change5m: null, change1h: null, change6h: null, change24h: null, txns24: null,
        // carry the pool so the token page primes the cache → no slow discovery scan
        poolId: c.poolId, usdcIsC0: c.usdcIsC0, decimals: dec,
        source: 'V4', spark: null, createdAt: null });
    } catch { /* */ }
  }));
  return out;
}
// Official Uniswap V4 read contract (docs.arc.io/arc/references/contract-addresses). getSlot0(bytes32)=0xc815641c
// returns (uint160 sqrtPriceX96, int24 tick, ...). Verified bit-identical to the extsload path on GLITCH +
// ARGUS pools — but via the canonical contract, so we read the SAME slot the protocol reads. Falls back to
// the hand-rolled extsload if StateView reverts / an RPC lacks it, so this can only match or beat the old read.
const V4_STATEVIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
async function v4Slot0Sqrt(poolId: string): Promise<bigint | null> {
  const sv = await mCall(V4_STATEVIEW, '0xc815641c' + poolId.replace(/^0x/, '').padStart(64, '0')).catch(() => null);
  if (sv && sv !== '0x') { try { const sq = BigInt('0x' + sv.slice(2, 66)) & ((1n << 160n) - 1n); if (sq > 0n) return sq; } catch { /* fall through to extsload */ } }
  const s0 = await mCall(PM_V4, '0x1e2eaeaf' + v4StateSlot(poolId).slice(2)).catch(() => null);
  if (!s0 || s0 === '0x') return null;
  try { const sq = BigInt(s0) & ((1n << 160n) - 1n); return sq > 0n ? sq : null; } catch { return null; }
}
// USD-per-token from the V4 pool's live sqrtPriceX96 (StateView, extsload fallback).
async function v4PriceOf(poolId: string, usdcIsC0: boolean, decimals: number): Promise<number | null> {
  const sqrtP = await v4Slot0Sqrt(poolId);
  if (sqrtP == null || sqrtP <= 0n) return null;
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2; const dexp = 10 ** (decimals - 6);
  const price = (usdcIsC0 ? 1 / ratio : ratio) * dexp;
  return isFinite(price) && price > 0 ? price : null;
}
// Timestamped prices from a V4 pool's Swap events (singleton, filtered by poolId). sqrtPriceX96 = word 2.
async function scanV4Swaps(v4: V4Pool, decimals: number, spanCap: number): Promise<{ ts: number; price: number }[]> {
  const headHex = await mrpc('eth_blockNumber', []); if (!headHex) return [];
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const dexp = 10 ** (decimals - 6);
  const CH = BigInt(BIG_LOG_RANGE);
  const ranges: [bigint, bigint][] = [];
  for (let from = head - BigInt(spanCap); from < head; from += CH) ranges.push([from, from + CH > head ? head : from + CH]);
  const results = await runLimited(ranges.map(([from, to], idx) => () =>
    getLogsBig({ address: PM_V4, topics: [V4_SWAP_TOPIC, v4.poolId], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }, idx)), 10);
  const swaps: { ts: number; price: number }[] = [];
  for (const logs of results) {
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const sqrtP = BigInt('0x' + l.data.slice(2).slice(128, 192)); // word 2 = sqrtPriceX96
      if (sqrtP <= 0n) continue;
      const ratio = (Number(sqrtP) / 2 ** 96) ** 2;
      const price = (v4.usdcIsC0 ? 1 / ratio : ratio) * dexp;
      if (!isFinite(price) || price <= 0) continue;
      swaps.push({ ts: Math.round(headTs - Number(head - BigInt(l.blockNumber)) * blockTime), price });
    }
  }
  swaps.sort((a, b) => a.ts - b.ts);
  return swaps;
}
// Decode a Swap log to { usdcAbs, tokAbs } (raw units) for BOTH V3 (signed amount0/amount1) and V2
// (amount0In/1In/0Out/1Out). Pools that aren't V3 (ARCAT…) were silently charting empty before this.
function decodeSwap(dataHex: string, topic0: string, usdcIsToken0: boolean): { usdc: bigint; tok: bigint } | null {
  try {
    const d = dataHex.slice(2);
    const w = (i: number) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
    if ((topic0 || '').toLowerCase() === SWAP_V2_TOPIC) {
      const a0 = w(0) + w(2), a1 = w(1) + w(3);
      return { usdc: usdcIsToken0 ? a0 : a1, tok: usdcIsToken0 ? a1 : a0 };
    }
    const s0 = w(0) >= (1n << 255n) ? w(0) - (1n << 256n) : w(0);
    const s1 = w(1) >= (1n << 255n) ? w(1) - (1n << 256n) : w(1);
    const ur = usdcIsToken0 ? s0 : s1, tr = usdcIsToken0 ? s1 : s0;
    return { usdc: ur < 0n ? -ur : ur, tok: tr < 0n ? -tr : tr };
  } catch { return null; }
}
// Arc DEX factories (discovered on-chain). getPool/getPair let us find ANY token's USDC pool instead of
// relying on a hardcoded list — so charts/volume work for every token that trades on Uniswap V3 or V2.
const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
const V2_FACTORY = '0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const poolDiscovery = new Map<string, string | null>();
// Prime the pool caches from the screener snapshot (which already knows each on-chain token's pool), so
// the token page's price/chart/reserves/trades/vol DON'T each run the slow ~900k-block discovery scan.
// A V4-only token also gets its V3 discovery short-circuited to null so findTokenPool returns instantly.
export function primePool(token: string, seed: { pool?: string | null; poolId?: string | null; usdcIsC0?: boolean }): void {
  const t = token.toLowerCase();
  if (seed.poolId) { v4PoolCache.set(t, { poolId: seed.poolId, usdcIsC0: !!seed.usdcIsC0 }); if (!seed.pool) poolDiscovery.set(t, null); }
  if (seed.pool) poolDiscovery.set(t, seed.pool.toLowerCase());
}
// Find a token's deepest USDC pool (V3 any fee tier, or V2). Curated deep pools win; result cached.
export async function findTokenPool(token: string): Promise<string | null> {
  const t = token.toLowerCase();
  if (MAINNET_POOL[t]) return MAINNET_POOL[t];
  if (poolDiscovery.has(t)) return poolDiscovery.get(t)!;
  const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
  // USDC on Arc is the NATIVE gas token (0x3600). balanceOf() on it reads only ERC-20 dust — the real
  // pool USDC is the native balance, so measure depth with eth_getBalance (18-dec). Using balanceOf here
  // made us pick a token's tiny stale pool over its real deep one (e.g. ARGUS: $113 pool vs the $547K one).
  const usdcOf = async (p: string) => { const b = await mrpc('eth_getBalance', [p, 'latest']).catch(() => null); try { return b ? Number(BigInt(b)) / 1e18 : 0; } catch { return 0; } };
  let best: string | null = null, bestUsdc = -1;
  const candidates = await Promise.all([
    ...[100, 500, 3000, 10000].map((fee) => mCall(V3_FACTORY, '0x1698ee82' + pad(t) + pad(NATIVE_USDC_ADDR) + fee.toString(16).padStart(64, '0')).catch(() => null)),
    mCall(V2_FACTORY, '0xe6a43905' + pad(t) + pad(NATIVE_USDC_ADDR)).catch(() => null),
  ]);
  for (const r of candidates) {
    const p = r && r.length >= 42 ? ('0x' + r.slice(-40)).toLowerCase() : null;
    if (!p || p === ZERO_ADDR) continue;
    const usdc = await usdcOf(p);
    if (usdc > bestUsdc) { bestUsdc = usdc; best = p; }
  }
  poolDiscovery.set(t, best);
  return best;
}
// Real pool reserves for tokens RadarDEX doesn't index (ARGUS…), so the Liquidity & Pool panel still
// fills in. reserveQuote = the pool's USDC balance (RadarDEX calls this same number both Liq and TVL);
// reserveBase = the pool's token balance. Cached briefly.
const poolStatsCache = new Map<string, { at: number; v: { tvl: number | null; reserveQuote: number | null; reserveBase: number | null; pool: string | null; price: number | null } }>();
export async function fetchOnchainPoolStats(token: string, decimals = 18): Promise<{ tvl: number | null; reserveQuote: number | null; reserveBase: number | null; pool: string | null; price: number | null }> {
  const ck = token.toLowerCase();
  const hit = poolStatsCache.get(ck); if (hit && Date.now() - hit.at < 45000) return hit.v;
  const empty = { tvl: null, reserveQuote: null, reserveBase: null, pool: null, price: null };
  const pool = await findTokenPool(token);
  if (!pool) {
    // No V3/V2 pool — try a V4 pool (launchpad coins). Price via extsload; V4 liquidity is shared across
    // the singleton so exact TVL isn't readable per-pool — the token side (PM's balance) is the honest
    // reserve we can show. This makes a V4-only token's page price + reserves populate.
    const v4 = await findV4Pool(token);
    if (v4) {
      const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
      const [price, tokB] = await Promise.all([
        v4PriceOf(v4.poolId, v4.usdcIsC0, decimals),
        mCall(token, '0x70a08231' + pad(PM_V4)).catch(() => null),
      ]);
      let reserveBase: number | null = null; try { if (tokB) reserveBase = Number(BigInt(tokB)) / 10 ** decimals; } catch { /* */ }
      const tvl = reserveBase != null && price != null ? reserveBase * price : null; // token-side value (one side)
      const v = { tvl, reserveQuote: null, reserveBase, pool: null, price };
      poolStatsCache.set(ck, { at: Date.now(), v });
      return v;
    }
    poolStatsCache.set(ck, { at: Date.now(), v: empty }); return empty;
  }
  const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
  // USDC is Arc's NATIVE gas token — its pool balance is the native balance (eth_getBalance, 18-dec),
  // NOT balanceOf() on 0x3600 (which reads only dust). balanceOf here reported ~$0 for real pools.
  const [usdcB, tokB] = await Promise.all([
    mrpc('eth_getBalance', [pool, 'latest']).catch(() => null),
    mCall(token, '0x70a08231' + pad(pool)).catch(() => null),
  ]);
  let reserveQuote: number | null = null, reserveBase: number | null = null;
  try { if (usdcB) reserveQuote = Number(BigInt(usdcB)) / 1e18; } catch { /* */ }
  try { if (tokB) reserveBase = Number(BigInt(tokB)) / 10 ** decimals; } catch { /* */ }
  // Prefer the V3 slot0 mid-price (accurate on concentrated pools); fall back to the reserve ratio (V2).
  let price: number | null = null;
  const s0 = await mCall(pool, '0x3850c7bd').catch(() => null); // slot0()
  if (s0 && s0.length >= 66) { try { const t0 = await mCall(pool, '0x0dfe1681').catch(() => null); const usdcIsToken0 = t0 ? ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR : false; const sqrtP = BigInt(s0.slice(0, 66)); if (sqrtP > 0n) { const ratio = (Number(sqrtP) / 2 ** 96) ** 2; const p = (usdcIsToken0 ? 1 / ratio : ratio) * 10 ** (decimals - 6); if (isFinite(p) && p > 0) price = p; } } catch { /* */ } }
  if (price == null && reserveQuote != null && reserveBase) price = reserveQuote / reserveBase;
  const v = { tvl: reserveQuote, reserveQuote, reserveBase, pool, price };
  poolStatsCache.set(ck, { at: Date.now(), v });
  return v;
}
// All USDC pools for a token, discovered ON-CHAIN (V3 fee tiers + V2), with real depth/price. Used to
// fill the Pools breakdown for tokens no aggregator indexes (WARP tokens like ARGUS). Depth is measured
// with eth_getBalance because USDC is Arc's native gas token (balanceOf reads dust).
export interface OnchainPool { pool: string; version: string; feeTier: number | null; quote: string; liquidityUsdc: number | null; price: number | null; tokenReserve: number | null; usdcReserve: number | null; }
const allPoolsCache = new Map<string, { at: number; v: OnchainPool[] }>();
export async function fetchAllOnchainPools(token: string, decimals = 18): Promise<OnchainPool[]> {
  const t = token.toLowerCase();
  const hit = allPoolsCache.get(t); if (hit && Date.now() - hit.at < 60000) return hit.v;
  const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
  const fees = [100, 500, 3000, 10000];
  const [v3, v2] = await Promise.all([
    Promise.all(fees.map((f) => mCall(V3_FACTORY, '0x1698ee82' + pad(t) + pad(NATIVE_USDC_ADDR) + f.toString(16).padStart(64, '0')).catch(() => null))),
    mCall(V2_FACTORY, '0xe6a43905' + pad(t) + pad(NATIVE_USDC_ADDR)).catch(() => null),
  ]);
  const found: { pool: string; version: string; feeTier: number | null }[] = [];
  v3.forEach((r, i) => { const p = r && r.length >= 42 ? ('0x' + r.slice(-40)).toLowerCase() : null; if (p && p !== ZERO_ADDR) found.push({ pool: p, version: 'V3', feeTier: fees[i] }); });
  { const p = v2 && v2.length >= 42 ? ('0x' + v2.slice(-40)).toLowerCase() : null; if (p && p !== ZERO_ADDR) found.push({ pool: p, version: 'V2', feeTier: null }); }
  const dexp = 10 ** (decimals - 6);
  const out = await Promise.all(found.map(async (f): Promise<OnchainPool> => {
    const [natB, tokB, t0] = await Promise.all([
      mrpc('eth_getBalance', [f.pool, 'latest']).catch(() => null),
      mCall(token, '0x70a08231' + pad(f.pool)).catch(() => null),
      mCall(f.pool, '0x0dfe1681').catch(() => null), // token0()
    ]);
    let usdc: number | null = null, tokRes: number | null = null;
    try { if (natB) usdc = Number(BigInt(natB)) / 1e18; } catch { /* */ }
    try { if (tokB) tokRes = Number(BigInt(tokB)) / 10 ** decimals; } catch { /* */ }
    const usdcIsToken0 = t0 ? ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR : false;
    let price: number | null = null;
    if (f.version === 'V3') {
      const slot0 = await mCall(f.pool, '0x3850c7bd').catch(() => null); // slot0(): sqrtPriceX96 in word 0
      if (slot0 && slot0.length >= 66) { try { const sqrtP = BigInt(slot0.slice(0, 66)); if (sqrtP > 0n) { const ratio = (Number(sqrtP) / 2 ** 96) ** 2; price = (usdcIsToken0 ? 1 / ratio : ratio) * dexp; } } catch { /* */ } }
    } else if (usdc != null && tokRes) { price = usdc / tokRes; }
    if (price != null && (!isFinite(price) || price <= 0)) price = null;
    const liquidityUsdc = usdc != null ? usdc + (tokRes != null && price != null ? tokRes * price : 0) : null;
    return { pool: f.pool, version: f.version, feeTier: f.feeTier, quote: 'USDC', liquidityUsdc, price, tokenReserve: tokRes, usdcReserve: usdc };
  }));
  const pools = out.filter((p) => p.liquidityUsdc != null && p.liquidityUsdc > 1).sort((a, b) => (b.liquidityUsdc || 0) - (a.liquidityUsdc || 0));
  // ALWAYS surface the token's real V4 pool alongside any V3/V2 pools — a coin can trade on several pool
  // types at once and the card must show them all. (V4 USDC is pooled in the shared singleton, so we value
  // the pool by its token side; the decoy V4 pools are already filtered out by findV4Pool's volume check.)
  const v4 = await findV4Pool(token);
  if (v4) {
    const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
    const [price, tokB] = await Promise.all([v4PriceOf(v4.poolId, v4.usdcIsC0, decimals), mCall(token, '0x70a08231' + pad(PM_V4)).catch(() => null)]);
    let tokRes: number | null = null; try { if (tokB) tokRes = Number(BigInt(tokB)) / 10 ** decimals; } catch { /* */ }
    const liq = tokRes != null && price != null ? tokRes * price : null;
    pools.push({ pool: v4.poolId, version: 'V4', feeTier: null, quote: 'USDC', liquidityUsdc: liq, price, tokenReserve: tokRes, usdcReserve: null });
  }
  pools.sort((a, b) => (b.liquidityUsdc || 0) - (a.liquidityUsdc || 0));
  allPoolsCache.set(t, { at: Date.now(), v: pools });
  return pools;
}
// Raw pool swaps cached per (token, scan-window). The wide timeframes (4H/1D/1W/ALL) all scan the SAME
// ~900k-block window and differ only in bucket size — so we scan ONCE, cache the raw {ts,price} swaps,
// and re-bucket for each timeframe. That makes every wide-TF click after the first INSTANT (no re-scan).
const swapsCache = new Map<string, { at: number; swaps: { ts: number; price: number }[] }>();
async function scanPoolSwaps(token: string, decimals: number, spanCap: number): Promise<{ ts: number; price: number }[]> {
  const t = token.toLowerCase();
  const sk = t + ':' + spanCap;
  const cached = swapsCache.get(sk);
  if (cached && Date.now() - cached.at < 60000) return cached.swaps; // 60s — covers a whole TF-toggle session
  const pool = await findTokenPool(token);
  // V4-only tokens (launchpad coins like GLITCH) have no V3/V2 pool — chart them from the singleton's Swap
  // events filtered by poolId. sqrtPriceX96 is the 3rd data word, same as V3.
  if (!pool) {
    const v4 = await findV4Pool(token); if (!v4) return [];
    const swaps = await scanV4Swaps(v4, decimals, spanCap);
    swapsCache.set(sk, { at: Date.now(), swaps });
    return swaps;
  }
  const [t0hex, headHex] = await Promise.all([mCall(pool, '0x0dfe1681'), mrpc('eth_blockNumber', [])]); // token0(), head
  if (!t0hex || !headHex) return [];
  const usdcIsToken0 = ('0x' + t0hex.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR.toLowerCase();
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const dexp = 10 ** (decimals - 6); // USDC is 6-dec, the token `decimals`-dec
  // tenderly/blockdaemon accept 100k-block ranges (pool-filtered → few results) so 95k chunks keep a
  // full ~4-day scan to ~10 calls.
  const CH = BigInt(BIG_LOG_RANGE);
  const ranges: [bigint, bigint][] = [];
  for (let from = head - BigInt(spanCap); from < head; from += CH) ranges.push([from, from + CH > head ? head : from + CH]);
  const results = await runLimited(ranges.map(([from, to], idx) => () =>
    getLogsBig({ address: pool, topics: [[SWAP_TOPIC, SWAP_V2_TOPIC]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }, idx)), 10);
  const swaps: { ts: number; price: number }[] = [];
  for (const logs of results) {
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const topic = (l.topics?.[0] || '').toLowerCase();
      let price: number;
      if (topic === SWAP_V2_TOPIC) {
        const dec = decodeSwap(l.data, topic, usdcIsToken0);
        if (!dec || dec.tok <= 0n) continue;
        price = (Number(dec.usdc) / Number(dec.tok)) * dexp;
      } else {
        const sqrtP = BigInt('0x' + l.data.slice(2).slice(128, 192));
        if (sqrtP <= 0n) continue;
        const ratio = (Number(sqrtP) / 2 ** 96) ** 2; // token1_raw / token0_raw
        if (!isFinite(ratio) || ratio <= 0) continue;
        price = (usdcIsToken0 ? 1 / ratio : ratio) * dexp;
      }
      if (!isFinite(price) || price <= 0) continue;
      swaps.push({ ts: Math.round(headTs - Number(head - BigInt(l.blockNumber)) * blockTime), price });
    }
  }
  swaps.sort((a, b) => a.ts - b.ts);
  swapsCache.set(sk, { at: Date.now(), swaps });
  return swaps;
}
// 24h change % + 24h USD volume computed straight from a token's own pool swaps (V3/V2/V4) — for coins no
// indexer covers (GLITCH etc.), so the header's 24H and VOL 24H fill instead of showing "—". Bounded: it
// scans only THIS pool's swaps (poolId/address-filtered), not the whole chain. Cached 60s.
const dayStatsCache = new Map<string, { at: number; v: { change24h: number | null; volume24h: number | null; buys24: number | null; sells24: number | null; txns24: number | null; makers24: number | null } }>();
export async function fetchOnchainDayStats(token: string, decimals = 18): Promise<{ change24h: number | null; volume24h: number | null; buys24: number | null; sells24: number | null; txns24: number | null; makers24: number | null }> {
  const t = token.toLowerCase();
  const hit = dayStatsCache.get(t); if (hit && Date.now() - hit.at < 60000) return hit.v;
  const empty = { change24h: null, volume24h: null, buys24: null, sells24: null, txns24: null, makers24: null };
  const headHex = await mrpc('eth_blockNumber', []); if (!headHex) return empty;
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const blocks24 = Math.min(400000, Math.ceil(86400 / blockTime));
  const dexp = 10 ** (decimals - 6);
  const pool = await findTokenPool(token);
  const v4 = pool ? null : await findV4Pool(token);
  if (!pool && !v4) return empty;
  const CH = BigInt(BIG_LOG_RANGE);
  const ranges: [bigint, bigint][] = [];
  for (let f = head - BigInt(blocks24); f < head; f += CH) ranges.push([f, f + CH > head ? head : f + CH]);
  const spec = pool ? { address: pool, topics: [[SWAP_TOPIC, SWAP_V2_TOPIC]] as any } : { address: PM_V4, topics: [V4_SWAP_TOPIC, v4!.poolId] as any };
  const results = await runLimited(ranges.map(([f, to], i) => () => getLogsBig({ ...spec, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }, i)), 8);
  // Each swap carries its side + tx hash so the panel can show the TRUE 24h buy/sell/txn split (not a
  // last-40-trades sample, which on a fast pump read "0 sells" over a 5-minute window).
  const pts: { ts: number; price: number; usd: number; side: 'buy' | 'sell'; tx: string }[] = [];
  let usdcIsToken0 = false;
  if (pool) { const t0 = await mCall(pool, '0x0dfe1681').catch(() => null); usdcIsToken0 = t0 ? ('0x' + t0.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR : false; }
  for (const logs of results) {
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const ts = Math.round(headTs - Number(head - BigInt(l.blockNumber)) * blockTime);
      const tx = l.transactionHash || '';
      if (v4) {
        const d = l.data.slice(2);
        const sqrtP = BigInt('0x' + d.slice(128, 192)); if (sqrtP <= 0n) continue;
        const ratio = (Number(sqrtP) / 2 ** 96) ** 2; const price = (v4.usdcIsC0 ? 1 / ratio : ratio) * dexp;
        let tokAmt = BigInt('0x' + d.slice((v4.usdcIsC0 ? 1 : 0) * 64, (v4.usdcIsC0 ? 1 : 0) * 64 + 64)); if (tokAmt >= (1n << 255n)) tokAmt -= (1n << 256n);
        if (tokAmt === 0n) continue;
        const amount = Math.abs(Number(tokAmt)) / 10 ** decimals;
        // V4 amounts are the CALLER's BalanceDelta: token leg POSITIVE = caller received token = BUY.
        if (isFinite(price) && price > 0) pts.push({ ts, price, usd: amount * price, side: tokAmt > 0n ? 'buy' : 'sell', tx });
      } else {
        const topic = (l.topics?.[0] || '').toLowerCase();
        const d = l.data.slice(2);
        const w = (i: number) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
        if (topic === SWAP_V2_TOPIC) { const dec = decodeSwap(l.data, topic, usdcIsToken0); if (!dec || dec.tok <= 0n) continue; const price = (Number(dec.usdc) / Number(dec.tok)) * dexp; const usdcIn = (usdcIsToken0 ? w(0) : w(1)) > 0n; if (isFinite(price) && price > 0) pts.push({ ts, price, usd: Number(dec.usdc) / 1e6, side: usdcIn ? 'buy' : 'sell', tx }); }
        else { const sqrtP = BigInt('0x' + d.slice(128, 192)); if (sqrtP <= 0n) continue; const ratio = (Number(sqrtP) / 2 ** 96) ** 2; const price = (usdcIsToken0 ? 1 / ratio : ratio) * dexp; const dec = decodeSwap(l.data, topic, usdcIsToken0); const usd = dec ? Number(dec.usdc) / 1e6 : 0; const sw = usdcIsToken0 ? w(0) : w(1); const usdcIn = sw < (1n << 255n) && sw > 0n; if (isFinite(price) && price > 0) pts.push({ ts, price, usd, side: usdcIn ? 'buy' : 'sell', tx }); } // V3: USDC INTO pool = BUY of the token
      }
    }
  }
  if (!pts.length) { dayStatsCache.set(t, { at: Date.now(), v: empty }); return empty; }
  pts.sort((a, b) => a.ts - b.ts);
  const volume24h = pts.reduce((s, p) => s + (isFinite(p.usd) ? p.usd : 0), 0);
  const first = pts[0].price, last = pts[pts.length - 1].price;
  const change24h = first > 0 ? ((last - first) / first) * 100 : null;
  const buys24 = pts.filter((p) => p.side === 'buy').length;
  const sells24 = pts.filter((p) => p.side === 'sell').length;
  const uniqTx = [...new Set(pts.map((p) => p.tx).filter(Boolean))];
  const txns24 = uniqTx.length;
  // Real MAKERS = distinct tx.origin, NOT the swap event's `sender` topic — that is the ROUTER (one address
  // for every launchpad/V4 trade), which collapsed the count to 1. Resolve origins for the most-recent txs
  // (capped, so a hot token doesn't fire thousands of calls); when capped this is an honest floor.
  const MAKER_TX_CAP = 140;
  const sampleTx = uniqTx.slice(-MAKER_TX_CAP);
  let makers24: number | null = null;
  try {
    const origins = await runLimited(sampleTx.map((h) => async () => { const tr = await mrpc('eth_getTransactionByHash', [h]).catch(() => null); return tr?.from ? tr.from.toLowerCase() : null; }), 8);
    const set = new Set(origins.filter(Boolean) as string[]);
    if (set.size) makers24 = set.size;
  } catch { /* leave null on failure */ }
  const v = { change24h, volume24h, buys24, sells24, txns24, makers24 };
  dayStatsCache.set(t, { at: Date.now(), v });
  return v;
}
// On-chain burn: tokens sent to the null/dead addresses, as an amount + % of total supply. Works for any
// token/decimals (no indexer needed) so the Supply card shows a real Burnt figure for coins RadarDEX skips.
export async function fetchTokenBurn(token: string, decimals = 18): Promise<{ burnt: number; supply: number | null; pct: number | null }> {
  const balSel = (addr: string) => '0x70a08231' + addr.toLowerCase().replace('0x', '').padStart(64, '0');
  const [b0, bd, sup] = await Promise.all([
    mCall(token, balSel('0x0')).catch(() => null),
    mCall(token, balSel('0x000000000000000000000000000000000000dEaD')).catch(() => null),
    mCall(token, '0x18160ddd').catch(() => null), // totalSupply()
  ]);
  let burnt = 0; try { if (b0 && b0 !== '0x') burnt += Number(BigInt(b0)) / 10 ** decimals; } catch { /* */ }
  try { if (bd && bd !== '0x') burnt += Number(BigInt(bd)) / 10 ** decimals; } catch { /* */ }
  let supply: number | null = null; try { if (sup && sup !== '0x') supply = Number(BigInt(sup)) / 10 ** decimals; } catch { /* */ }
  const pct = supply && supply > 0 ? (burnt / supply) * 100 : null;
  return { burnt, supply, pct: pct != null && isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null };
}
const candleCache = new Map<string, { at: number; data: Candle[] }>();
export async function fetchPoolCandles(token: string, decimals: number, intervalSec: number, lookbackSec?: number): Promise<Candle[]> {
  const ck = token.toLowerCase() + ':' + intervalSec + ':' + (lookbackSec ?? 0);
  const hit = candleCache.get(ck);
  if (hit && Date.now() - hit.at < 45000) return hit.data; // 45s cache — instant re-opens
  // Wide views (4H+) reach the whole chain-life (~4 days); fine views stay bounded. All TFs at the same
  // cap share ONE cached swap scan (scanPoolSwaps) — only the bucketing differs. The fine tier covers ~25h
  // (180k blocks) so 5m/15m fill their 24h window from on-chain when Warp's candle feed is stale/down.
  const spanCap = intervalSec >= 14400 ? 900000 : intervalSec >= 3600 ? 300000 : 180000;
  const swaps = await scanPoolSwaps(token, decimals, spanCap);
  if (!swaps.length) return [];
  const buckets = new Map<number, { o: number; h: number; l: number; c: number }>();
  for (const s of swaps) {
    const b = Math.floor(s.ts / intervalSec) * intervalSec;
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { o: s.price, h: s.price, l: s.price, c: s.price });
    else { cur.h = Math.max(cur.h, s.price); cur.l = Math.min(cur.l, s.price); cur.c = s.price; }
  }
  const data = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, v]) => ({ time, open: v.o, high: v.h, low: v.l, close: v.c }));
  candleCache.set(ck, { at: Date.now(), data });
  return data;
}

// Live 24h volume for a pooled token from its V3 pool Swap events. A full 24h scan is ~68 getLogs
// (RPC caps ranges at ~2.5k blocks), so we sample recent swaps and scale to 24h — accurate for
// steady flow, approximate through a burst. Returns USD volume, or null if no pool / no swaps.
export async function fetchPoolVolume24h(token: string): Promise<number | null> {
  const pool = await findTokenPool(token); if (!pool) return null;
  const [t0hex, headHex] = await Promise.all([mCall(pool, '0x0dfe1681'), mrpc('eth_blockNumber', [])]);
  if (!t0hex || !headHex) return null;
  const usdcIsToken0 = ('0x' + t0hex.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR.toLowerCase();
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (Number(BigInt(hb.timestamp)) - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const sampleBlocks = 12000; // ~100 min sample (6 × 2000)
  let usdcVol = 0, sawAny = false;
  const CH = 2000n;
  for (let from = head - BigInt(sampleBlocks); from < head; from += CH) {
    const to = from + CH > head ? head : from + CH;
    const logs = await mrpc('eth_getLogs', [{ address: pool, topics: [[SWAP_TOPIC, SWAP_V2_TOPIC]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const dec = decodeSwap(l.data, l.topics?.[0], usdcIsToken0); // V3 + V2
      if (!dec) continue;
      usdcVol += Number(dec.usdc) / 1e6; sawAny = true;
    }
  }
  if (!sawAny) return 0;
  const sampleSecs = sampleBlocks * blockTime;
  return usdcVol * (86400 / sampleSecs); // scale sample → 24h
}

// Real buy/sell TRADES for a token straight from its pool's Swap events — the fallback trades feed for
// tokens RadarDEX doesn't index (ARGUS etc.), so the Transactions table shows Buy/Sell not "Transfer".
// The swap event's on-chain sender/recipient is the ROUTER (one address for every launchpad/V4 trade), so
// the Maker column read the same address on every row and Makers collapsed to 1. The TRUE maker is the
// transaction's origin — resolve it for the (bounded, <= `want`) trade list and overwrite trader.
async function resolveMakers(trades: RadarSwap[]): Promise<RadarSwap[]> {
  const uniq = [...new Set(trades.map((t) => t.tx).filter(Boolean))];
  if (!uniq.length) return trades;
  try {
    const origins = await runLimited(uniq.map((h) => async () => { const tr = await mrpc('eth_getTransactionByHash', [h]).catch(() => null); return [h, tr?.from ? tr.from.toLowerCase() : null] as const; }), 8);
    const map = new Map(origins);
    for (const t of trades) { const o = map.get(t.tx); if (o) t.trader = o; }
  } catch { /* keep the router address rather than fail the whole table */ }
  return trades;
}
// side from the USDC delta sign (USDC INTO pool = a BUY of the token); maker = the tx origin (real trader);
// price = executed USD/token. Timestamps approximated from block height (fine for a table).
export async function fetchPoolTrades(token: string, decimals = 18, want = 40): Promise<RadarSwap[]> {
  const pool = await findTokenPool(token);
  if (!pool) { const v4 = await findV4Pool(token); return v4 ? fetchV4Trades(v4, decimals, want) : []; }
  const [t0hex, headHex] = await Promise.all([mCall(pool, '0x0dfe1681'), mrpc('eth_blockNumber', [])]);
  if (!t0hex || !headHex) return [];
  const usdcIsToken0 = ('0x' + t0hex.slice(-40)).toLowerCase() === NATIVE_USDC_ADDR.toLowerCase();
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const dexp = 10 ** (decimals - 6);
  const out: RadarSwap[] = [];
  const CH = 2500n;
  // Walk backward from head in chunks until we have enough trades (or run out of budget).
  for (let hi = head; hi > head - 80000n && out.length < want; hi -= CH) {
    const lo = hi - CH < 0n ? 0n : hi - CH;
    const logs = await mrpc('eth_getLogs', [{ address: pool, topics: [[SWAP_TOPIC, SWAP_V2_TOPIC]], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const topic = (l.topics?.[0] || '').toLowerCase();
      const dec = decodeSwap(l.data, topic, usdcIsToken0);
      if (!dec || dec.tok <= 0n) continue;
      // Determine side: USDC entering the pool => a BUY of the token.
      let usdcIn = false;
      const d = l.data.slice(2);
      const w = (i: number) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
      if (topic === SWAP_V2_TOPIC) { usdcIn = (usdcIsToken0 ? w(0) : w(1)) > 0n; }
      else { const sw = usdcIsToken0 ? w(0) : w(1); usdcIn = sw < (1n << 255n) && sw > 0n; }
      const usd = Number(dec.usdc) / 1e6;
      const amount = Number(dec.tok) / 10 ** decimals;
      out.push({
        side: usdcIn ? 'buy' : 'sell', usd, amount,
        price: amount > 0 ? usd / amount : (Number(dec.usdc) / Number(dec.tok)) * dexp,
        trader: ('0x' + (l.topics?.[2] || l.topics?.[1] || '').slice(-40)).toLowerCase(),
        tx: l.transactionHash || '',
        time: Math.round(headTs - Number(head - BigInt(l.blockNumber)) * blockTime),
      });
    }
  }
  out.sort((a, b) => b.time - a.time);
  return resolveMakers(out.slice(0, want).filter((s) => s.tx));
}
// V4 buy/sell trades from the singleton's Swap events (poolId-filtered). Layout (verified on GLITCH):
// w0=amount0, w1=amount1, w2=sqrtPriceX96, w3=liquidity, w4=tick, w5=fee. ⛔ V4 amounts are the CALLER's
// BalanceDelta (opposite of V3's pool-perspective): the token leg NEGATIVE = swapper paid token = a SELL,
// POSITIVE = swapper received = a BUY. Verified against a real tx's GLITCH Transfer (amount0 −34.8M → the
// user's GLITCH moved INTO the pool = SELL). USD = |tokenAmt| × price. maker = sender (topic2).
async function fetchV4Trades(v4: V4Pool, decimals: number, want: number): Promise<RadarSwap[]> {
  const headHex = await mrpc('eth_blockNumber', []); if (!headHex) return [];
  const head = BigInt(headHex);
  const [hb, ob] = await Promise.all([mrpc('eth_getBlockByNumber', [headHex, false]), mrpc('eth_getBlockByNumber', ['0x' + (head - 20000n).toString(16), false])]);
  const headTs = hb ? Number(BigInt(hb.timestamp)) : Math.floor(Date.now() / 1000);
  const blockTime = (hb && ob && hb.timestamp && ob.timestamp) ? Math.max(0.1, (headTs - Number(BigInt(ob.timestamp))) / 20000) : 0.5;
  const dexp = 10 ** (decimals - 6);
  const tokIdx = v4.usdcIsC0 ? 1 : 0; // token is the non-USDC currency
  const out: RadarSwap[] = [];
  const CH = BigInt(BIG_LOG_RANGE);
  for (let hi = head; hi > head - 300000n && out.length < want; hi -= CH) {
    const lo = hi - CH < 0n ? 0n : hi - CH;
    const logs = await getLogsBig({ address: PM_V4, topics: [V4_SWAP_TOPIC, v4.poolId], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) });
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const d = l.data.slice(2);
      const sword = (i: number) => { let x = BigInt('0x' + d.slice(i * 64, i * 64 + 64)); if (x >= (1n << 255n)) x -= (1n << 256n); return x; };
      const tokAmt = sword(tokIdx);
      if (tokAmt === 0n) continue;
      const sqrtP = BigInt('0x' + d.slice(128, 192)); if (sqrtP <= 0n) continue;
      const ratio = (Number(sqrtP) / 2 ** 96) ** 2;
      const price = (v4.usdcIsC0 ? 1 / ratio : ratio) * dexp;
      if (!isFinite(price) || price <= 0) continue;
      const amount = Math.abs(Number(tokAmt)) / 10 ** decimals;
      out.push({
        side: tokAmt > 0n ? 'buy' : 'sell', usd: amount * price, amount, price,
        trader: ('0x' + (l.topics?.[2] || '').slice(-40)).toLowerCase(),
        tx: l.transactionHash || '',
        time: Math.round(headTs - Number(head - BigInt(l.blockNumber)) * blockTime),
      });
    }
  }
  out.sort((a, b) => b.time - a.time);
  return resolveMakers(out.slice(0, want).filter((s) => s.tx));
}

// On-chain token logo, read straight from the token address (no third-party dependency). Arc
// launchpad tokens expose their image on-chain in one of two shapes: a URI function (0xfb7f21eb)
// that returns the image URI directly (ipfs:// or a plain URL), or a tokenURI() (0x3c130d90) that
// returns a JSON-metadata URL whose { image } we fetch. ipfs:// resolves through a working gateway.
// Cached in memory + localStorage so it paints instantly next time (matches X1's tokenLogos pattern).
const IPFS_GW = 'https://gateway.pinata.cloud/ipfs/';
const toHttp = (u: string) => u.trim().replace(/^ipfs:\/\//i, IPFS_GW).replace(/^ar:\/\//i, 'https://arweave.net/');
const _logoCache = new Map<string, string | null>();
async function _imageFromJson(url: string): Promise<string | null> {
  try { const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json(); return j?.image ? toHttp(String(j.image)) : null; } catch { return null; }
}
export async function resolveTokenLogo(address: string): Promise<string | null> {
  const k = address.toLowerCase();
  if (_logoCache.has(k)) return _logoCache.get(k)!;
  try { const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('sa_logo_' + k) : null; if (ls != null) { const v = ls || null; _logoCache.set(k, v); return v; } } catch { /* no ls */ }
  let logo: string | null = null;
  try {
    const a = await mReadStr(address, '0xfb7f21eb'); // image-URI function (ARGUS/ARCASH-style factories)
    if (a && /ipfs|https?:|ar:|Qm[1-9A-HJ-NP-Za-km-z]{40}/i.test(a)) {
      const u = toHttp(a);
      logo = /\.json($|\?)|\/metadata\//i.test(u) ? await _imageFromJson(u) : u;
    }
    if (!logo) {
      const b = await mReadStr(address, '0x3c130d90'); // tokenURI() -> JSON metadata (ARCBAT/Architects-style)
      if (b && /^(https?:|ipfs|ar:)/i.test(b.trim())) logo = await _imageFromJson(toHttp(b));
    }
  } catch { /* none on-chain */ }
  _logoCache.set(k, logo);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('sa_logo_' + k, logo || ''); } catch { /* no ls */ }
  return logo;
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
        // Official Arc RPCs only (PublicNode/Allnodes + Circle's rpc.mainnet.arc.io) + the official explorer.
        rpcUrls: NET === 'mainnet' ? ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org'] : [CHAIN.rpc],
        blockExplorerUrls: NET === 'mainnet' ? ['https://explorer.arc.io'] : [CHAIN.scan],
      }] });
    }
  }
  return accts?.[0] || null;
}
