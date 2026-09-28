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
export interface V2Board { asOf: number | null; total: number; page: number; pages: number; per: number; rows: Token[] }

export const v2Enabled = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('data');
    if (q === 'v1' || q === 'v2') sessionStorage.setItem('statera-data', q);
    return (sessionStorage.getItem('statera-data') || 'v2') === 'v2';
  } catch { return true; }
})();

async function get<T>(path: string, ms = 8000): Promise<T> {
  const r = await fetch(`/api/v2/${path}`, { signal: AbortSignal.timeout(ms) });
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
}
export const v2TokenDetail = (addr: string) => get<V2TokenDetail>(`token/${addr.toLowerCase()}/detail`, 20000)
  .then((d) => { if (!d || typeof d.dec !== 'number') throw new Error('v2 detail: bad shape'); return d; });
export const v2Candles = (addr: string, sec: number, look: number) => get<{ candles: Candle[] }>(`token/${addr.toLowerCase()}/candles?sec=${sec}&look=${look}`, 20000).then((j) => { if (!Array.isArray(j.candles)) throw new Error('v2 candles: bad shape'); return j.candles; });
// The Arc Network page (server/chain.ts).
export interface V2ChainWin { seconds: number; blocks: number; blockTime: number; txs: number; tps: number; gasPerBlock: number; feesUsdc: number }
interface V2Flows { usd: number; count: number; byChain: { chain: string; usd: number; n: number }[] }
export interface V2Chain {
  at: number; head: number; headTs: number; baseFeeGwei: number; coveredSeconds: number;
  m5: V2ChainWin | null; h1: V2ChainWin | null; h6: V2ChainWin | null;
  validators: { address: string; blocks: number; share: number; lastBlock: number; behind: number }[]; validatorCount: number;
  cctp: { h1: { in: V2Flows; out: V2Flows }; h6: { in: V2Flows; out: V2Flows } | null };
  supplies: Record<string, number | null>; suppliesAt: number;
}
export const v2Chain = () => get<V2Chain>('chain', 8000).then((c) => { if (!c || typeof c.head !== 'number') throw new Error('v2 chain: bad shape'); return c; });
