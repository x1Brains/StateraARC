import { useEffect, useState } from 'react';
import { TokenLogo } from './TokenLogo';
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

export function PremainDetail({ address, seed, onBack }: { address: string; seed?: Token; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="wrap"><section className="section">
      <button className="back" onClick={onBack}>← Back to board</button>

      <div className="prepublic-banner" style={{ marginTop: 14 }}>
        <span className="pp-dot" />
        <div><b>PRE-PUBLIC · chain 5042</b> — unofficial data from an independent indexer (arc-scan.org), <b>not Circle</b>. Holder/supply figures are indexer-computed and unverified. Impersonation is common on this chain — trust the <b>exact address</b>, not the symbol.</div>
      </div>

      <div className="td-head">
        <TokenLogo symbol={sym} seed={address} url={null} />
        <div className="td-id">
          <div className="td-name">{name || sym}
            {d?.lookalike && <span className="wl-note" style={{ marginLeft: 8 }}>Lookalike</span>}
            {d?.reservedName && <span className="wl-note" style={{ marginLeft: 8 }}>Reserved-name</span>}
          </div>
          <div className="td-sym">{sym} · {d?.standard?.toUpperCase() || 'ERC-20'}</div>
          <button className="addr" onClick={copy} title="copy address">{address.slice(0, 10)}…{address.slice(-8)} {copied ? '✓ copied' : '⧉'}</button>
        </div>
      </div>

      {err && <div className="msg err">Indexer error: {err}. The pre-public source (arc-scan.org) is flaky — try again.</div>}

      <div className="stats" style={{ marginTop: 16 }}>
        <div className="stat"><div className="v">{fmtNum(d?.holders ?? null)}</div><div className="l">Holders</div></div>
        <div className="stat"><div className="v">{fmtSupply(d?.supply ?? null)}</div><div className="l">Total Supply</div></div>
        <div className="stat"><div className="v">{d?.transfers24h != null ? fmtNum(d.transfers24h) : '—'}</div><div className="l">Transfers 24h</div></div>
        <div className="stat"><div className="v r">—</div><div className="l">Price (v4 pending)</div></div>
      </div>

      <div className="panel side-card" style={{ marginTop: 16 }}>
        <h3>Token info</h3>
        <div className="ir"><span className="ir-k">Contract</span><span className="ir-v mono">{address}</span></div>
        <div className="ir"><span className="ir-k">Standard</span><span className="ir-v">{d?.standard?.toUpperCase() || 'ERC-20'}</span></div>
        <div className="ir"><span className="ir-k">Decimals</span><span className="ir-v">{d?.decimals ?? '—'}</span></div>
        {d?.creator && <div className="ir"><span className="ir-k">Creator</span><span className="ir-v mono">{d.creator.slice(0, 10)}…{d.creator.slice(-6)}</span></div>}
        {d?.size != null && <div className="ir"><span className="ir-k">Bytecode</span><span className="ir-v">{d.size.toLocaleString()} bytes</span></div>}
        {d?.reservedCheck && <div className="ir"><span className="ir-k">Reserved-name check</span><span className="ir-v">{d.reservedCheck}</span></div>}
      </div>

      <div className="td-disc" style={{ marginTop: 16 }}>
        Prices land once the Uniswap v4 quoter is wired (5042's DEX is Uniswap v4, not the testnet stack). No on-chain trade history here yet — this is a discovery view of the pre-public chain. Not an endorsement; unverified indexer data; DYOR.
      </div>
    </section></div>
  );
}
