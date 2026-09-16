import { useEffect, useMemo, useState } from 'react';
import { fetchHoldings, fetchHoldingsMainnet, fetchRadarPortfolio, fetchWalletPnl, priceMainnet, isAddress, tprice, usd, compact, CHAIN, type Token, type Holding, type TokenPnl } from '../lib/arc';
import { fetchWarpToken } from '../lib/warp';
import { TokenLogo } from './TokenLogo';
import { IconExternal, IconCheck, IconCopy } from './icons';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
const USDC_ADDR = '0x3600000000000000000000000000000000000000';

export function Portfolio({ tokens, wallet, onConnect, onOpenToken, mainnet = false }: { tokens: Token[]; wallet: string | null; onConnect: () => void; onOpenToken?: (addr: string) => void; mainnet?: boolean }) {
  const [addr, setAddr] = useState('');
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const copyAddr = (e: React.MouseEvent, a: string) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(a).then(() => { setCopied(a); setTimeout(() => setCopied((c) => (c === a ? null : c)), 1200); }).catch(() => {});
  };
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [livePx, setLivePx] = useState<Record<string, number>>({}); // mainnet: live pool prices
  const [pnl, setPnl] = useState<Record<string, TokenPnl> | null>(null); // reconstructed cost basis
  const [pnlLoading, setPnlLoading] = useState(false);

  // Price lookup by token address (board prices + live mainnet pool prices).
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tokens) if (t.price != null) m.set(t.address.toLowerCase(), t.price);
    for (const [a, p] of Object.entries(livePx)) m.set(a, p);
    return m;
  }, [tokens, livePx]);

  // When a wallet connects, track it automatically.
  useEffect(() => { if (wallet) setAddr(wallet); }, [wallet]);

  useEffect(() => {
    if (!addr || !isAddress(addr)) return;
    let alive = true;
    setLoading(true); setErr(null); setHoldings([]); setLivePx({});
    (async () => {
      // FAST PATH (mainnet): RadarDEX indexes every wallet's holdings + value + icons in one call — instant.
      if (mainnet) {
        try {
          const pf = await fetchRadarPortfolio(addr);
          if (!alive) return;
          if (pf.holdings.length) {
            setHoldings(pf.holdings.map((h) => ({ address: h.address, name: h.name, symbol: h.symbol, decimals: h.decimals, balance: h.amount, iconUrl: h.icon })));
            const px: Record<string, number> = {};
            for (const h of pf.holdings) if (h.price != null) px[h.address] = h.price;
            setLivePx(px);
            setLoading(false);
            return;
          }
        } catch { /* fall through to on-chain scan */ }
        if (!alive) return;
      }
      // FALLBACK: on-chain balanceOf scan of the priced/liquid/ecosystem token set (RPC).
      try {
        const scan = tokens.filter((t) => t.price != null || t.liq != null || t.isEcosystem || t.launchpad);
        const h = mainnet
          ? await fetchHoldingsMainnet(addr, scan.map((t) => ({ address: t.address, name: t.name, symbol: t.symbol })))
          : await fetchHoldings(addr);
        if (!alive) return;
        setHoldings(h);
        if (mainnet) {
          const px = await priceMainnet(h.map((x) => x.address)).catch(() => ({} as Record<string, number>));
          if (!alive) return;
          setLivePx(px);
          const usdcK = '0x3600000000000000000000000000000000000000';
          const missing = h.filter((x) => px[x.address] == null && x.address !== usdcK).slice(0, 14);
          const got = await Promise.all(missing.map((x) =>
            fetchWarpToken(x.address).then((w) => [x.address, w?.price ?? null] as const).catch(() => null)));
          const add: Record<string, number> = {};
          for (const r of got) if (r && r[1] != null) add[r[0]] = r[1];
          if (alive && Object.keys(add).length) setLivePx((prev) => ({ ...prev, ...add }));
        }
      } catch (e: any) { if (alive) setErr(e.message || 'failed to load'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [addr, mainnet]); // eslint-disable-line

  // P&L: reconstruct cost basis from the wallet's on-chain swaps once holdings are known (mainnet only).
  const holdKey = holdings.map((h) => h.address).join(',');
  useEffect(() => {
    setPnl(null);
    if (!mainnet || !addr || !isAddress(addr) || !holdings.length) return;
    let alive = true; setPnlLoading(true);
    const decs: Record<string, number> = {};
    for (const h of holdings) decs[h.address.toLowerCase()] = h.decimals ?? 18;
    fetchWalletPnl(addr, decs).then((p) => { if (alive) setPnl(p); }).catch(() => { if (alive) setPnl({}); }).finally(() => { if (alive) setPnlLoading(false); });
    return () => { alive = false; };
  }, [addr, mainnet, holdKey]); // eslint-disable-line

  const rows = useMemo(() => {
    return holdings
      .map((h) => {
        const p = priceMap.get(h.address) ?? null;
        const value = p != null ? h.balance * p : null;
        const pl = pnl?.[h.address.toLowerCase()] ?? null;
        const avgCost = pl?.avgCost ?? null;
        // Unrealized = (current price − avg cost) × current balance; total P&L adds realized.
        const unrealized = avgCost != null && p != null ? (p - avgCost) * h.balance : null;
        const totalPnl = avgCost != null ? (pl!.realized + (unrealized ?? 0)) : null;
        const invested = avgCost != null ? avgCost * h.balance : null; // cost basis of current bag
        const pnlPct = invested && totalPnl != null && invested > 0 ? (totalPnl / invested) * 100 : null;
        return { ...h, price: p, value, avgCost, totalPnl, pnlPct };
      })
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  }, [holdings, priceMap, pnl]);

  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalPnlSum = rows.reduce((s, r) => s + (r.totalPnl ?? 0), 0);
  const hasPnl = pnl != null && rows.some((r) => r.totalPnl != null);
  const track = () => { if (isAddress(input)) setAddr(input.trim()); else setErr('Enter a valid 0x… address'); };

  return (
    <div className="wrap"><section className="section">
      <div className="section-head">
        <div><div className="kicker">Portfolio</div><h2>Track Holdings</h2><p>Connect a wallet or paste any Arc address to see its tokens, valued live.</p></div>
      </div>

      <div className="pf-input">
        <input className="search" placeholder="Paste an Arc / EVM address (0x…)" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && track()} />
        <button className="btn ghost" onClick={track}>Track</button>
        <button className="btn solid" onClick={onConnect}>{wallet ? short(wallet) : 'Connect Wallet'}</button>
      </div>

      {err && <div className="msg err">{err}</div>}
      {!addr && !loading && <div className="msg">Paste an address or connect a wallet to begin.</div>}
      {loading && <div className="msg">Loading holdings…</div>}

      {addr && !loading && (
        <>
          <div className="stats" style={{ marginTop: 8 }}>
            <div className="stat"><div className="v">{usd(total)}</div><div className="l">Total Value {rows.some((r) => r.value == null) ? '(priced tokens)' : ''}</div></div>
            {mainnet && (
              <div className="stat"><div className={`v ${hasPnl ? (totalPnlSum >= 0 ? 'chg up' : 'chg down') : ''}`}>{hasPnl ? `${totalPnlSum >= 0 ? '+' : '−'}${usd(Math.abs(totalPnlSum))}` : pnlLoading ? '…' : '—'}</div><div className="l">Total P&amp;L</div></div>
            )}
            <div className="stat"><div className="v">{rows.length}</div><div className="l">Tokens Held</div></div>
            <div className="stat"><div className="v">{short(addr)}</div><div className="l">Address</div></div>
          </div>

          {!!rows.length && (
            <div className="table">
              <div className="trow head pf-row">
                <span /><span>Token</span><span className="num hidesm">Balance</span>
                <span className="num hidesm">Price</span><span className="num">Value</span>
                <span className="num">P&amp;L</span>
              </div>
              {rows.map((h) => {
                const openable = !!onOpenToken && h.address.toLowerCase() !== USDC_ADDR;
                return (
                <div className={`trow tok pf-row${openable ? ' clickable' : ''}`} key={h.address}
                  onClick={() => openable && onOpenToken!(h.address)}
                  title={openable ? `Open ${h.symbol} chart & details` : undefined}>
                  <TokenLogo symbol={h.symbol} seed={h.address} url={h.iconUrl} />
                  <span className="pf-id">
                    <span className="pf-nm"><span className="tname">{h.name}</span>{openable && <IconExternal className="pf-open i" />}</span>
                    <span className="tsym">{h.symbol}
                      <button className="pf-copy" onClick={(e) => copyAddr(e, h.address)} title="Copy token address">
                        {copied === h.address ? <IconCheck className="i" /> : <IconCopy className="i" />}
                      </button>
                    </span>
                  </span>
                  <span className="num hidesm">{compact(h.balance)}</span>
                  <span className="num hidesm">{tprice(h.price)}</span>
                  <span className="num">{h.value == null ? '—' : usd(h.value)}</span>
                  <span className={`num pf-pnl ${h.totalPnl == null ? '' : h.totalPnl >= 0 ? 'up' : 'down'}`}>
                    {h.totalPnl == null ? (pnlLoading ? '…' : '—') : (
                      <><span className="pf-pnl-v">{h.totalPnl >= 0 ? '+' : '−'}{usd(Math.abs(h.totalPnl))}</span>
                      {h.pnlPct != null && <span className="pf-pnl-pct">{h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(0)}%</span>}</>
                    )}
                  </span>
                </div>
              ); })}
            </div>
          )}
          {!rows.length && <div className="msg">No token holdings found for this address on {mainnet ? 'Arc Mainnet' : CHAIN.name}.</div>}
        </>
      )}
    </section></div>
  );
}
