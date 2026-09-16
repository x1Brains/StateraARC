import { useEffect, useState } from 'react';
import { TokenLogo } from './TokenLogo';
import { PriceChart } from './PriceChart';
import { TokenLinks } from './TokenLinks';
import { fetchWarpToken, type WarpToken } from '../lib/warp';
import { usd, tprice, compact, fetchTokenHolders, fetchTokenTransfers, type Holder, type TokenTransfer } from '../lib/arc';
import type { Token } from '../lib/arc';

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
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [txs, setTxs] = useState<TokenTransfer[] | null>(null);

  // Warp (chain 5042) price/mcap + it backs the candlestick chart below.
  useEffect(() => {
    let alive = true; setWarp(null);
    fetchWarpToken(address).then((w) => { if (alive) setWarp(w); });
    return () => { alive = false; };
  }, [address]);

  // Top holders (arc-scan) + recent on-chain transfers (mainnet RPC) — for the sections below.
  useEffect(() => {
    let alive = true; setHolders(null); setTxs(null);
    fetchTokenHolders(address, 20).then((h) => { if (alive) setHolders(h); }).catch(() => { if (alive) setHolders([]); });
    fetchTokenTransfers(address, 18, 15).then((t) => { if (alive) setTxs(t); }).catch(() => { if (alive) setTxs([]); });
    return () => { alive = false; };
  }, [address]);

  useEffect(() => {
    let alive = true;
    setD(null); setErr(null);
    (async () => {
      try {
        const r = await fetch(`${REST}/tokens/${address}`, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
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
      } catch (e: any) { if (alive) setErr(e.message || 'failed to load from indexer'); }
    })();
    return () => { alive = false; };
  }, [address]); // eslint-disable-line

  const copy = () => { navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const fmtNum = (n: number | null) => (n == null ? '—' : n.toLocaleString());
  const fmtSupply = (s: string | null) => {
    if (!s) return '—';
    const n = Number(s); if (!isFinite(n)) return s;
    return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n.toLocaleString();
  };

  const sym = d?.symbol || seed?.symbol || '?';
  const name = d?.name || seed?.name || '';
  // Price/liq/mcap: Warp for Warp-launched tokens, else the on-chain pool data from the screener seed
  // (deep V3/WarpV2 tokens like ARGUS aren't on Warp). Market cap = price × total supply when needed.
  const supplyNum = d?.supply ? Number(d.supply) : (seed?.totalSupply != null ? Number(seed.totalSupply) : null);
  const px = warp?.price ?? seed?.price ?? null;
  const liq = warp?.liquidity ?? seed?.liq ?? null;
  const mc = warp?.mcap ?? seed?.mcap ?? (px != null && supplyNum ? px * supplyNum : null);
  const vol = warp?.volume24h ?? null;

  return (
    <div className="wrap"><section className="section">
      <button className="back" onClick={onBack}>← Back to board</button>

      <div className="prepublic-banner" style={{ marginTop: 14 }}>
        <span className="pp-dot" />
        <div><b>Arc Mainnet · chain 5042</b> — unofficial data from independent indexers (arc-scan.org · Warp), <b>not Circle</b>. Holder/supply figures are indexer-computed and unverified. Impersonation is common on this chain — trust the <b>exact address</b>, not the symbol.</div>
      </div>

      <div className="td-head">
        <TokenLogo symbol={sym} seed={address} url={warp?.image ?? null} />
        <div className="td-id">
          <div className="td-name">{name || sym}
            {d?.lookalike && <span className="wl-note" style={{ marginLeft: 8 }}>Lookalike</span>}
            {d?.reservedName && <span className="wl-note" style={{ marginLeft: 8 }}>Reserved-name</span>}
          </div>
          <div className="td-sym">{sym} · {d?.standard?.toUpperCase() || 'ERC-20'}</div>
          <button className="addr" onClick={copy} title="copy address">{address.slice(0, 10)}…{address.slice(-8)} {copied ? '✓ copied' : '⧉'}</button>
        </div>
        {onTrade && (
          <button className="btn solid td-trade" onClick={() => onTrade({ address, symbol: sym, name, price: warp?.price ?? seed?.price ?? null })}>
            Trade {sym} <span className="arw">→</span>
          </button>
        )}
      </div>

      {err && <div className="msg err">Indexer error: {err}. The indexer source (arc-scan.org) is flaky — try again.</div>}

      <div className="stats" style={{ marginTop: 16 }}>
        <div className="stat"><div className="v r">{px != null ? tprice(px) : '—'}</div><div className="l">Price</div></div>
        <div className="stat"><div className="v">{mc != null ? usd(mc) : '—'}</div><div className="l">Market Cap</div></div>
        <div className="stat"><div className="v">{vol != null ? usd(vol) : '—'}</div><div className="l">Vol 24h</div></div>
        <div className="stat"><div className="v">{liq != null ? usd(liq) : '—'}</div><div className="l">Liquidity</div></div>
        <div className="stat"><div className="v">{fmtNum(warp?.holders ?? d?.holders ?? seed?.holders ?? null)}</div><div className="l">Holders</div></div>
        <div className="stat"><div className="v">{fmtSupply(d?.supply ?? null)}</div><div className="l">Total Supply</div></div>
      </div>

      <div style={{ marginTop: 16 }}>
        <PriceChart address={address} symbol={sym} decimals={d?.decimals ?? 18} />
      </div>

      <div className="panel side-card" style={{ marginTop: 16 }}>
        <h3>Token info</h3>
        <div className="ir"><span className="ir-k">Contract</span><span className="ir-v mono">{address}</span></div>
        <div className="ir"><span className="ir-k">Standard</span><span className="ir-v">{d?.standard?.toUpperCase() || 'ERC-20'}</span></div>
        <div className="ir"><span className="ir-k">Decimals</span><span className="ir-v">{d?.decimals ?? '—'}</span></div>
        {d?.creator && <div className="ir"><span className="ir-k">Creator</span><span className="ir-v mono">{d.creator.slice(0, 10)}…{d.creator.slice(-6)}</span></div>}
        {d?.size != null && <div className="ir"><span className="ir-k">Bytecode</span><span className="ir-v">{d.size.toLocaleString()} bytes</span></div>}
        {warp?.v4 && <div className="ir"><span className="ir-k">Market</span><span className="ir-v">Uniswap v4{warp.fee != null ? ` · ${(warp.fee / 1e4).toFixed(2)}% fee` : ''}</span></div>}
        {warp?.topHolderBps != null && <div className="ir"><span className="ir-k">Top holder</span><span className="ir-v">{(warp.topHolderBps / 100).toFixed(1)}%</span></div>}
        {warp?.createdAt != null && <div className="ir"><span className="ir-k">Created</span><span className="ir-v">{new Date(warp.createdAt).toLocaleDateString()}</span></div>}
        {d?.reservedCheck && <div className="ir"><span className="ir-k">Reserved-name check</span><span className="ir-v">{d.reservedCheck}</span></div>}
      </div>

      {/* Top holders (arc-scan) */}
      <div className="panel side-card" style={{ marginTop: 16 }}>
        <h3>Top Holders{holders && holders.length ? ` · ${holders.length}` : ''}</h3>
        {holders == null ? <div className="side-note">Loading holders…</div>
          : !holders.length ? <div className="side-note">No holder data available from the indexer.</div>
          : <div className="hl-list">
              {holders.map((h) => (
                <div className="hl-row" key={h.address}>
                  <span className="hl-rank">{h.rank}</span>
                  <a className="hl-addr mono" href={`https://arc-scan.org/address/${h.address}`} target="_blank" rel="noreferrer">{h.address.slice(0, 8)}…{h.address.slice(-6)}{h.isContract ? ' · pool/contract' : ''}</a>
                  <span className="hl-bal">{compact(h.balance)}</span>
                  <span className="hl-share">{h.share != null ? h.share.toFixed(2) + '%' : '—'}</span>
                </div>
              ))}
            </div>}
      </div>

      {/* Recent transactions (on-chain transfers) */}
      <div className="panel side-card" style={{ marginTop: 16 }}>
        <h3>Recent Transactions</h3>
        {txs == null ? <div className="side-note">Loading transactions…</div>
          : !txs.length ? <div className="side-note">No recent transfers found on-chain.</div>
          : <div className="tx-list">
              {txs.map((t, i) => (
                <div className="tx-row" key={t.tx + i}>
                  <span className="tx-amt">{compact(t.amount)} <span className="tx-sym">{sym}</span></span>
                  <span className="tx-ft mono">{t.from.slice(0, 6)}…{t.from.slice(-4)} → {t.to.slice(0, 6)}…{t.to.slice(-4)}</span>
                  <a className="tx-link" href={`https://arc-scan.org/tx/${t.tx}`} target="_blank" rel="noreferrer">view ↗</a>
                </div>
              ))}
            </div>}
      </div>

      <TokenLinks address={address} scanBase="https://arc-scan.org" warp />

      <div className="td-disc" style={{ marginTop: 16 }}>
        Price, chart &amp; market data are sourced from the Warp launchpad (circlewarp.fun) on Arc mainnet (chain 5042) — Uniswap v4 pools. Contract &amp; holder data are from an independent indexer (arc-scan.org). All unofficial, not Circle. Not an endorsement; unverified; DYOR.
      </div>
    </section></div>
  );
}
