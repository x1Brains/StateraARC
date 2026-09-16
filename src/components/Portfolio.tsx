import { useEffect, useMemo, useState } from 'react';
import { fetchHoldings, fetchHoldingsMainnet, priceMainnet, isAddress, tprice, usd, compact, CHAIN, type Token, type Holding } from '../lib/arc';
import { fetchWarpToken } from '../lib/warp';
import { TokenLogo } from './TokenLogo';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

export function Portfolio({ tokens, wallet, onConnect, mainnet = false }: { tokens: Token[]; wallet: string | null; onConnect: () => void; mainnet?: boolean }) {
  const [addr, setAddr] = useState('');
  const [input, setInput] = useState('');
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [livePx, setLivePx] = useState<Record<string, number>>({}); // mainnet: live pool prices

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
    setLoading(true); setErr(null); setHoldings([]);
    // Mainnet has no indexer for wallet holdings, so scan the curated + board token set on-chain.
    const p = mainnet
      ? fetchHoldingsMainnet(addr, tokens.map((t) => ({ address: t.address, name: t.name, symbol: t.symbol })))
      : fetchHoldings(addr);
    p.then((h) => {
      setHoldings(h);
      if (!mainnet) return;
      // 1) on-chain pool prices; 2) Warp API fallback for whatever's left (curve/graduated Warp tokens).
      priceMainnet(h.map((x) => x.address)).then(async (px) => {
        setLivePx(px);
        const usdcK = '0x3600000000000000000000000000000000000000';
        const missing = h.filter((x) => px[x.address] == null && x.address !== usdcK).slice(0, 14);
        const got = await Promise.all(missing.map((x) =>
          fetchWarpToken(x.address).then((w) => [x.address, w?.price ?? null] as const).catch(() => null)));
        const add: Record<string, number> = {};
        for (const r of got) if (r && r[1] != null) add[r[0]] = r[1];
        if (Object.keys(add).length) setLivePx((prev) => ({ ...prev, ...add }));
      }).catch(() => {});
    })
      .catch((e) => setErr(e.message || 'failed to load'))
      .finally(() => setLoading(false));
  }, [addr, mainnet]); // eslint-disable-line

  const rows = useMemo(() => {
    return holdings
      .map((h) => { const p = priceMap.get(h.address) ?? null; return { ...h, price: p, value: p != null ? h.balance * p : null }; })
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  }, [holdings, priceMap]);

  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
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
        <span className="pf-or">or</span>
        <button className="btn solid" onClick={onConnect}>{wallet ? short(wallet) : 'Connect Wallet'}</button>
      </div>

      {err && <div className="msg err">{err}</div>}
      {!addr && !loading && <div className="msg">Paste an address or connect a wallet to begin.</div>}
      {loading && <div className="msg">Loading holdings…</div>}

      {addr && !loading && (
        <>
          <div className="stats" style={{ marginTop: 8 }}>
            <div className="stat"><div className="v">{usd(total)}</div><div className="l">Total Value {rows.some((r) => r.value == null) ? '(priced tokens)' : ''}</div></div>
            <div className="stat"><div className="v">{rows.length}</div><div className="l">Tokens Held</div></div>
            <div className="stat"><div className="v">{rows.filter((r) => r.value != null).length}</div><div className="l">Priced</div></div>
            <div className="stat"><div className="v">{short(addr)}</div><div className="l">Address</div></div>
          </div>

          {!!rows.length && (
            <div className="table">
              <div className="trow head pf-row">
                <span /><span>Token</span><span className="num">Balance</span>
                <span className="num hidesm">Price</span><span className="num">Value</span>
              </div>
              {rows.map((h) => (
                <div className="trow tok pf-row" key={h.address}>
                  <TokenLogo symbol={h.symbol} seed={h.address} url={h.iconUrl} />
                  <span><div className="tname">{h.name}</div><div className="tsym">{h.symbol}</div></span>
                  <span className="num">{compact(h.balance)}</span>
                  <span className="num hidesm">{tprice(h.price)}</span>
                  <span className="num">{h.value == null ? '—' : usd(h.value)}</span>
                </div>
              ))}
            </div>
          )}
          {!rows.length && <div className="msg">No token holdings found for this address on {mainnet ? 'Arc Mainnet' : CHAIN.name}.</div>}
        </>
      )}
    </section></div>
  );
}
