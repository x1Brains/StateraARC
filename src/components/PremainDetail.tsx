import { useEffect, useState } from 'react';
import { TokenLogo } from './TokenLogo';
import { PriceChart } from './PriceChart';
import { TokenLinks } from './TokenLinks';
import { fetchWarpToken, type WarpToken } from '../lib/warp';
import { usd, tprice, compact, fetchTokenTransfers, fetchRadarTokenDetail, fetchRadarHolders, fetchRadarSwaps, fetchPoolTrades, fetchOnchainPoolStats, fetchAllOnchainPools, fetchOnchainDayStats, type TokenTransfer, type RadarTokenDetail, type RadarHolder, type RadarSwap, type OnchainPool } from '../lib/arc';
import type { Token } from '../lib/arc';
import { IconArrowLeft, IconArrowRight, IconExternal, IconCheck, IconCopy, IconChevronDown } from './icons';

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

export function PremainDetail({ address, seed, onBack, onTrade }: { address: string; seed?: Token; onBack: () => void; onTrade?: (t: { address: string; symbol: string; name?: string; price?: number | null }) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [warp, setWarp] = useState<WarpToken | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rd, setRd] = useState<RadarTokenDetail | null>(null);
  const [holders, setHolders] = useState<RadarHolder[] | null>(null);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [txs, setTxs] = useState<TokenTransfer[] | null>(null);
  const [swaps, setSwaps] = useState<RadarSwap[] | null>(null);
  const [ocPool, setOcPool] = useState<{ tvl: number | null; reserveQuote: number | null; reserveBase: number | null; price?: number | null } | null>(null);
  const [ocPools, setOcPools] = useState<OnchainPool[] | null>(null);
  const [dayStats, setDayStats] = useState<{ change24h: number | null; volume24h: number | null } | null>(null);
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
    let alive = true; setRd(null); setHolders(null); setHolderCount(null); setTxs(null); setSwaps(null); setOcPool(null); setOcPools(null);
    (async () => {
      const detail = await fetchRadarTokenDetail(address).catch(() => null);
      if (alive) setRd(detail);
      const dec = detail?.decimals ?? 18;
      // If RadarDEX doesn't index this token, read the pool reserves on-chain so Liquidity & Pool fills.
      if (!detail || detail.liquidityUsdc == null) {
        fetchOnchainPoolStats(address, dec).then((s) => { if (alive) setOcPool(s); }).catch(() => {});
      }
      // Pools breakdown: if RadarDEX has no per-pool data (WARP tokens like ARGUS), discover every USDC
      // pool on-chain (V3 fee tiers + V2) so the Pools card still shows real depth/price per pair.
      if (!detail?.pools || detail.pools.length === 0) {
        fetchAllOnchainPools(address, dec).then((ps) => { if (alive) setOcPools(ps); }).catch(() => {});
      }
      // 24H change + 24h volume on-chain when no indexer has them (V4/launchpad coins) so the header fills.
      if (detail?.volume24 == null && detail?.change24h == null) {
        fetchOnchainDayStats(address, dec).then((s) => { if (alive) setDayStats(s); }).catch(() => {});
      }
      fetchRadarHolders(address, dec, 100).then((h) => { if (alive) { setHolders(h.holders); setHolderCount(h.holderCount); } }).catch(() => { if (alive) setHolders([]); });
      // Real trades feed: RadarDEX indexed swaps first; if it doesn't index this token (ARGUS etc.),
      // decode the pool's on-chain Swap events so we still show Buy/Sell — never "Transfer".
      fetchRadarSwaps(address, dec, 50).then(async (s) => {
        if (s && s.length) { if (alive) setSwaps(s); return; }
        const oc = await fetchPoolTrades(address, dec, 40).catch(() => [] as RadarSwap[]);
        if (alive) setSwaps(oc);
      }).catch(async () => {
        const oc = await fetchPoolTrades(address, dec, 40).catch(() => [] as RadarSwap[]);
        if (alive) setSwaps(oc);
      });
    })();
    fetchTokenTransfers(address, 18, 40).then((t) => { if (alive) setTxs(t); }).catch(() => { if (alive) setTxs([]); });
    return () => { alive = false; };
  }, [address]);

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

  const copy = () => { navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const fmtNum = (n: number | null) => (n == null ? '—' : n.toLocaleString());

  const sym = d?.symbol || seed?.symbol || '?';
  const name = d?.name || seed?.name || '';
  // Price/liq/mcap: prefer the screener SEED (RadarDEX — decimals-aware, correct for 8/6-dec tokens
  // like cirBTC/WBTC), then Warp. ⚠️ Warp's API reports price IGNORING token decimals, so an 8-dec
  // token (cirBTC) comes back 10^(18-8)=10^10 too high — never trust warp.price over the seed.
  const supplyNum = d?.supply ? Number(d.supply) : (seed?.totalSupply != null ? Number(seed.totalSupply) : null);
  const px = seed?.price ?? warp?.price ?? ocPool?.price ?? null; // ocPool covers V4-only launchpad coins (GLITCH)
  const liq = seed?.liq ?? warp?.liquidity ?? ocPool?.tvl ?? null; // ocPool.tvl covers V4-only coins (GLITCH)
  const mc = seed?.mcap ?? warp?.mcap ?? (px != null && supplyNum ? px * supplyNum : null);
  const vol = rd?.volume24 ?? seed?.volume24h ?? warp?.volume24h ?? dayStats?.volume24h ?? null;
  const chg = rd?.change24h ?? seed?.change24h ?? dayStats?.change24h ?? null;
  // Holder count: on-chain (arc-scan) and Warp agree and are ground truth; RadarDEX's count is stale/
  // partial (it only lists ~50 rows and undercounted ARGUS 12k vs the real 18k), so it goes LAST — else
  // it loaded late and OVERRODE the correct number, making the header flip 18k -> 12k.
  const holdersTotal = d?.holders ?? warp?.holders ?? seed?.holders ?? holderCount ?? null;
  // Buy/sell pressure (24h) + top-10 concentration for the DEX-style panels.
  const buys = rd?.buys24 ?? null, sells = rd?.sells24 ?? null;
  const buyPct = buys != null && sells != null && buys + sells > 0 ? (buys / (buys + sells)) * 100 : null;
  const top10 = holders && holders.length ? holders.slice(0, 10).reduce((s, h) => s + (h.percent ?? 0), 0) : null;

  // ── Liquidity depth + pool age + FDV (RadarDEX first, then on-chain reserves, then seed) ─────────
  const tvl = rd?.liquidityTotal ?? rd?.liquidityUsdc ?? ocPool?.tvl ?? liq ?? null; // aggregate across all pools
  const reserveBase = rd?.reserveBase ?? ocPool?.reserveBase ?? null;
  const reserveQuote = rd?.reserveQuote ?? ocPool?.reserveQuote ?? null;
  const fdv = rd?.fdv ?? (px != null && (rd?.totalSupply ?? supplyNum) ? px * (rd?.totalSupply ?? supplyNum)! : null);
  const valuation = mc ?? fdv ?? null;
  const depthPct = tvl != null && valuation ? (tvl / valuation) * 100 : null; // pool depth as % of valuation
  const agoStr = (sec: number) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
  };
  const ageStr = rd?.ageSec != null ? (rd.ageSec >= 86400 ? `${Math.floor(rd.ageSec / 86400)}d` : rd.ageSec >= 3600 ? `${Math.floor(rd.ageSec / 3600)}h` : `${Math.floor(rd.ageSec / 60)}m`) : null;
  // Liquidity & Pool cells — only the ones we actually have (so the panel fills even without RadarDEX).
  const liqCells = ([
    tvl != null ? { v: usd(tvl), l: 'TVL' } : null,
    depthPct != null ? { v: depthPct.toFixed(1) + '%', l: 'Depth / val' } : null,
    fdv != null ? { v: usd(fdv), l: 'FDV' } : null,
    mc != null ? { v: usd(mc), l: 'Mkt Cap' } : null,
    ageStr ? { v: ageStr, l: 'Pool age' } : null,
    rd?.poolSwaps != null ? { v: compact(rd.poolSwaps), l: 'Swaps' } : null,
  ].filter(Boolean)) as { v: string; l: string }[];

  // All pools for this token (per-pair breakdown). Resolve the quote side's ticker for the pair label.
  const QUOTE_SYM: Record<string, string> = {
    '0x3600000000000000000000000000000000000000': 'USDC',
    '0x384c60f98ecd4c26345499345c03d677e40f115e': 'WARP',
  };
  const quoteSym = (a?: string) => { const k = (a || '').toLowerCase(); return QUOTE_SYM[k] || (k.length >= 10 ? `${k.slice(0, 6)}…` : 'USDC'); };
  // Unified pool list: RadarDEX per-pool data when it has it, else the on-chain discovery (WARP tokens).
  const allPools = (rd?.pools && rd.pools.length
    ? rd.pools.map((p) => ({ pool: p.pool, version: p.version, dex: p.dex, feeTier: p.feeTier, quote: p.quote, liquidityUsdc: p.liquidityUsdc, swaps: p.swaps, price: null as number | null }))
    : (ocPools ?? []).map((p) => ({ pool: p.pool, version: p.version, dex: null as string | null, feeTier: p.feeTier, quote: p.quote, liquidityUsdc: p.liquidityUsdc, swaps: null as number | null, price: p.price })));
  const poolsTotalLiq = rd?.liquidityTotal ?? (allPools.length ? allPools.reduce((s, p) => s + (p.liquidityUsdc ?? 0), 0) : null);

  // ── Pool health: a transparent 0–100 score from on-chain signals (NOT a safety guarantee) ────────
  // Mirrors a DEX screener's health read. Each signal is a real, verifiable measurement; weights sum to 100.
  const sig = {
    depth: depthPct == null ? null : Math.max(0, Math.min(100, Math.round((Math.min(depthPct, 10) / 10) * 100))),          // ≥10% of valuation in pool = full marks
    dist: top10 == null ? null : Math.max(0, Math.min(100, Math.round(100 - Math.max(0, top10 - 20) * (100 / 60)))),        // ≤20% top-10 = full; 80%+ = 0
    quality: rd?.traders24 == null || rd?.txns24 == null || rd.txns24 === 0 ? null : Math.round(Math.min(100, (rd.traders24 / rd.txns24) * 100)), // unique-trader/txn ratio
    age: rd?.ageSec == null ? null : Math.round(Math.min(100, (rd.ageSec / (30 * 86400)) * 100)),                            // 30d+ = full marks
    vol: chg == null ? null : Math.round(Math.max(0, 100 - Math.min(100, Math.abs(chg)))),                                   // calmer 24h = healthier
  };
  const HW = { depth: 35, dist: 20, quality: 20, age: 15, vol: 10 };
  const healthParts = (Object.keys(HW) as (keyof typeof HW)[]).map((k) => ({ k, v: sig[k], w: HW[k] })).filter((p) => p.v != null) as { k: keyof typeof HW; v: number; w: number }[];
  const healthScore = healthParts.length ? Math.round(healthParts.reduce((s, p) => s + p.v * p.w, 0) / healthParts.reduce((s, p) => s + p.w, 0)) : null;
  const redFlags: string[] = [];
  if (depthPct != null && depthPct < 3) redFlags.push('Pool depth under 3% of valuation');
  if (top10 != null && top10 > 80) redFlags.push(`Top 10 wallets hold ${top10.toFixed(0)}%`);
  if (rd?.mintable) redFlags.push('Supply is mintable');
  const healthLabel = healthScore == null ? '' : healthScore >= 70 ? 'Healthy' : healthScore >= 40 ? 'Caution' : 'High risk';
  const healthClass = healthScore == null ? '' : healthScore >= 70 ? 'good' : healthScore >= 40 ? 'mid' : 'bad';
  const SIG_LABEL: Record<keyof typeof HW, string> = { depth: 'Liquidity Depth', dist: 'Holder Distribution', quality: 'Trading Quality', age: 'Pool Age', vol: 'Stability' };

  const socials = [
    { k: 'Website', u: rd?.website }, { k: 'Twitter', u: rd?.twitter },
    { k: 'Telegram', u: rd?.telegram }, { k: 'Discord', u: rd?.discord },
  ].filter((s) => s.u) as { k: string; u: string }[];
  const chgClass = (v: number | null) => (v == null ? '' : v >= 0 ? 'up' : 'down');
  const chgTxt = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(v <= -100 || v >= 100 ? 0 : 1)}%`);
  // Classify a raw transfer as a buy/sell using the token's main pool (tokens FROM pool = buy, TO pool = sell).
  const pool = rd?.bestPool ?? null;
  const txKind = (t: TokenTransfer): 'buy' | 'sell' | 'xfer' =>
    !pool ? 'xfer' : t.from.toLowerCase() === pool ? 'buy' : t.to.toLowerCase() === pool ? 'sell' : 'xfer';
  const txMaker = (t: TokenTransfer) => (txKind(t) === 'buy' ? t.to : t.from);
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
          <div className="td-sym">{sym} · {d?.standard?.toUpperCase() || 'ERC-20'}</div>
          <button className="addr" onClick={copy} title="copy address"><span className="addr-hex">{address.slice(0, 10)}…{address.slice(-8)}</span>{copied ? <><IconCheck className="i" /> Copied</> : <IconCopy className="i" />}</button>
        </div>
        {onTrade && (
          <button className="btn solid td-trade" onClick={() => onTrade({ address, symbol: sym, name, price: px })}>
            Trade {sym} <IconArrowRight className="arw" />
          </button>
        )}
      </div>

      {err && !d && <div className="side-note" style={{ marginTop: 12 }}>Some extended contract details (creator, size) are temporarily unavailable — the price and market data below are unaffected.</div>}

      <div className="stats td-stats" style={{ marginTop: 12 }}>
        <div className="stat"><div className="v r">{px != null ? tprice(px) : '—'}</div><div className="l">Price</div></div>
        <div className="stat"><div className={`v chg ${chgClass(chg)}`}>{chgTxt(chg)}</div><div className="l">24h</div></div>
        <div className="stat"><div className="v">{mc != null ? usd(mc) : '—'}</div><div className="l">Market Cap</div></div>
        <div className="stat"><div className="v">{liq != null ? usd(liq) : '—'}</div><div className="l">Liquidity</div></div>
        <div className="stat"><div className="v">{vol != null ? usd(vol) : '—'}</div><div className="l">Vol 24h</div></div>
        <div className="stat"><div className="v">{fmtNum(holdersTotal)}</div><div className="l">Holders</div></div>
      </div>

      {/* Change over multiple timeframes (DEX-style) */}
      {rd && (rd.change5m != null || rd.change1h != null || rd.change6h != null || rd.change24h != null) && (
        <div className="chg-bar">
          {([['5m', rd.change5m], ['1h', rd.change1h], ['6h', rd.change6h], ['24h', rd.change24h]] as const).map(([l, v]) => (
            <div className="chg-cell" key={l}><span className="chg-l">{l}</span><span className={`chg-v chg ${chgClass(v)}`}>{chgTxt(v)}</span></div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <PriceChart address={address} symbol={sym} decimals={d?.decimals ?? 18} priceScale={chartScale} change24h={chg} />
      </div>

      {/* Dashboard: token info + activity (left) · pool metrics + health (right) */}
      <div className="td-dash">
        <div className="td-col">
          {/* Info — contract, market details, links */}
          <div className="panel side-card td-info">
            <h3>Info</h3>
            <div className="ir"><span className="ir-k">Contract</span><span className="ir-v mono">{address}</span></div>
            <div className="ir"><span className="ir-k">Standard</span><span className="ir-v">{d?.standard?.toUpperCase() || 'ERC-20'}</span></div>
            <div className="ir"><span className="ir-k">Decimals</span><span className="ir-v">{d?.decimals ?? '—'}</span></div>
            {rd?.bestPool && <div className="ir"><span className="ir-k">Pool ID</span><a className="ir-v mono" href={`https://explorer.arc.io/address/${rd.bestPool}`} target="_blank" rel="noreferrer" style={{ color: 'var(--red-hi)', textDecoration: 'none' }}>{rd.bestPool.slice(0, 10)}…{rd.bestPool.slice(-6)}</a></div>}
            {rd?.deployer && <div className="ir"><span className="ir-k">Deployer</span><span className="ir-v mono">{rd.deployer.slice(0, 10)}…{rd.deployer.slice(-6)}</span></div>}
            {warp?.v4 && <div className="ir"><span className="ir-k">Market</span><span className="ir-v">Uniswap v4{warp.fee != null ? ` · ${(warp.fee / 1e4).toFixed(2)}% fee` : ''}</span></div>}
            {rd?.burnedPct != null && <div className="ir"><span className="ir-k">Burned</span><span className="ir-v">{rd.burnedPct.toFixed(2)}%</span></div>}
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
          {rd && (buys != null || sells != null || rd.txns24 != null) && (
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
                <div className="ta-cell"><div className="ta-v">{rd.txns24 != null ? rd.txns24.toLocaleString() : '—'}</div><div className="ta-l">Txns</div></div>
                <div className="ta-cell"><div className="ta-v">{rd.traders24 != null ? rd.traders24.toLocaleString() : '—'}</div><div className="ta-l">Makers</div></div>
                <div className="ta-cell"><div className="ta-v">{rd.burnedPct != null ? rd.burnedPct.toFixed(1) + '%' : '—'}</div><div className="ta-l">Burned</div></div>
                <div className="ta-cell"><div className="ta-v">{top10 != null ? top10.toFixed(1) + '%' : '—'}</div><div className="ta-l">Top 10</div></div>
              </div>
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

        <div className="td-col">
          {/* Liquidity & Pool — RadarDEX detail, or on-chain reserves for tokens it doesn't index. */}
          {liqCells.length > 0 && (
            <div className="panel side-card">
              <h3>Liquidity &amp; Pool</h3>
              <div className="ta-grid ta-grid-5">
                {liqCells.map((c) => <div className="ta-cell" key={c.l}><div className="ta-v">{c.v}</div><div className="ta-l">{c.l}</div></div>)}
              </div>
              {(reserveBase != null || reserveQuote != null) && (
                <div className="lq-res">
                  {reserveBase != null && <span className="lq-r"><b>{compact(reserveBase)}</b> {sym}</span>}
                  {reserveQuote != null && <span className="lq-r"><b>{compact(reserveQuote)}</b> {rd?.quoteSymbol || 'USDC'}</span>}
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
          {rd && rd.totalSupply != null && (
            <div className="panel side-card">
              <h3>Supply</h3>
              <div className="ta-grid">
                <div className="ta-cell"><div className="ta-v">{compact(rd.totalSupply)}</div><div className="ta-l">Minted</div></div>
                <div className="ta-cell"><div className="ta-v">{rd.burnedSupply != null ? compact(rd.burnedSupply) : '—'}</div><div className="ta-l">Burnt{rd.burnedPct != null ? ` ${rd.burnedPct.toFixed(1)}%` : ''}</div></div>
                <div className="ta-cell"><div className="ta-v">{rd.circulating != null ? compact(rd.circulating) : compact(rd.totalSupply)}</div><div className="ta-l">Circulating</div></div>
                <div className="ta-cell"><div className="ta-v">{fdv != null ? usd(fdv) : '—'}</div><div className="ta-l">FDV</div></div>
              </div>
              {(rd.mintable || rd.reflection || rd.lpTokenId) && (
                <div className="lq-res">
                  {rd.mintable && <span className="lq-r" style={{ color: '#ff5a5a' }}>Mintable</span>}
                  {!rd.mintable && <span className="lq-r" style={{ color: '#4ecb71' }}>Fixed supply</span>}
                  {rd.reflection && <span className="lq-r">Reflection</span>}
                  {rd.lpTokenId && <span className="lq-r">LP #{rd.lpTokenId}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* All pools for this token — aggregated depth + per-pair breakdown (click to expand). */}
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
                      <a className="tr-mk mono" href={`https://explorer.arc.io/address/${s.trader}`} target="_blank" rel="noreferrer">{s.trader.slice(0, 6)}…{s.trader.slice(-4)}</a>
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
                      <a className="txn-mk mono" href={`https://explorer.arc.io/address/${mk}`} target="_blank" rel="noreferrer">{mk.slice(0, 6)}…{mk.slice(-4)}</a>
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
                      <a className="hl-addr mono" href={`https://explorer.arc.io/address/${h.address}`} target="_blank" rel="noreferrer">{h.address.slice(0, 8)}…{h.address.slice(-6)}</a>
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
        Price, chart &amp; market data via Warp (circlewarp.fun) &amp; RadarDEX on Arc mainnet (chain 5042). Contract/holder data from independent indexers. All unofficial, not Circle. Unverified; DYOR.
      </div>
    </section></div>
  );
}
