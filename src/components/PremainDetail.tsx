import { useEffect, useMemo, useState } from 'react';
import { TokenLogo } from './TokenLogo';
import { PriceChart } from './PriceChart';
import { TokenLinks } from './TokenLinks';
import { fetchWarpToken, type WarpToken } from '../lib/warp';
import { usd, tprice, compact, fetchTokenTransfers, fetchRadarTokenDetail, fetchRadarHolders, fetchRadarSwaps, fetchPoolTrades, fetchOnchainPoolStats, fetchAllOnchainPools, fetchOnchainDayStats, fetchOnchainMakers24, resolveMakers, fetchTokenHolders, fetchTokenBurn, fetchTokenDecimals, primePool, tokenShareUrl, type DayStats, type TokenTransfer, type RadarTokenDetail, type RadarHolder, type RadarSwap, type OnchainPool } from '../lib/arc';
import type { Token } from '../lib/arc';
import { IconArrowLeft, IconArrowRight, IconExternal, IconCheck, IconCopy, IconChevronDown, IconX } from './icons';
import { useNames, displayName } from '../lib/names';

// Pre-public (chain 5042) token detail. Source: arc-scan.org REST /tokens/{a} (UNOFFICIAL indexer,
// reliable, unverified aggregates). No internal on-chain detail — 5042 has no Blockscout API and the
// arc-scan.org website is Cloudflare-gated, so we render from the REST payload we can trust to fetch.
const REST = 'https://api.arc-scan.org/v1';

interface Detail {
  symbol: string; name: string; decimals: number; standard: string;
  holders: number | null; supply: string | null; transfers24h: number | null;
  creator: string | null; size: number | null; lookalike: boolean; reservedName: boolean;
  reservedCheck: string | null;
}

