// Client for the v2 data API (/api/v2/* → server/statera-api.ts on the VPS). Every call has a short deadline and THROWS
// on any failure, so App.tsx can drop back to the v1 path (the full list + in-browser re-pricing) — the site never
// depends on v2 alone. Force v1 with ?data=v1 (sticky for the tab) to compare the two.
import type { Token } from './rules';
import type { DashStats } from './board';
import type { DayStats, OnchainPool, RadarSwap, RadarHolder, TokenTransfer } from './arc';
import type { Candle } from './warp';

export interface V2Home {
  asOf: number | null; generatedAt: string | null; tracked: number; stats: DashStats;
  counts: { eco: number; launchpad: number; dup: number };
  legend: { label: string; desc: string }[];
  trending: Token[]; launches: Token[]; movers: Token[];
}
export interface V2Board { asOf: number | null; total: number; page: number; pages: number; per: number; rows: Token[]; hiddenDupes?: number }

export const v2Enabled = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('data');
    if (q === 'v1' || q === 'v2') sessionStorage.setItem('statera-data', q);
    return (sessionStorage.getItem('statera-data') || 'v2') === 'v2';
  } catch { return true; }
})();

async function get<T>(path: string, ms = 8000): Promise<T> {
  // One retry on a network error or a 5xx before giving up (09-28 audit: a single 502 during a server restart switched the
  // tab to the heavy v1 path for good — App.tsx falls back on the first failure).
  let r: Response | null = null;
  for (let i = 0; i < 2 && !r; i++) {
    try { const x = await fetch(`/api/v2/${path}`, { signal: AbortSignal.timeout(ms) }); if (x.status >= 500 && i === 0) { await new Promise((ok) => setTimeout(ok, 1200)); continue; } r = x; }
    catch (e) { if (i === 1) throw e; await new Promise((ok) => setTimeout(ok, 1200)); }
  }
  if (!r) throw new Error(`v2 ${path} unavailable`);
  if (!r.ok && r.status !== 404) throw new Error(`v2 ${path} ${r.status}`);
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j?.error || 'not found'), { notFound: true });
  return j as T;
}
export const v2Home = () => get<V2Home>('home').then((h) => { if (!h || !h.stats || !Array.isArray(h.trending)) throw new Error('v2 home: bad shape'); return h; });
export const v2Board = (o: { filter: string; q: string; sort: string; dir: string; hideDupes: boolean; showInactive: boolean; page: number; per: number }) =>
  get<V2Board>(`board?${new URLSearchParams({ filter: o.filter, q: o.q, sort: o.sort, dir: o.dir, dups: o.hideDupes ? '0' : '1', inactive: o.showInactive ? '1' : '0', page: String(o.page), per: String(o.per) })}`)
    .then((b) => { if (!b || !Array.isArray(b.rows)) throw new Error('v2 board: bad shape'); return b; });
export const v2Search = (q: string, limit = 7) => get<{ rows: Token[] }>(`search?${new URLSearchParams({ q, limit: String(limit) })}`, 5000).then((j) => j.rows || []);
export const v2Token = (addr: string) => get<{ token: Token }>(`token/${addr.toLowerCase()}`, 6000).then((j) => j.token).catch((e) => { if (e?.notFound) return null; throw e; });
export const v2SwapTokens = () => get<{ tokens: Token[] }>('swap-tokens', 10000).then((j) => j.tokens || []);
export const v2List = () => get<{ tokens: Token[]; asOf: number | null }>('list', 20000);
// The token page's chain data (server/token-detail.ts). Cold ≈ 5 s (the server scans the pool once for everyone), then cached.
export interface V2TokenDetail {
  address: string; at: number; ms: number; dec: number;
  ocPool: { tvl: number | null; reserveQuote: number | null; reserveBase: number | null; pool: string | null; price: number | null } | null;
  ocPools: OnchainPool[] | null; dayStats: DayStats | null; burn: { burnt: number; supply: number | null; pct: number | null } | null;
  holders: RadarHolder[] | null; swaps: RadarSwap[] | null; txs: TokenTransfer[] | null;
  trades?: { total: number; buys: number; sells: number; since: number | null } | null; // the day's whole list → v2Trades
  biggest?: Record<'h1' | 'h12' | 'h24', { buys: RadarSwap[]; sells: RadarSwap[] }> | null; // top 3 buys/sells by USD per window
  holderCount?: number | null; holdersFrom?: 'chain' | 'arc-scan' | null;
  contract?: { name: string | null; symbol: string | null; decimals: number | null; supply: number | null; deployBlock: number | null; creator: string | null; size: number | null; transfers24h: number | null } | null;
  lookalike?: boolean | null;
  locks?: V2Lock[] | null; holdersOver?: { over: number; total: number | null; minUsd: number; capped: boolean; at: number } | null;
}
export interface V2Lock { locker: string; label: string; locked: number; pct: number | null; nextUnlock: number | null; lastUnlock: number | null; parts: { amount: number; unlock: number }[]; expiredNotWithdrawn: number }
export const v2TokenDetail = (addr: string) => get<V2TokenDetail>(`token/${addr.toLowerCase()}/detail`, 20000)
  .then((d) => { if (!d || typeof d.dec !== 'number') throw new Error('v2 detail: bad shape'); return d; });
