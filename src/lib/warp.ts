// Warp launchpad (circlewarp.fun) data — the live Pump.fun-style venue on Arc mainnet (5042).
// Warp's API has no CORS, so we hit it through our same-origin proxy (/api/warp → Vercel rewrite
// in prod, vite proxy in dev). This is real Arc-mainnet token data (price/mcap/volume/momentum)
// BEFORE the public RPC opens — Warp runs its own node. Read-only; nothing here signs or trades.
const BASE = '/api/warp';

export interface WarpWindow { volume: number; txCount: number; change: number }
export interface WarpToken {
  address: string;
  name: string;
  ticker: string;
  image: string | null;
  price: number | null;
  mcap: number | null;
  liquidity: number | null;
  volume24h: number | null;
  change24h: number | null;
  holders: number | null;
  progress: number | null;   // bonding-curve % to graduation (0..100), null once graduated
  graduated: boolean;
  amm: string | null;        // e.g. warp bonding curve / uniswap-v4 after graduation
  v4: boolean;
  fee: number | null;        // pool fee (raw, e.g. 100000 = 10% in v4 hundredths-of-a-bip)
  pool: string | null;       // v4 poolId (bytes32) or pool address
  curveAddress: string | null; // Warp bonding-curve contract (buy(minOut) payable with USDC value)
  pairAddress: string | null;  // WarpV2 pair once graduated
  migrated: boolean;         // true once graduated off the bonding curve to its DEX
  topHolderBps: number | null; // top holder concentration, basis points
  createdAt: number | null;  // ms epoch
  windows: { '1h'?: WarpWindow; '6h'?: WarpWindow };
}

function norm(t: any): WarpToken {
  return {
    address: (t.address || t.id || '').toLowerCase(),
    name: t.name || t.ticker || '?',
    ticker: t.ticker || '?',
    image: t.image || null,
    price: num(t.price),
    mcap: num(t.mcap),
    liquidity: num(t.liquidity),
    volume24h: num(t.volume24h ?? t.volume),
    change24h: num(t.change24h),
    holders: t.holders != null ? Number(t.holders) : null,
    progress: num(t.progress),
    graduated: !!t.graduated,
    amm: t.amm || null,
    v4: !!t.v4,
    fee: num(t.fee),
    pool: t.pool || null,
    curveAddress: (t.curveAddress || t.curve || null)?.toLowerCase?.() || null,
    pairAddress: (t.pairAddress || null)?.toLowerCase?.() || null,
    migrated: !!t.migrated,
    topHolderBps: t.topHolderBps != null ? Number(t.topHolderBps) : null,
    createdAt: num(t.createdAt),
    windows: t.windows || {},
  };
}
const num = (v: any): number | null => (v == null || isNaN(Number(v)) ? null : Number(v));

async function get(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`warp ${r.status}`);
  return r.json();
}

// Trending by momentum (Warp's own ranking). Returns richest-first useful subset.
export async function fetchWarpTrending(): Promise<WarpToken[]> {
  try {
    const j = await get('/trending');
    const arr = Array.isArray(j) ? j : (j.tokens || j.items || []);
    return arr.map(norm).filter((t: WarpToken) => t.address);
  } catch { return []; }
}

// Single token's full detail from Warp (price, mcap, liquidity, volume, holders, graduated…).
export async function fetchWarpToken(address: string): Promise<WarpToken | null> {
  try { const j = await get(`/tokens/${address}`); return j && (j.address || j.id) ? norm(j) : null; } catch { return null; }
}

// OHLC candles for a token — Warp serves real candlesticks at 1m / 5m / 1h.
// Shape matches TradingView lightweight-charts: { time: unix-seconds, open, high, low, close }.
export interface Candle { time: number; open: number; high: number; low: number; close: number }
export async function fetchWarpCandles(address: string, interval = '5m'): Promise<Candle[]> {
  try {
    const j = await get(`/tokens/${address}/candles?interval=${encodeURIComponent(interval)}`);
    const arr = Array.isArray(j) ? j : (j.candles || j.data || []);
    return arr
      .map((c: any) => ({ time: Number(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close }))
      .filter((c: Candle) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
      .sort((a: Candle, b: Candle) => a.time - b.time);
  } catch { return []; }
}

// Top tokens by a sort key ('volume' | 'mcap' | 'new'...). Warp defaults are fine.
export async function fetchWarpTokens(sort = 'volume', limit = 30): Promise<WarpToken[]> {
  try {
    const j = await get(`/tokens?sort=${encodeURIComponent(sort)}&limit=${limit}`);
    const arr = Array.isArray(j) ? j : (j.tokens || j.items || []);
    return arr.map(norm).filter((t: WarpToken) => t.address);
  } catch { return []; }
}