export function PremainDetail({ address, seed, ready = true, onBack, onTrade }: { address: string; seed?: Token; ready?: boolean; onBack: () => void; onTrade?: (t: { address: string; symbol: string; name?: string; price?: number | null }) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [warp, setWarp] = useState<WarpToken | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rd, setRd] = useState<RadarTokenDetail | null>(null);
  const [holders, setHolders] = useState<RadarHolder[] | null>(null);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [txs, setTxs] = useState<TokenTransfer[] | null>(null);
  const [swaps, setSwaps] = useState<RadarSwap[] | null>(null);
  const [ocPool, setOcPool] = useState<{ tvl: number | null; reserveQuote: number | null; reserveBase: number | null; pool?: string | null; price?: number | null } | null>(null);
  const [ocPools, setOcPools] = useState<OnchainPool[] | null>(null);
  const [dayStats, setDayStats] = useState<DayStats | null>(null);
  const [dec, setDec] = useState<number | null>(null); // token decimals actually used for every on-chain read
  const [burn, setBurn] = useState<{ burnt: number; supply: number | null; pct: number | null } | null>(null);
  const [tab, setTab] = useState<'txns' | 'holders'>('txns');
  const [txFilter, setTxFilter] = useState<'all' | 'buy' | 'sell'>('all');
  const [poolsOpen, setPoolsOpen] = useState(false);
  const [calcAmt, setCalcAmt] = useState('');

  // Warp (chain 5042) price/mcap + it backs the candlestick chart below.
  useEffect(() => {
    let alive = true; setWarp(null);
    fetchWarpToken(address).then((w) => { if (alive) setWarp(w); });
    return () => { alive = false; };
  }, [address]);

  // DEX-style detail: RadarDEX token stats (buys/sells/burned/change) + rich holders (with pool/dev
  // flags + accurate %), plus recent on-chain transfers (mainnet RPC).
  useEffect(() => {
    // ⛔ 09-25: on a DIRECT load (every visitor arriving from a shared link) this ran before the token list had loaded,
    // so `seed` — which carries the token's real pool — was undefined and every read fell back to pool DISCOVERY. For EURC
    // that picked the pool with the most USDC, which has no swaps: empty 24h stats after 13.9s, 5m/6h change never shown.
    // Wait for the list (`ready`, well under a second) so every visitor gets the snapshot's pool.
    if (!ready) return;
    let alive = true; setRd(null); setHolders(null); setHolderCount(null); setTxs(null); setSwaps(null); setOcPool(null); setOcPools(null); setDayStats(null); setBurn(null); setDec(null);
    // Prime the pool cache from the snapshot so every panel skips the slow ~900k-block pool-discovery scan.
    if (seed && (seed.pool || seed.poolId)) primePool(address, { pool: seed.pool, poolId: seed.poolId, usdcIsC0: seed.usdcIsC0 });
    (async () => {
      // ⛔ ON-CHAIN IS PRIMARY (owner, 09-24). Every market number on this page is read from the chain first;
      // RadarDEX / Warp only fill what the chain can't give (socials, deployer, 5m change when a coin has no
      // swaps…). Before 09-25 this page asked RadarDEX first and only went on-chain when RadarDEX had nothing.
      // Decimals: RadarDEX / snapshot if known, else read from the contract — never a guessed 18 (an 8-dec coin
      // like cirBTC read with 18 is 10^10 off).
      const rdP = fetchRadarTokenDetail(address).catch(() => null);
      const dec = seed?.decimals ?? (await fetchTokenDecimals(address)) ?? (await rdP)?.decimals ?? 18;
      if (!alive) return;
      setDec(dec);
      rdP.then((detail) => { if (alive) setRd(detail); });
      fetchOnchainPoolStats(address, dec).then((s) => { if (alive) setOcPool(s); }).catch(() => {});
      fetchAllOnchainPools(address, dec).then((ps) => { if (alive) setOcPools(ps); }).catch(() => {});
      fetchOnchainDayStats(address, dec).then((s) => {
        if (!alive) return; setDayStats(s);
        fetchOnchainMakers24(address).then((m) => { if (alive && m != null) setDayStats((d) => (d ? { ...d, makers24: m } : d)); }).catch(() => {}); // fills in after
      }).catch(() => {});
      fetchTokenBurn(address, dec).then((b) => { if (alive) setBurn(b); }).catch(() => {});
      fetchRadarHolders(address, dec, 100).then(async (h) => {
        if (h.holders && h.holders.length) { if (alive) { setHolders(h.holders); setHolderCount(h.holderCount); } return; }
        // RadarDEX doesn't index this token (on-chain/launchpad coins) → arc-scan holder list.
        const a = await fetchTokenHolders(address, 100).catch(() => []);
        if (alive) { setHolders(a.map((x) => ({ rank: x.rank, address: x.address, amount: x.balance, percent: x.share, isPool: x.isContract, isDeployer: false }))); if (h.holderCount != null) setHolderCount(h.holderCount); }
      }).catch(() => { if (alive) setHolders([]); });
      // Trades: the pool's own on-chain Swap events first; RadarDEX's indexed swaps only if the chain read is empty.
      fetchPoolTrades(address, dec, 40).catch(() => [] as RadarSwap[]).then(async (oc) => {
        if (oc && oc.length) {
          if (!alive) return;
          // Rows first, maker blank ("…") — the swap's own sender is the ROUTER, and showing it even briefly invites a
          // wrong copy — then the real wallets (tx.origin) fill in.
          setSwaps(oc.map((x) => ({ ...x, trader: '' })));
          resolveMakers(oc.map((x) => ({ ...x }))).then((r) => { if (alive) setSwaps(r); }).catch(() => {});
          return;
        }
        const r = await fetchRadarSwaps(address, dec, 50).catch(() => [] as RadarSwap[]);
        if (alive) setSwaps(r);
      });
    })();
    fetchTokenTransfers(address, 18, 40).then((t) => { if (alive) setTxs(t); }).catch(() => { if (alive) setTxs([]); });
    return () => { alive = false; };
  }, [address, ready]); // eslint-disable-line

  useEffect(() => {
    let alive = true;
    setD(null); setErr(null);
    (async () => {
      // This only adds EXTENDED contract details (creator, size, lookalike flags). Price/liq/mcap/holders
      // come from the screener seed and are unaffected if this flaky indexer (arc-scan.org) is down —
      // so we retry quietly and, on failure, show a soft note instead of a scary error.
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(`${REST}/tokens/${address}`, { headers: { accept: 'application/json' } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          const t = j.token || {};
          if (!alive) return;
          setD({
            symbol: t.symbol || seed?.symbol || '?', name: (t.name || seed?.name || '').trim(),
            decimals: t.decimals ?? 18, standard: t.standard || 'erc20',
            holders: j.holders != null ? Number(j.holders) : (seed?.holders ?? null),
            supply: j.total_supply?.formatted ?? null,
            transfers24h: j.transfers_24h != null ? Number(j.transfers_24h) : null,
            creator: j.contract?.creation?.creator?.address ?? null,
            size: j.contract?.size ?? null,
            lookalike: !!t.unverified_lookalike, reservedName: !!t.shares_reserved_name,
            reservedCheck: t.reserved_name_check ?? null,
          });
          return; // got it
        } catch {
          if (i < 2) await new Promise((res) => setTimeout(res, 500 * (i + 1)));
          else if (alive) setErr('detail-unavailable');
        }
      }
    })();
    return () => { alive = false; };
  }, [address]); // eslint-disable-line

  // Share: a freshly stamped url per click (see tokenShareUrl) so X/Discord/Telegram crawl the card at the LIVE price.
  const [linkCopied, setLinkCopied] = useState(false);
  const copyLink = () => { navigator.clipboard?.writeText(tokenShareUrl(address)).then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1400); }).catch(() => {}); };
  const postToX = () => {
    const chgS = chg != null ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h)` : '';
    const text = `$${sym}${px != null ? ` · ${tprice(px)}${chgS}` : ''} on Arc — live chart, pools & trades on StateraArc`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(tokenShareUrl(address))}`, '_blank', 'noopener,noreferrer');
  };
  const copy = () => { navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const fmtNum = (n: number | null) => (n == null ? '—' : n.toLocaleString());

  const sym = d?.symbol || seed?.symbol || '?';
  const name = d?.name || seed?.name || '';
  // Price/liq/mcap: prefer the screener SEED (RadarDEX — decimals-aware, correct for 8/6-dec tokens
  // like cirBTC/WBTC), then Warp. ⚠️ Warp's API reports price IGNORING token decimals, so an 8-dec
  // token (cirBTC) comes back 10^(18-8)=10^10 too high — never trust warp.price over the seed.
  const supplyNum = d?.supply ? Number(d.supply) : (seed?.totalSupply != null ? Number(seed.totalSupply) : null);
  // Snapshot rows priced from the chain are on-chain values (≤30 min old); indexer-priced rows are not.
  const chainSeed = seed?.priceFrom === 'chain' ? seed : undefined;
  // Price: the pool RIGHT NOW (slot0 / V4 StateView) first. A live read >20x off the snapshot's chain price is a
  // bad read (wrong pool / decimals), not a market move — then the snapshot's on-chain price stands.
  const livePx = ocPool?.price != null && isFinite(ocPool.price) && ocPool.price > 0
    && !(seed?.price && (ocPool.price / seed.price > 20 || seed.price / ocPool.price > 20)) ? ocPool.price : null;
  const px = livePx ?? seed?.price ?? warp?.price ?? null;
  const reserveBase = rd?.reserveBase ?? ocPool?.reserveBase ?? null;
  const reserveQuote = rd?.reserveQuote ?? ocPool?.reserveQuote ?? null;
  const bothSides = reserveQuote != null && reserveBase != null && px != null ? reserveQuote + reserveBase * px : null; // full pool value
  // ⛔ Pick the first POSITIVE value — a near-empty pool made bothSides compute to a spurious 0, and `??`
  // treats 0 as valid, so a real $6M liquidity showed $0. On-chain TVL (ocPool) is verified-accurate.
  const firstPos = (...v: (number | null | undefined)[]) => v.find((x) => x != null && isFinite(x) && x > 0) ?? null;
  // seed.liq is the indexer's aggregate across the token's pools (matches the screener) — prefer it; fall
  // back to on-chain reserves for coins with no seed. (bothSides can be a spurious 0 from a near-empty pool.)
  const liq = firstPos(seed?.liq, bothSides, ocPool?.tvl, rd?.liquidityTotal, warp?.liquidity);
  const mc = firstPos(seed?.mcap, warp?.mcap, px != null && supplyNum ? px * supplyNum : null);
  // 24h volume: the indexer's on-chain figure summed across ALL the token's pools, then this page's own on-chain scan
  // (primary pool only), then the indexers.
  const vol = firstPos(chainSeed?.volume24h, dayStats?.volume24h, rd?.volume24, seed?.volume24h, warp?.volume24h);
  const burnedPct = burn?.pct ?? rd?.burnedPct ?? null; // burn %: on-chain null/dead balances first, RadarDEX backup
  const burnedSupply = burn ? (burn.burnt > 0 ? burn.burnt : null) : (rd?.burnedSupply ?? null);
  const chg = dayStats?.change24h ?? chainSeed?.change24h ?? rd?.change24h ?? seed?.change24h ?? null;
  // 5m / 1h / 6h / 24h bar: this page's on-chain swap scan first, RadarDEX only for a window the chain can't answer.
  const chgBar = {
    '5m': dayStats?.change5m ?? rd?.change5m ?? null,
    '1h': dayStats?.change1h ?? chainSeed?.change1h ?? rd?.change1h ?? null,
    '6h': dayStats?.change6h ?? rd?.change6h ?? null,
    '24h': chg,
  };
  // Holder count: on-chain (arc-scan) and Warp agree and are ground truth; RadarDEX's count is stale/
  // partial (it only lists ~50 rows and undercounted ARGUS 12k vs the real 18k), so it goes LAST — else
  // it loaded late and OVERRODE the correct number, making the header flip 18k -> 12k.
  const holdersTotal = d?.holders ?? warp?.holders ?? seed?.holders ?? holderCount ?? null;
  // Buy/sell pressure (24h) + top-10 concentration for the DEX-style panels.
  // Buy/sell/txns/makers: RadarDEX first, else count the ACTUAL on-chain trades (so a coin RadarDEX shows
  // 0 for — cirBTC etc. — still reflects its real recent activity instead of a broken all-zero panel).
  // TRUE 24h buy/sell/txn/maker counts come from our own on-chain scan (fetchOnchainDayStats) FIRST — it
  // reads the whole 24h window and its makers = distinct tx.origin (real wallets), not a router. RadarDEX
  // is next, and the last-40-trades sample is the final fallback while the 24h scan is still loading. A
  // legit 0 (e.g. a buy-only/honeypot token with 0 sells) is a real value, so only null falls through.
  // ⛔ Browser tab title follows the token on screen. The server writes the title only on a full page load (api/token.js),
  // so moving to another token inside the app left the OLD token's name + price in the tab (owner 09-25: copied the
  // wrong token because of it). Set it here, live, and whenever the price/24h change updates.
  useEffect(() => {
    const chgS = chg != null && isFinite(chg) && Math.abs(chg) < 1e5 ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h)` : '';
    document.title = `$${sym}${px != null ? ` · ${tprice(px)}${chgS}` : ''} — StateraArc`;
  }, [sym, px, chg]);

  const pickNum = (...v: (number | null | undefined)[]) => { const f = v.find((x) => x != null && isFinite(x as number)); return f == null ? null : (f as number); };
  const ocBuys = swaps ? swaps.filter((s) => s.side === 'buy').length : null;
  const ocSells = swaps ? swaps.filter((s) => s.side === 'sell').length : null;
  const buys = pickNum(dayStats?.buys24, rd?.buys24, ocBuys);
  const sells = pickNum(dayStats?.sells24, rd?.sells24, ocSells);
  const buyPct = buys != null && sells != null && buys + sells > 0 ? (buys / (buys + sells)) * 100 : null;
  const txnsF = pickNum(dayStats?.txns24, rd?.txns24, swaps && swaps.length ? swaps.length : null);
  const makersF = pickNum(dayStats?.makers24, rd?.traders24, swaps && swaps.length ? new Set(swaps.map((s) => s.trader)).size : null);
  // Clamp each holder % to [0,100] and cap the top-10 sum at 100 — a bad share (arc-scan) made it read 235%.
  const top10 = holders && holders.length ? Math.min(100, holders.slice(0, 10).reduce((s, h) => s + Math.max(0, Math.min(100, h.percent ?? 0)), 0)) : null;

  // ── Pools for this token + TRUE aggregate liquidity ──────────────────────────────────────────────
  // Only pools with real depth (≥ $100, the indexer's discovery floor) count — a dust pool ($4.71) is
  // noise: it must not show as a "pool", pad the count, or dilute the total. The header/TVL then show the
  // SUM across the token's real pools (the main V3 pair AND its V4 pair), so liquidity is the TRUE total
  // locked, not just the one biggest pool — that single-pool number mislead people (ARGUS read $744K of a
  // real $1.10M). The Pools card underneath breaks that total down per pair.
  const QUOTE_SYM: Record<string, string> = {
    '0x3600000000000000000000000000000000000000': 'USDC',
    '0x384c60f98ecd4c26345499345c03d677e40f115e': 'WARP',
  };
  const quoteSym = (a?: string) => { const k = (a || '').toLowerCase(); return QUOTE_SYM[k] || (k.length >= 10 ? `${k.slice(0, 6)}…` : 'USDC'); };
  const MIN_POOL_LIQ = 100;
  // Pools: every USDC pool read on-chain (V3 fee tiers, V2, the real V4 pool) with its live depth + price. RadarDEX's
  // list only ADDS pools the chain scan doesn't cover (non-USDC pairs such as TOKEN/WARP) — it never replaces one.
  const ocList = (ocPools ?? []).map((p) => ({ pool: p.pool, version: p.version, dex: null as string | null, feeTier: p.feeTier, quote: '0x3600000000000000000000000000000000000000', liquidityUsdc: p.liquidityUsdc, swaps: null as number | null, price: p.price }));
  const ocSet = new Set(ocList.map((p) => p.pool.toLowerCase()));
  const rdExtra = (rd?.pools ?? []).filter((p) => !ocSet.has(p.pool.toLowerCase()) && p.quote !== '0x3600000000000000000000000000000000000000')
    .map((p) => ({ pool: p.pool, version: p.version, dex: p.dex, feeTier: p.feeTier, quote: p.quote, liquidityUsdc: p.liquidityUsdc, swaps: p.swaps, price: null as number | null }));
  // Until the on-chain scan answers, show RadarDEX's list rather than nothing.
  const allPoolsRaw = ocPools == null ? (rd?.pools ?? []).map((p) => ({ pool: p.pool, version: p.version, dex: p.dex, feeTier: p.feeTier, quote: p.quote, liquidityUsdc: p.liquidityUsdc, swaps: p.swaps, price: null as number | null })) : [...ocList, ...rdExtra];
  const allPools = allPoolsRaw.filter((p) => (p.liquidityUsdc ?? 0) >= MIN_POOL_LIQ);
  // True aggregate = sum of the real pools; fall back to RadarDEX's own total only when we have no per-pool data.
  const poolsTotalLiq = allPools.length ? allPools.reduce((s, p) => s + (p.liquidityUsdc ?? 0), 0) : (rd?.liquidityTotal ?? null);

  // ── Liquidity depth + pool age + FDV (RadarDEX first, then on-chain reserves, then seed) ─────────
  // TVL = the TRUE total locked across the token's real pools (main pair + any V4/secondary), not one pool.
  // Take whichever aggregate found more depth — the per-pool on-chain SUM or the seed/indexer figure — but
  // never add them (that would double count). This is why ARGUS reads its full ~$1.10M, not the $744K main pool.
  const tvl = poolsTotalLiq != null && liq != null ? Math.max(poolsTotalLiq, liq) : firstPos(poolsTotalLiq, liq);
  // Total supply: prefer the ON-CHAIN totalSupply() (ground truth — RadarDEX had cirBTC at 233 vs the real
  // 551, making FDV disagree with mcap). Circulating = minted − burnt.
  const mintedSupply = burn?.supply ?? rd?.totalSupply ?? supplyNum ?? null;
  const circSupply = mintedSupply != null ? Math.max(0, mintedSupply - (burnedSupply ?? 0)) : (rd?.circulating ?? null);
  const fdv = (px != null && mintedSupply) ? px * mintedSupply : (rd?.fdv ?? null);
  const valuation = mc ?? fdv ?? null;
  const depthRaw = tvl != null && valuation ? (tvl / valuation) * 100 : null; // pool depth as % of valuation
  const depthPct = depthRaw != null && isFinite(depthRaw) && depthRaw <= 1000 ? depthRaw : null; // display hard rule
  const agoStr = (sec: number) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
  };
  // Pool age = the OLDEST of what we know: the indexer's creation block can be a newer side pool (cirBTC's V4 pool is
  // 3d old, its main V3 pool 129d), so the older date is the one that describes the market.
  const ageSecs = (() => { const a = seed?.createdAt ? Math.max(0, (Date.now() - seed.createdAt) / 1000) : null; const b = rd?.ageSec ?? null; return a == null ? b : b == null ? a : Math.max(a, b); })();
  const ageStr = ageSecs != null ? (ageSecs >= 86400 ? `${Math.floor(ageSecs / 86400)}d` : ageSecs >= 3600 ? `${Math.floor(ageSecs / 3600)}h` : `${Math.floor(ageSecs / 60)}m`) : null;
  // Liquidity & Pool cells — only the ones we actually have (so the panel fills even without RadarDEX).
  const liqCells = ([
    tvl != null ? { v: usd(tvl), l: 'TVL' } : null,
    depthPct != null ? { v: depthPct.toFixed(1) + '%', l: 'Depth / val' } : null,
    fdv != null ? { v: usd(fdv), l: 'FDV' } : null,
    mc != null ? { v: usd(mc), l: 'Mkt Cap' } : null,
    ageStr ? { v: ageStr, l: 'Pool age' } : null,
    rd?.poolSwaps != null ? { v: compact(rd.poolSwaps), l: 'Swaps' } : null,
  ].filter(Boolean)) as { v: string; l: string }[];

  // ── Pool health: a transparent 0–100 score from on-chain signals (NOT a safety guarantee) ────────
  // Mirrors a DEX screener's health read. Each signal is a real, verifiable measurement; weights sum to 100.
  const sig = {
    depth: depthPct == null ? null : Math.max(0, Math.min(100, Math.round((Math.min(depthPct, 10) / 10) * 100))),          // ≥10% of valuation in pool = full marks
    dist: top10 == null ? null : Math.max(0, Math.min(100, Math.round(100 - Math.max(0, top10 - 20) * (100 / 60)))),        // ≤20% top-10 = full; 80%+ = 0
    quality: makersF == null || !txnsF ? null : Math.round(Math.min(100, (makersF / txnsF) * 100)), // unique-trader/txn ratio (on-chain 24h first)
    age: ageSecs == null ? null : Math.round(Math.min(100, (ageSecs / (30 * 86400)) * 100)),                                 // 30d+ = full marks
    vol: chg == null ? null : Math.round(Math.max(0, 100 - Math.min(100, Math.abs(chg)))),                                   // calmer 24h = healthier
  };
  const HW = { depth: 35, dist: 20, quality: 20, age: 15, vol: 10 };
  const healthParts = (Object.keys(HW) as (keyof typeof HW)[]).map((k) => ({ k, v: sig[k], w: HW[k] })).filter((p) => p.v != null) as { k: keyof typeof HW; v: number; w: number }[];
  const healthScore = healthParts.length ? Math.round(healthParts.reduce((s, p) => s + p.v * p.w, 0) / healthParts.reduce((s, p) => s + p.w, 0)) : null;
  const redFlags: string[] = [];
  if (depthPct != null && depthPct < 3) redFlags.push('Pool depth under 3% of valuation');
  if (top10 != null && top10 > 80) redFlags.push(`Top 10 wallets hold ${top10.toFixed(0)}%`);
  // (mintable is shown once, in the Supply card — don't duplicate it here as a red flag)
  const healthLabel = healthScore == null ? '' : healthScore >= 70 ? 'Healthy' : healthScore >= 40 ? 'Caution' : 'High risk';
  const healthClass = healthScore == null ? '' : healthScore >= 70 ? 'good' : healthScore >= 40 ? 'mid' : 'bad';
  const SIG_LABEL: Record<keyof typeof HW, string> = { depth: 'Liquidity Depth', dist: 'Holder Distribution', quality: 'Trading Quality', age: 'Pool Age', vol: 'Stability' };

  const socials = [
    { k: 'Website', u: rd?.website }, { k: 'Twitter', u: rd?.twitter },
    { k: 'Telegram', u: rd?.telegram }, { k: 'Discord', u: rd?.discord },
  ].filter((s) => s.u) as { k: string; u: string }[];
  const chgClass = (v: number | null) => (v == null ? '' : v >= 0 ? 'up' : 'down');
  const chgTxt = (v: number | null) => (v == null || !isFinite(v) || Math.abs(v) > 1e5 ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(v <= -100 || v >= 100 ? 0 : 1)}%`); // display hard rule
  // Classify a raw transfer as a buy/sell using the token's main pool (tokens FROM pool = buy, TO pool = sell).
  const pool = ocPool?.pool ?? rd?.bestPool ?? null;
  const txKind = (t: TokenTransfer): 'buy' | 'sell' | 'xfer' =>
    !pool ? 'xfer' : t.from.toLowerCase() === pool ? 'buy' : t.to.toLowerCase() === pool ? 'sell' : 'xfer';
  const txMaker = (t: TokenTransfer) => (txKind(t) === 'buy' ? t.to : t.from);

  // Arc names for every wallet on this page — traders, transfer makers and top holders. One batched
  // lookup for all of them; only forward-confirmed .arc/.circle names come back, everything else
  // keeps rendering as a hex address. Capped so a huge holder list can't fan out into a big call.
  const nameAddrs = useMemo(() => {
    const set = new Set<string>();
    for (const s2 of (swaps || []).slice(0, 60)) if (s2.trader) set.add(s2.trader.toLowerCase());
    for (const t of (txs || []).slice(0, 60)) { const m = txMaker(t); if (m) set.add(m.toLowerCase()); }
    for (const h of (holders || []).slice(0, 30)) if (h.address) set.add(h.address.toLowerCase());
    return [...set].slice(0, 120);
  }, [swaps, txs, holders]); // eslint-disable-line
  const names = useNames(nameAddrs);
  // The chart pulls Warp candles (same wrong scale as warp.price for non-18-dec tokens). Rescale them
  // to the correct price using the ratio of the trusted seed price to Warp's price (=1 when they agree).
  const chartScale = (warp?.price != null && warp.price > 0 && seed?.price != null && seed.price > 0)
    ? seed.price / warp.price : 1;

  return (
    <div className="wrap"><section className="section">
      <button className="back" onClick={onBack}><IconArrowLeft className="i" /> Back to board</button>

      <div className="td-head" style={{ marginTop: 14 }}>
        <TokenLogo symbol={sym} seed={address} url={warp?.image ?? seed?.iconUrl ?? null} />
        <div className="td-id">
          <div className="td-name">{name || sym}
            {d?.lookalike && <span className="wl-note" style={{ marginLeft: 8 }}>Lookalike</span>}
            {d?.reservedName && <span className="wl-note" style={{ marginLeft: 8 }}>Reserved-name</span>}
          </div>
          <div className="td-sym">{sym} · {d?.standard?.toUpperCase() || 'ERC-20'}{seed?.hooked && <span className="wl-note" style={{ marginLeft: 8 }} title="This token trades on a Uniswap V4 pool with a hook, which can charge a swap tax (buy/sell fee). Verify before trading.">Hooked · may tax</span>}</div>
          <div className="td-share">
            <button className="addr" onClick={copy} title="copy address"><span className="addr-hex">{address.slice(0, 10)}…{address.slice(-8)}</span>{copied ? <><IconCheck className="i" /> Copied</> : <IconCopy className="i" />}</button>
            <button className="addr td-sh" onClick={copyLink} title="Copy a share link — unfurls into a live-price card on X, Telegram and Discord">{linkCopied ? <><IconCheck className="i" /> Link copied</> : <>Copy link</>}</button>
            <button className="addr td-sh" onClick={postToX} title="Post this token on X with its live card"><IconX className="i" /> Post</button>
          </div>
        </div>
        {onTrade && (
          <button className="btn solid td-trade" onClick={() => onTrade({ address, symbol: sym, name, price: px })}>
            Trade<span className="td-trade-sym"> {sym}</span> <IconArrowRight className="arw" />
          </button>
        )}
      </div>

      {err && !d && <div className="side-note" style={{ marginTop: 12 }}>Some extended contract details (creator, size) are temporarily unavailable — the price and market data below are unaffected.</div>}

      <div className="stats td-stats" style={{ marginTop: 12 }}>
        <div className="stat"><div className="v r">{px != null ? tprice(px) : '—'}</div><div className="l">Price</div></div>
        <div className="stat"><div className={`v chg ${chgClass(chg)}`}>{chgTxt(chg)}</div><div className="l">24h</div></div>
        <div className="stat"><div className="v">{mc != null ? usd(mc) : '—'}</div><div className="l">Market Cap</div></div>
        <div className="stat"><div className="v">{tvl != null ? usd(tvl) : '—'}</div><div className="l">Liquidity</div></div>
        <div className="stat"><div className="v">{vol != null ? usd(vol) : '—'}</div><div className="l">Vol 24h</div></div>
        <div className="stat"><div className="v">{fmtNum(holdersTotal)}</div><div className="l">Holders</div></div>
      </div>

      {/* Change over multiple timeframes (DEX-style) */}
      {Object.values(chgBar).some((v) => v != null) && (
        <div className="chg-bar">
          {(Object.entries(chgBar) as [string, number | null][]).map(([l, v]) => (
            <div className="chg-cell" key={l}><span className="chg-l">{l}</span><span className={`chg-v chg ${chgClass(v)}`}>{chgTxt(v)}</span></div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {dec != null && <PriceChart address={address} symbol={sym} decimals={dec} priceScale={chartScale} change24h={chg} />}
      </div>

      {/* Dashboard: token info + activity (left) · pool metrics + health (right) */}
      <div className="td-dash">
        <div className="td-col">
          {/* Info — contract, market details, links */}
          <div className="panel side-card td-info">
            <h3>Info</h3>
            <div className="ir"><span className="ir-k">Contract</span><span className="ir-v mono">{address}</span></div>
            <div className="ir"><span className="ir-k">Standard</span><span className="ir-v">{d?.standard?.toUpperCase() || 'ERC-20'}</span></div>
            <div className="ir"><span className="ir-k">Decimals</span><span className="ir-v">{dec ?? d?.decimals ?? '—'}</span></div>
            {pool && <div className="ir"><span className="ir-k">Pool ID</span><a className="ir-v mono" href={`https://explorer.arc.io/address/${pool}`} target="_blank" rel="noreferrer" style={{ color: 'var(--red-hi)', textDecoration: 'none' }}>{pool.slice(0, 10)}…{pool.slice(-6)}</a></div>}
            {rd?.deployer && <div className="ir"><span className="ir-k">Deployer</span><span className="ir-v mono">{rd.deployer.slice(0, 10)}…{rd.deployer.slice(-6)}</span></div>}
            {warp?.v4 && <div className="ir"><span className="ir-k">Market</span><span className="ir-v">Uniswap v4{warp.fee != null ? ` · ${(warp.fee / 1e4).toFixed(2)}% fee` : ''}</span></div>}
            {burnedPct != null && <div className="ir"><span className="ir-k">Burned</span><span className="ir-v">{burnedPct.toFixed(2)}%</span></div>}
            {rd?.verified && <div className="ir"><span className="ir-k">Verified</span><span className="ir-v" style={{ color: '#4ecb71' }}>Yes</span></div>}
            {warp?.createdAt != null && <div className="ir"><span className="ir-k">Created</span><span className="ir-v">{new Date(warp.createdAt).toLocaleDateString()}</span></div>}
            {!!socials.length && (
              <div className="ir"><span className="ir-k">Links</span><span className="ir-v td-socials">
                {socials.map((s) => <a key={s.k} href={s.u} target="_blank" rel="noreferrer">{s.k} <IconExternal className="i" /></a>)}
              </span></div>
            )}
            <div style={{ marginTop: 12 }}><TokenLinks address={address} scanBase="https://explorer.arc.io" warp /></div>
          </div>

          {/* Trade activity (24h) — buy/sell pressure, traders, txns (RadarDEX) */}
          {(buys != null || sells != null || txnsF != null) && (
            <div className="panel side-card">
              <h3>Trade Activity · 24h</h3>
              {buyPct != null && (
                <div className="bs-bar" title={`Buys ${buys} · Sells ${sells}`}>
                  <div className="bs-buy" style={{ width: `${buyPct}%` }} />
                  <div className="bs-sell" style={{ width: `${100 - buyPct}%` }} />
                </div>
              )}
              <div className="bs-legend">
                <span className="bs-b">Buys {buys != null ? buys.toLocaleString() : '—'}</span>
                <span className="bs-s">Sells {sells != null ? sells.toLocaleString() : '—'}</span>
              </div>
              <div className="ta-grid">
                <div className="ta-cell"><div className="ta-v">{txnsF != null ? txnsF.toLocaleString() : '—'}</div><div className="ta-l">Txns</div></div>
                <div className="ta-cell"><div className="ta-v">{makersF != null ? makersF.toLocaleString() : '—'}</div><div className="ta-l">Makers</div></div>
                <div className="ta-cell"><div className="ta-v">{burnedPct != null ? burnedPct.toFixed(1) + '%' : '—'}</div><div className="ta-l">Burned</div></div>
                <div className="ta-cell"><div className="ta-v">{top10 != null ? top10.toFixed(1) + '%' : '—'}</div><div className="ta-l">Top 10</div></div>
              </div>
            </div>
          )}

        </div>

        <div className="td-col">
          {/* Liquidity & Pool — RadarDEX detail, or on-chain reserves for tokens it doesn't index. */}
          {liqCells.length > 0 && (
            <div className="panel side-card">
              <h3>Liquidity &amp; Pool</h3>
              <div className="ta-grid ta-grid-5">
                {liqCells.map((c) => <div className="ta-cell" key={c.l}><div className="ta-v">{c.v}</div><div className="ta-l">{c.l}</div></div>)}
              </div>
            </div>
          )}

          {/* All pools for this token — directly under Liquidity & Pool (aggregated depth + per-pair, click to expand). */}
          {allPools.length > 0 && (
            <div className="panel side-card pl-card">
              <button className="pl-head" onClick={() => setPoolsOpen((o) => !o)}>
                <h3>Pools · {allPools.length}</h3>
                <span className="pl-sum">
                  {poolsTotalLiq != null && <b>{usd(poolsTotalLiq)}</b>}
                  <span className="pl-cnt">total liq</span>
                  <IconChevronDown className={`pl-chev i ${poolsOpen ? 'open' : ''}`} />
                </span>
              </button>
              {poolsOpen && (
                <div className="pl-list">
                  <div className="pl-row pl-head-row"><span>Pair</span><span className="pl-price">Price</span><span className="pl-liq">Liquidity</span><span className="pl-tx">Tx</span></div>
                  {allPools.map((p) => (
                    <div className="pl-row" key={p.pool}>
                      <span className="pl-pair">{sym}/{quoteSym(p.quote)}{p.feeTier ? <small> · {(p.feeTier / 1e4).toFixed(2)}%</small> : null}<em className="pl-dex">{p.dex || (p.version || '').toUpperCase()}</em></span>
                      <span className="pl-price">{p.price != null ? tprice(p.price) : (px != null ? tprice(px) : '—')}</span>
                      <span className="pl-liq">{p.liquidityUsdc != null ? usd(p.liquidityUsdc) : '—'}{p.swaps != null ? <small>{compact(p.swaps)} swaps</small> : null}</span>
                      <a className="pl-tx" href={`https://explorer.arc.io/address/${p.pool}`} target="_blank" rel="noreferrer"><IconExternal className="i" /></a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pool health — a transparent score from on-chain signals. NOT a safety guarantee. */}
          {healthScore != null && (
            <div className="panel side-card">
              <div className="ph-head">
                <h3 style={{ margin: 0 }}>Pool Health</h3>
                <span className={`ph-score ${healthClass}`}>{healthScore}<i>/100</i> · {healthLabel}</span>
              </div>
              <div className="ph-sigs">
                {healthParts.map((p) => (
                  <div className="ph-sig" key={p.k}>
                    <div className="ph-sig-top"><span>{SIG_LABEL[p.k]}</span><span className="ph-sig-w">{p.v}</span></div>
                    <div className="ph-track"><div className={`ph-fill ${p.v >= 70 ? 'good' : p.v >= 40 ? 'mid' : 'bad'}`} style={{ width: `${p.v}%` }} /></div>
                  </div>
                ))}
              </div>
              {!!redFlags.length && (
                <div className="ph-flags">
                  {redFlags.map((f) => <div className="ph-flag" key={f}><span className="ph-flag-dot" />{f}</div>)}
                </div>
              )}
              <div className="ph-note">Weighted signal from live on-chain data — not a legitimacy or safety certification. DYOR.</div>
            </div>
          )}

          {/* Supply — minted / burnt / circulating / FDV. */}
          {mintedSupply != null && (
            <div className="panel side-card">
              <h3>Supply</h3>
              <div className="ta-grid">
                <div className="ta-cell"><div className="ta-v">{compact(mintedSupply)}</div><div className="ta-l">Minted</div></div>
                <div className="ta-cell"><div className="ta-v">{burnedSupply != null ? compact(burnedSupply) : (burn ? '0' : '—')}</div><div className="ta-l">Burnt{burnedPct != null ? ` ${burnedPct.toFixed(1)}%` : ''}</div></div>
                <div className="ta-cell"><div className="ta-v">{circSupply != null ? compact(circSupply) : '—'}</div><div className="ta-l">Circulating</div></div>
                <div className="ta-cell"><div className="ta-v">{fdv != null ? usd(fdv) : '—'}</div><div className="ta-l">FDV</div></div>
              </div>
              {rd && (rd.mintable || rd.reflection || rd.lpTokenId || rd.totalSupply != null) && (
                <div className="lq-res">
                  {rd.mintable && <span className="lq-r" style={{ color: '#ff5a5a' }}>Mintable</span>}
                  {!rd.mintable && <span className="lq-r" style={{ color: '#4ecb71' }}>Fixed supply</span>}
                  {rd.reflection && <span className="lq-r">Reflection</span>}
                  {rd.lpTokenId && <span className="lq-r">LP #{rd.lpTokenId}</span>}
                </div>
              )}
            </div>
          )}
          {/* Calculator — convert a token amount to USD at the live price. */}
          {px != null && (
            <div className="panel side-card">
              <h3>Calculator</h3>
              <div className="calc">
                <div className="calc-row">
                  <input className="calc-in" inputMode="decimal" placeholder="0.00" value={calcAmt}
                    onChange={(e) => setCalcAmt(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <span className="calc-unit">{sym}</span>
                </div>
                <div className="calc-eq">=</div>
                <div className="calc-row calc-out">
                  <span className="calc-val">{calcAmt && isFinite(+calcAmt) ? usd(+calcAmt * px) : '$0.00'}</span>
                  <span className="calc-unit">USD</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Compact tabbed section — Transactions / Holders (scrolls inside itself, not the page) */}
      <div className="panel td-tabpanel" style={{ marginTop: 12 }}>
        <div className="td-tabs">
          <button className={tab === 'txns' ? 'on' : ''} onClick={() => setTab('txns')}>Transactions</button>
          <button className={tab === 'holders' ? 'on' : ''} onClick={() => setTab('holders')}>Holders{holdersTotal != null ? ` · ${fmtNum(holdersTotal)}` : ''}</button>
        </div>

        {tab === 'txns' && (
          <div className="td-tabbody">
            {swaps && swaps.length ? (() => {
              const rows = swaps.filter((s) => txFilter === 'all' || s.side === txFilter);
              return (<>
                <div className="txf">
                  {(['all', 'buy', 'sell'] as const).map((f) => (
                    <button key={f} className={txFilter === f ? 'on' : ''} onClick={() => setTxFilter(f)}>{f === 'all' ? 'All' : f === 'buy' ? 'Buys' : 'Sells'}</button>
                  ))}
                </div>
                <div className="tr-table">
                  <div className="tr-row tr-head"><span>Age</span><span>Type</span><span className="num">USD</span><span className="num">{sym}</span><span className="num">Price</span><span>Maker</span><span className="num tx">Tx</span></div>
                  {rows.map((s, i) => (
                    <div className="tr-row" key={s.tx + i}>
                      <span className="tr-age">{s.time ? agoStr(s.time) : '—'}</span>
                      <span className={`tr-side ${s.side}`}>{s.side === 'buy' ? 'Buy' : 'Sell'}</span>
                      <span className={`num mono tr-usd ${s.side}`}>{s.usd != null ? usd(s.usd) : '—'}</span>
                      <span className="num mono">{compact(s.amount)}</span>
                      <span className="num mono tr-px">{s.price != null ? tprice(s.price) : '—'}</span>
                      {s.trader ? <a className="tr-mk mono" href={`https://explorer.arc.io/address/${s.trader}`} target="_blank" rel="noreferrer" title={s.trader}>{displayName(s.trader, names, (a) => a.slice(0, 6) + '…' + a.slice(-4))}</a> : <span className="tr-mk mono">…</span>}
                      <a className="tr-tx num tx" href={`https://explorer.arc.io/tx/${s.tx}`} target="_blank" rel="noreferrer"><IconExternal className="i" /></a>
                    </div>
                  ))}
                </div>
              </>);
            })()
              : swaps == null && txs == null ? <div className="side-note">Loading transactions…</div>
              // Fallback: no indexed swaps for this pool yet — show raw on-chain transfers instead.
              : txs && txs.length ? <div className="txn-table">
                  <div className="txn-row txn-head"><span>Type</span><span className="num">Amount</span><span>Maker</span><span className="num tx">Tx</span></div>
                  {txs.map((t, i) => { const k = txKind(t); const mk = txMaker(t); return (
                    <div className="txn-row" key={t.tx + i}>
                      <span className={`txn-type ${k}`}>{k === 'buy' ? 'Buy' : k === 'sell' ? 'Sell' : 'Transfer'}</span>
                      <span className="num mono">{compact(t.amount)} <span className="txn-sym">{sym}</span></span>
                      <a className="txn-mk mono" href={`https://explorer.arc.io/address/${mk}`} target="_blank" rel="noreferrer" title={mk}>{displayName(mk, names, (a) => a.slice(0, 6) + '…' + a.slice(-4))}</a>
                      <a className="txn-tx num tx" href={`https://explorer.arc.io/tx/${t.tx}`} target="_blank" rel="noreferrer"><IconExternal className="i" /></a>
                    </div> ); })}
                </div>
              : <div className="side-note">No recent trades found on-chain.</div>}
          </div>
        )}

        {tab === 'holders' && (
          <div className="td-tabbody">
            {top10 != null && <div className="td-tabsub">Top 10 hold <b>{top10.toFixed(1)}%</b>{holdersTotal != null ? ` · ${fmtNum(holdersTotal)} holders` : ''}</div>}
            {holders == null ? <div className="side-note">Loading holders…</div>
              : !holders.length ? <div className="side-note">No holder data available from the indexer.</div>
              : <div className="hl-list">
                  {holders.map((h) => (
                    <div className="hl-row" key={h.address}>
                      <span className="hl-rank">{h.rank}</span>
                      <a className="hl-addr mono" href={`https://explorer.arc.io/address/${h.address}`} target="_blank" rel="noreferrer" title={h.address}>{displayName(h.address, names, (a) => a.slice(0, 8) + '…' + a.slice(-6))}</a>
                      {h.isPool && <span className="hl-tag pool">POOL</span>}
                      {h.isDeployer && <span className="hl-tag dev">DEV</span>}
                      <span className="hl-barwrap"><span className="hl-bar" style={{ width: `${Math.min(100, h.percent ?? 0)}%` }} /></span>
                      <span className="hl-bal">{compact(h.amount)}</span>
                      <span className="hl-share">{h.percent != null ? h.percent.toFixed(2) + '%' : '—'}</span>
                    </div>
                  ))}
                </div>}
          </div>
        )}
      </div>

      <div className="td-disc" style={{ marginTop: 12 }}>
        Price, liquidity, volume, trades &amp; pools are read live on-chain from Arc mainnet pools (Uniswap V3/V4, chain 5042); holders &amp; contract data via arc-scan; some launchpad coverage via Warp (circlewarp.fun) &amp; RadarDEX. All unofficial, not Circle. Unverified; DYOR.
      </div>
    </section></div>
  );
}