// One page (100) of the token's trades over the last 24h, newest first, from every pool (server/token-detail.ts tokenTrades).
export interface V2Trades { page: number; pages: number; total: number; per: number; since: number | null; rows: RadarSwap[] }
export const v2Trades = (addr: string, page: number, side: 'all' | 'buy' | 'sell') =>
  get<V2Trades>(`token/${addr.toLowerCase()}/trades?page=${page}&side=${side}`, 20000).then((j) => { if (!j || !Array.isArray(j.rows)) throw new Error('v2 trades: bad shape'); return j; });
export const v2Candles = (addr: string, sec: number, look: number) => get<{ candles: Candle[] }>(`token/${addr.toLowerCase()}/candles?sec=${sec}&look=${look}`, 20000).then((j) => { if (!Array.isArray(j.candles)) throw new Error('v2 candles: bad shape'); return j.candles; });
// The Arc Network page (server/chain.ts).
export interface V2ChainWin { seconds: number; blocks: number; blockTime: number; txs: number; tps: number; gasPerBlock: number; feesUsdc: number; fill?: number | null; maxBlockTxs?: number }
interface V2Flows { usd: number; count: number; byChain: { chain: string; usd: number; n: number }[] }
export interface V2Chain {
  at: number; head: number; headTs: number; baseFeeGwei: number; coveredSeconds: number;
  m5: V2ChainWin | null; h1: V2ChainWin | null; h6: V2ChainWin | null;
  validators: { address: string; blocks: number; share: number; lastBlock: number; behind: number }[]; validatorCount: number;
  cctp: { h1: { in: V2Flows; out: V2Flows }; h6: { in: V2Flows; out: V2Flows } | null;
    h12?: { in: V2Flows; out: V2Flows } | null; h24?: { in: V2Flows; out: V2Flows } | null; coveredSeconds?: number };
  supplies: Record<string, number | null>; suppliesAt: number; supplyUsd?: Record<string, number | null>;
}
export const v2Chain = () => get<V2Chain>('chain', 8000).then((c) => { if (!c || typeof c.head !== 'number') throw new Error('v2 chain: bad shape'); return c; });
// Lending on Arc (server/lending.ts): Morpho Blue markets + Aave V4 Hub assets, read on chain.
export interface V2LendRow { supply: number; borrow: number; supplyUsd: number | null; borrowUsd: number | null; utilization: number | null }
export interface V2Lending {
  at: number;
  morpho: { address: string; supplyUsd: number; borrowUsd: number; complete?: boolean; progress?: number; markets: (V2LendRow & { id: string; loan: string; loanSymbol: string | null; collateral: string; collateralSymbol: string | null; lltv: number })[] };
  aave: { hub: string; supplyUsd: number; borrowUsd: number; assets: (V2LendRow & { assetId: number; token: string; symbol: string | null })[] };
}
export const v2Lending = () => get<V2Lending>('lending', 8000).then((l) => { if (!l || !l.morpho || !l.aave) throw new Error('v2 lending: bad shape'); return l; });
// Where each Circle asset's supply sits (server/where.ts).
export interface V2Where { at: number; assets: { sym: string; supply: number; price: number | null; buckets: { lending: number; dex: number; bridge: number; contracts: number; wallets: number }; lendingBy: Record<string, number> }[] }
export const v2Where = () => get<V2Where>('where', 8000).then((w) => { if (!w || !Array.isArray(w.assets)) throw new Error('v2 where: bad shape'); return w; });
// ── The swap store (server/swap-store.ts): real history for every timeframe, the full trade history, a wallet's own swaps ──
export interface V2Bar { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
export interface V2Bars { res: string; candles: V2Bar[]; hasMore: boolean; first: number | null; lastTrade?: number; pools: { venue: string; kind: string; vol: number }[];
  coverage: { backTs: number | null; backBlock: number | null; liveBlock: number | null; liveAt: number | null; backDone: boolean } | null }
export const v2Bars = (addr: string, res: string, limit = 1000, before?: number) =>
  get<V2Bars>(`token/${addr.toLowerCase()}/bars?res=${res}&limit=${limit}${before ? `&before=${before}` : ''}`, 12000)
    .then((j) => { if (!j || !Array.isArray(j.candles)) throw new Error('v2 bars: bad shape'); return j; });
export interface V2HistTrade { side: 'buy' | 'sell'; usd: number; amount: number; price: number; tx: string; time: number; block: number; logIndex: number; venue?: string; trader?: string | null }
export const v2History = (addr: string, o: { before?: number; limit?: number; side?: 'buy' | 'sell'; minUsd?: number; maker?: string } = {}) =>
  get<{ trades: V2HistTrade[]; hasMore: boolean }>(`token/${addr.toLowerCase()}/history?${new URLSearchParams({ limit: String(o.limit ?? 100), ...(o.before ? { before: String(o.before) } : {}), ...(o.side ? { side: o.side } : {}), ...(o.minUsd ? { min: String(o.minUsd) } : {}), ...(o.maker ? { maker: o.maker } : {}) })}`, 12000)
    .then((j) => { if (!j || !Array.isArray(j.trades)) throw new Error('v2 history: bad shape'); return j; });
export interface V2WalletSwap { token: string; side: 'buy' | 'sell'; usd: number; amount: number; price: number; tx: string; ts: number; block: number; logIndex: number; venue: string }
export const v2WalletSwaps = (wallet: string, token?: string) =>
  get<{ wallet: string; at: number; swaps: V2WalletSwap[]; building?: boolean }>(`wallet/${wallet.toLowerCase()}/swaps${token ? `?token=${token.toLowerCase()}` : ''}`, 25000)
    .then((j) => { if (!j || (!Array.isArray(j.swaps) && !j.building)) throw new Error('v2 wallet swaps: bad shape'); return j; });
// Money flow / top traders / holder profitability (server/swap-store.ts) + one wallet's trades of a token
export interface V2FlowWin { window: string; buys: number; sells: number; buyUsd: number; sellUsd: number; net: number; biggestBuy: number; biggestSell: number;
  buyers: number; sellers: number; topBuyer: { wallet: string; net: number } | null; topSeller: { wallet: string; net: number } | null; makersKnown: number | null }
export const v2Flow = (addr: string) => get<{ windows: V2FlowWin[] }>(`token/${addr.toLowerCase()}/flow`, 15000).then((j) => { if (!Array.isArray(j?.windows)) throw new Error('v2 flow: bad shape'); return j; });
export interface V2Trader { wallet: string; bought: number; sold: number; qtyBought: number; qtySold: number; buys: number; sells: number; first: number; last: number;
  avgBuy: number | null; held: number; realized: number; unrealized: number; pnl: number; roi: number | null }
export const v2Traders = (addr: string, sort: 'pnl' | 'volume' | 'loss' = 'pnl') =>
  get<{ price: number | null; coverage: number | null; traders: number; rows: V2Trader[] }>(`token/${addr.toLowerCase()}/traders?sort=${sort}&limit=100`, 25000)
    .then((j) => { if (!Array.isArray(j?.rows)) throw new Error('v2 traders: bad shape'); return j; });
export interface V2Profit { price: number | null; coverage: number | null; holders: number; inProfit?: number; pctHolders?: number; pctSupply?: number | null; medianEntry?: number; avgEntry?: number;
  dist?: { label: string; holders: number; pct: number }[] }
export const v2Profit = (addr: string) => get<V2Profit>(`token/${addr.toLowerCase()}/profitability`, 25000).then((j) => { if (!j || typeof j.holders !== 'number') throw new Error('v2 profit: bad shape'); return j; });
export const v2MakerTrades = (addr: string, maker: string) =>
  get<{ trades: (V2HistTrade & { trader: string | null })[]; hasMore: boolean }>(`token/${addr.toLowerCase()}/history?maker=${maker.toLowerCase()}&limit=500`, 15000)
    .then((j) => { if (!Array.isArray(j?.trades)) throw new Error('v2 maker: bad shape'); return j.trades; });
// What the chain is doing (server/activity.ts): block tape, USDC issued/burned/moved, active + new wallets, per-protocol activity
export interface V2ActWin { from: number; liveFrom?: number; txs: number; active: number; newWallets: number; minted: number; burned: number; net: number; moved: number; protocols: Record<string, number> }
export interface V2Activity { at: number; since: number; liveSince?: number; now: number; protocols: { id: string; name: string; desc?: string; cat: string; color: string }[];
  h1: V2ActWin; today: V2ActWin; h24: V2ActWin;
  series: { start: number; step: number; txs: number[]; active: number[]; newWallets: number[]; net: number[]; moved: number[]; protocols: Record<string, number[]> };
  tape: { n: number; ts: number; txs: number; p: Record<string, number> }[];
  launchpads?: { trades: number; volume: number; traded: number; pads: { pad: string; tokens: number; traded: number; trades: number; volume: number }[];
    top: { address: string; symbol: string; pad: string; trades: number; volume: number; mcap?: number | null; liq?: number | null; change24h?: number | null }[] } }
export const v2Activity = () => get<V2Activity>('activity', 8000).then((j) => { if (!j || !Array.isArray(j.tape)) throw new Error('v2 activity: bad shape'); return j; });
