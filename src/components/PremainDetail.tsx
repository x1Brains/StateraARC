import { useEffect, useState } from 'react';
import { TokenLogo } from './TokenLogo';
import { PriceChart } from './PriceChart';
import { TokenLinks } from './TokenLinks';
import { fetchWarpToken, type WarpToken } from '../lib/warp';
import { usd, tprice, compact, fetchTokenTransfers, fetchRadarTokenDetail, fetchRadarHolders, type TokenTransfer, type RadarTokenDetail, type RadarHolder } from '../lib/arc';
import type { Token } from '../lib/arc';
import { IconArrowLeft, IconArrowRight, IconExternal, IconCheck, IconCopy } from './icons';

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
  const [tab, setTab] = useState<'txns' | 'holders'>('txns');

  // Warp (chain 5042) price/mcap + it backs the candlestick chart below.
  useEffect(() => {
    let alive = true; setWarp(null);
    fetchWarpToken(address).then((w) => { if (alive) setWarp(w); });
    return () => { alive = false; };
  }, [address]);

  // DEX-style detail: RadarDEX token stats (buys/sells/burned/change) + rich holders (with pool/dev
  // flags + accurate %), plus recent on-chain transfers (mainnet RPC).
  useEffect(() => {
    let alive = true; setRd(null); setHolders(null); setHolderCount(null); setTxs(null);
    (async () => {
      const detail = await fetchRadarTokenDetail(address).catch(() => null);
      if (alive) setRd(detail);
      const dec = detail?.decimals ?? 18;
      fetchRadarHolders(address, dec, 100).then((h) => { if (alive) { setHolders(h.holders); setHolderCount(h.holderCount); } }).catch(() => { if (alive) setHolders([]); });
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
  const px = seed?.price ?? warp?.price ?? null;
  const liq = seed?.liq ?? warp?.liquidity ?? null;
  const mc = seed?.mcap ?? warp?.mcap ?? (px != null && supplyNum ? px * supplyNum : null);
  const vol = rd?.volume24 ?? seed?.volume24h ?? warp?.volume24h ?? null;
  const chg = rd?.change24h ?? seed?.change24h ?? null;
  const holdersTotal = holderCount ?? seed?.holders ?? warp?.holders ?? d?.holders ?? null;
  // Buy/sell pressure (24h) + top-10 concentration for the DEX-style panels.
  const buys = rd?.buys24 ?? null, sells = rd?.sells24 ?? null;
  const buyPct = buys != null && sells != null && buys + sells > 0 ? (buys / (buys + sells)) * 100 : null;
  const top10 = holders && holders.length ? holders.slice(0, 10).reduce((s, h) => s + (h.percent ?? 0), 0) : null;
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

      <div className="prepublic-banner" style={{ marginTop: 14 }}>
        <span className="pp-dot" />
        <div><b>Arc Mainnet · chain 5042</b> — unofficial data from independent indexers (arc-scan.org · Warp), <b>not Circle</b>. Holder/supply figures are indexer-computed and unverified. Impersonation is common on this chain — trust the <b>exact address</b>, not the symbol.</div>
      </div>

      <div className="td-head">
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
        <PriceChart address={address} symbol={sym} decimals={d?.decimals ?? 18} priceScale={chartScale} />
      </div>

      {/* Trade activity (24h) — buy/sell pressure, traders, txns (RadarDEX) */}
      {rd && (buys != null || sells != null || rd.txns24 != null) && (
        <div className="panel side-card" style={{ marginTop: 12 }}>
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
            <div className="ta-cell"><div className="ta-v">{rd.traders24 != null ? rd.traders24.toLocaleString() : '—'}</div><div className="ta-l">Traders</div></div>
            <div className="ta-cell"><div className="ta-v">{rd.burnedPct != null ? rd.burnedPct.toFixed(1) + '%' : '—'}</div><div className="ta-l">Burned</div></div>
            <div className="ta-cell"><div className="ta-v">{top10 != null ? top10.toFixed(1) + '%' : '—'}</div><div className="ta-l">Top 10</div></div>
          </div>
        </div>
      )}

      {/* Info — its own always-visible section (contract, market details, links) */}
      <div className="panel side-card td-info" style={{ marginTop: 12 }}>
        <h3>Info</h3>
        <div className="ir"><span className="ir-k">Contract</span><span className="ir-v mono">{address}</span></div>
        <div className="ir"><span className="ir-k">Standard</span><span className="ir-v">{d?.standard?.toUpperCase() || 'ERC-20'}</span></div>
        <div className="ir"><span className="ir-k">Decimals</span><span className="ir-v">{d?.decimals ?? '—'}</span></div>
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

      {/* Compact tabbed section — Transactions / Holders (scrolls inside itself, not the page) */}
      <div className="panel td-tabpanel" style={{ marginTop: 12 }}>
        <div className="td-tabs">
          <button className={tab === 'txns' ? 'on' : ''} onClick={() => setTab('txns')}>Transactions</button>
          <button className={tab === 'holders' ? 'on' : ''} onClick={() => setTab('holders')}>Holders{holdersTotal != null ? ` · ${fmtNum(holdersTotal)}` : ''}</button>
        </div>

        {tab === 'txns' && (
          <div className="td-tabbody">
            {txs == null ? <div className="side-note">Loading transactions…</div>
              : !txs.length ? <div className="side-note">No recent transfers found on-chain.</div>
              : <div className="txn-table">
                  <div className="txn-row txn-head"><span>Type</span><span className="num">Amount</span><span>Maker</span><span className="num tx">Tx</span></div>
                  {txs.map((t, i) => { const k = txKind(t); const mk = txMaker(t); return (
                    <div className="txn-row" key={t.tx + i}>
                      <span className={`txn-type ${k}`}>{k === 'buy' ? 'Buy' : k === 'sell' ? 'Sell' : 'Transfer'}</span>
                      <span className="num mono">{compact(t.amount)} <span className="txn-sym">{sym}</span></span>
                      <a className="txn-mk mono" href={`https://explorer.arc.io/address/${mk}`} target="_blank" rel="noreferrer">{mk.slice(0, 6)}…{mk.slice(-4)}</a>
                      <a className="txn-tx num tx" href={`https://explorer.arc.io/tx/${t.tx}`} target="_blank" rel="noreferrer"><IconExternal className="i" /></a>
                    </div> ); })}
                </div>}
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
