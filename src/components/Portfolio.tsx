import { useEffect, useMemo, useState } from 'react';
import { fetchHoldings, fetchHoldingsMainnet, fetchHoldingsOnchain, fetchPortfolioMainnet, fetchRadarPortfolio, fetchWalletPnl, priceMainnet, isAddress, tprice, usd, compact, CHAIN, type Token, type Holding, type RadarHolding, type TokenPnl } from '../lib/arc';
import { fetchWarpToken } from '../lib/warp';
import { TokenLogo } from './TokenLogo';
import { SendModal, type SendToken } from './SendModal';
import { IconExternal, IconCheck, IconCopy, IconSend } from './icons';

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
  const [enriching, setEnriching] = useState(false); // fast view shown; full on-chain scan still running
  const [err, setErr] = useState<string | null>(null);
  const [livePx, setLivePx] = useState<Record<string, number>>({}); // mainnet: live pool prices
  const [pnl, setPnl] = useState<Record<string, TokenPnl> | null>(null); // reconstructed cost basis
  const [pnlLoading, setPnlLoading] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [sendTok, setSendTok] = useState<SendToken | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [showSpam, setShowSpam] = useState(false);
  const isOwnWallet = !!wallet && !!addr && wallet.toLowerCase() === addr.toLowerCase();
  // Price lookup by token address (board prices + live mainnet pool prices).
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tokens) if (t.price != null) m.set(t.address.toLowerCase(), t.price);
    for (const [a, p] of Object.entries(livePx)) m.set(a, p);
    return m;
  }, [tokens, livePx]);
  // Market cap lookup (for "MC when you bought" vs "MC now").
  const mcapMap = useMemo(() => new Map(tokens.map((t) => [t.address.toLowerCase(), t.mcap])), [tokens]);
  // RadarDEX screener token by address — its logos + names are richer than the explorer's, so we
  // enrich each holding from it.
  const radarByAddr = useMemo(() => new Map(tokens.map((t) => [t.address.toLowerCase(), t])), [tokens]);
  // The REAL address for each ticker = the most-liquid RadarDEX token with that symbol. Wallets get
  // spammed with counterfeit airdrops (fake CRCL/ARGUS/TOLLY at other addresses); anything that carries
  // a known ticker at a NON-canonical address and has no price is a counterfeit we hide by default.
  const realAddrBySymbol = useMemo(() => {
    const best = new Map<string, { addr: string; score: number }>();
    for (const t of tokens) {
      const s = (t.symbol || '').toUpperCase(); if (!s) continue;
      const score = (t.liq ?? 0) + (t.mcap ?? 0) + (t.price != null ? 1 : 0);
      const cur = best.get(s);
      if (!cur || score > cur.score) best.set(s, { addr: t.address.toLowerCase(), score });
    }
    return best;
  }, [tokens]);
  // Balance formatter: never collapse a real sub-1 holding to "0".
  const balFmt = (n: number) => (n === 0 ? '0' : n < 0.0001 ? n.toExponential(2) : n < 1 ? n.toFixed(4).replace(/0+$/, '') : compact(n));
  // In-wallet ticker stats — airdrop spam mints many copies of the same symbol (fake CRCL/ARGUS/…),
  // so a duplicated, unpriced ticker is the most reliable counterfeit signal (doesn't depend on the
  // screener's addresses being exact).
  const symStats = useMemo(() => {
    const m = new Map<string, { count: number; maxBal: number; anyPriced: boolean }>();
    for (const h of holdings) {
      const s = (h.symbol || '').toUpperCase();
      const priced = priceMap.get(h.address.toLowerCase()) != null;
      const cur = m.get(s) || { count: 0, maxBal: 0, anyPriced: false };
      cur.count++; cur.maxBal = Math.max(cur.maxBal, h.balance); cur.anyPriced = cur.anyPriced || priced;
      m.set(s, cur);
    }
    return m;
  }, [holdings, priceMap]);

  // When a wallet connects, track it automatically.
  useEffect(() => { if (wallet) setAddr(wallet); }, [wallet]);

  useEffect(() => {
    if (!addr || !isAddress(addr)) return;
    let alive = true;
    setLoading(true); setErr(null); setHoldings([]); setLivePx({}); setEnriching(false);
    // Map a holdings source into the view + seed the prices it already carries.
    const apply = (src: RadarHolding[]) => {
      const h = src.map((r) => ({ address: r.address, name: r.name, symbol: r.symbol, decimals: r.decimals, balance: r.amount, iconUrl: r.icon }));
      const seeded: Record<string, number> = {};
      for (const r of src) if (r.price != null) seeded[r.address] = r.price;
      setHoldings(h); setLivePx((prev) => ({ ...prev, ...seeded }));
      return { h, seeded };
    };
    (async () => {
      try {
        if (!mainnet) { const h = await fetchHoldings(addr); if (alive) { setHoldings(h); setLoading(false); } return; }

        // PHASE 1 — fast indexer sources (RadarDEX + explorer) so the wallet's bag paints in ~1-2s
        // instead of a long blank spinner while the full on-chain scan runs.
        const [rp, pf] = await Promise.all([
          fetchRadarPortfolio(addr).catch(() => ({ total: null, holdings: [] as RadarHolding[] })),
          fetchPortfolioMainnet(addr).catch(() => ({ total: null, holdings: [] as RadarHolding[] })),
        ]);
        if (!alive) return;
        const fast = pf.holdings.length >= rp.holdings.length ? pf.holdings : rp.holdings;
        if (fast.length) { apply(fast); setLoading(false); setEnriching(true); }

        // PHASE 2 — the COMPLETE on-chain read (Transfer-log discovery + Multicall3 balanceOf + V3/V2/
        // Warp/V4 pricing across our RPCs). It's the full, correct bag; it replaces the fast view.
        const oc = await fetchHoldingsOnchain(addr).catch(() => ({ total: null, holdings: [] as RadarHolding[] }));
        if (!alive) return;
        let finalSet: { h: Holding[]; seeded: Record<string, number> };
        if (oc.holdings.length) { finalSet = apply(oc.holdings); }
        else if (fast.length) { finalSet = apply(fast); }
        else {
          // last resort: curated on-chain balanceOf scan
          const scan = tokens.filter((t) => t.price != null || t.liq != null || t.isEcosystem || t.launchpad);
          const h = await fetchHoldingsMainnet(addr, scan.map((t) => ({ address: t.address, name: t.name, symbol: t.symbol })));
          if (!alive) return; setHoldings(h); finalSet = { h, seeded: {} };
        }
        setLoading(false); setEnriching(false);

        // Enrich any holdings still lacking a price (pool price, then Warp) — usually just edge cases,
        // since the on-chain endpoint already prices V3/V2/Warp/V4.
        const { h, seeded } = finalSet;
        const need = h.filter((x) => seeded[x.address] == null).map((x) => x.address);
        const px = need.length ? await priceMainnet(need).catch(() => ({} as Record<string, number>)) : {};
        if (!alive) return;
        if (Object.keys(px).length) setLivePx((prev) => ({ ...prev, ...px }));
        const usdcK = '0x3600000000000000000000000000000000000000';
        const missing = h.filter((x) => seeded[x.address] == null && px[x.address] == null && x.address !== usdcK).slice(0, 14);
        const got = await Promise.all(missing.map((x) =>
          fetchWarpToken(x.address).then((w) => [x.address, w?.price ?? null] as const).catch(() => null)));
        const add: Record<string, number> = {};
        for (const r of got) if (r && r[1] != null) add[r[0]] = r[1];
        if (alive && Object.keys(add).length) setLivePx((prev) => ({ ...prev, ...add }));
      } catch (e: any) { if (alive) setErr(e.message || 'failed to load'); }
      finally { if (alive) { setLoading(false); setEnriching(false); } }
    })();
    return () => { alive = false; };
  }, [addr, mainnet, refreshTick]); // eslint-disable-line

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
        const rd = radarByAddr.get(h.address);
        const iconUrl = h.iconUrl || rd?.iconUrl || null; // prefer the screener's logo when the explorer has none
        const name = rd?.name || h.name;
        // Price sanity: no Arc token is worth >$1M/unit — a bigger number is a decimals/degenerate-pool
        // error (DUKE mispriced at 1e44 blew up the whole total). Drop it, and cap any $1B+ position too.
        const rawP = priceMap.get(h.address) ?? null;
        const p = rawP != null && isFinite(rawP) && rawP > 0 && rawP < 1e6 ? rawP : null;
        const value = p != null && h.balance * p < 1e9 ? h.balance * p : null;
        // Counterfeit spam (only ever flags UNPRICED tokens — a token with real value is never hidden):
        //  • duplicate: another held token shares this ticker and is priced or bigger → this is an airdrop copy
        //  • collision: a known screener token owns this ticker at a different address
        const sym = (h.symbol || '').toUpperCase();
        const st = symStats.get(sym);
        const dupSpam = !!st && st.count > 1 && p == null && (st.anyPriced || h.balance < st.maxBal);
        const real = realAddrBySymbol.get(sym);
        const collideSpam = !!real && real.addr !== h.address.toLowerCase() && p == null;
        const counterfeit = dupSpam || collideSpam;
        const pl = pnl?.[h.address.toLowerCase()] ?? null;
        const avgCost = pl?.avgCost ?? null;
        // Unrealized = (current price − avg cost) × current balance; total P&L adds realized.
        const unrealized = avgCost != null && p != null ? (p - avgCost) * h.balance : null;
        const realized = pl?.realized ?? 0;
        const totalPnl = avgCost != null ? (realized + (unrealized ?? 0)) : null;
        const costOfBag = avgCost != null ? avgCost * h.balance : null; // cost basis of what's held now
        // Only show a % when there's a meaningful cost basis (>= $1). Airdrops / dust have a near-zero
        // cost, which makes the percentage explode (e.g. +1,930,679,167,577%). Clamp for safety too.
        const pnlPct = costOfBag != null && costOfBag >= 1 && totalPnl != null
          ? Math.max(-100, Math.min(9999, (totalPnl / costOfBag) * 100)) : null;
        const mcapNow = mcapMap.get(h.address) ?? null;
        // MC when you bought ≈ (avg buy price / current price) × current market cap.
        const mcapAtBuy = avgCost != null && p && p > 0 && mcapNow != null ? (avgCost / p) * mcapNow : null;
        return { ...h, iconUrl, name, counterfeit, price: p, value, avgCost, totalPnl, pnlPct, unrealized, realized,
          invested: pl?.invested ?? null, qtyBought: pl?.qtyBought ?? null, qtySold: pl?.qtySold ?? null,
          costOfBag, mcapNow, mcapAtBuy };
      })
      // Priced tokens first (by value), then real-but-unpriced by balance so the big holdings lead.
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.balance - a.balance);
  }, [holdings, priceMap, pnl, radarByAddr, realAddrBySymbol, symStats]);

  // Hide counterfeit airdrops AND sub-$1 dust by default (a token PRICED under $1 is dust; unpriced
  // holdings stay visible since we can't judge their value). "Show" reveals everything.
  const isDust = (r: typeof rows[number]) => r.value != null && r.value < 1;
  const hiddenCount = useMemo(() => rows.filter((r) => r.counterfeit || isDust(r)).length, [rows]);
  const spamCount = hiddenCount;
  const shownRows = useMemo(() => (showSpam ? rows : rows.filter((r) => !r.counterfeit && !isDust(r))), [rows, showSpam]);

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
        {!wallet && <button className="btn solid" onClick={onConnect}>Connect Wallet</button>}
      </div>

      {err && <div className="msg err">{err}</div>}
      {!addr && !loading && <div className="msg">Paste an address or connect a wallet to begin.</div>}
      {loading && <div className="msg">Loading holdings…</div>}

      {addr && !loading && (
        <>
          {enriching && (
            <div className="pf-scan">
              <span className="pf-scan-txt">Reading the chain — indexing every pool &amp; balance</span>
              <div className="pf-scan-track"><div className="pf-scan-beam" /></div>
            </div>
          )}
          <div className="stats" style={{ marginTop: 8 }}>
            <div className="stat"><div className="v">{usd(total)}</div><div className="l">Total Value {rows.some((r) => r.value == null) ? '(priced tokens)' : ''}</div></div>
            {mainnet && (
              <div className="stat"><div className={`v ${hasPnl ? (totalPnlSum >= 0 ? 'chg up' : 'chg down') : ''}`}>{hasPnl ? `${totalPnlSum >= 0 ? '+' : '−'}${usd(Math.abs(totalPnlSum))}` : pnlLoading ? '…' : '—'}</div><div className="l">Total P&amp;L</div></div>
            )}
            <div className="stat"><div className="v">{shownRows.length}</div><div className="l">Tokens Held</div></div>
            <div className="stat"><div className="v">{short(addr)}</div><div className="l">Address</div></div>
          </div>

          {spamCount > 0 && (
            <div className="msg" style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span>{spamCount} {spamCount === 1 ? 'token' : 'tokens'} {showSpam ? 'shown' : 'hidden'} — counterfeit tickers &amp; sub-$1 dust.</span>
              <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => setShowSpam((s) => !s)}>{showSpam ? 'Hide' : 'Show'}</button>
            </div>
          )}

          {!!shownRows.length && (
            <div className="table">
              <div className="trow head pf-row">
                <span /><span>Token</span><span className="num hidesm">Balance</span>
                <span className="num hidesm">Price</span><span className="num">Value</span>
                <span className="num">P&amp;L</span>
              </div>
              {shownRows.map((h) => {
                const openable = !!onOpenToken && h.address.toLowerCase() !== USDC_ADDR;
                const isOpen = expanded === h.address;
                const fmtMc = (n: number | null) => (n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : usd(n));
                return (
                <div className="pf-group" key={h.address}>
                <div className={`trow tok pf-row clickable${isOpen ? ' open' : ''}`}
                  onClick={() => setExpanded((e) => (e === h.address ? null : h.address))}
                  title="Tap for buy price, cost & market cap">
                  <TokenLogo symbol={h.symbol} seed={h.address} url={h.iconUrl} />
                  <span className="pf-id">
                    <span className="pf-nm"><span className="tname">{h.name}</span>
                      {openable && <button className="pf-open-btn" title={`Open ${h.symbol} chart`} onClick={(e) => { e.stopPropagation(); onOpenToken!(h.address); }}><IconExternal className="i" /></button>}
                    </span>
                    <span className="tsym">{h.symbol}
                      <button className="pf-copy" onClick={(e) => copyAddr(e, h.address)} title="Copy token address">
                        {copied === h.address ? <IconCheck className="i" /> : <IconCopy className="i" />}
                      </button>
                      {isOwnWallet && h.balance > 0 && (
                        <button className="pf-copy pf-send" onClick={(e) => { e.stopPropagation(); setSendTok({ address: h.address, symbol: h.symbol, name: h.name, decimals: h.decimals, balance: h.balance, iconUrl: h.iconUrl }); }} title={`Send ${h.symbol}`}>
                          <IconSend className="i" />
                        </button>
                      )}
                    </span>
                  </span>
                  <span className="num hidesm">{balFmt(h.balance)}</span>
                  <span className="num hidesm">{tprice(h.price)}</span>
                  <span className="num">{h.value == null ? '—' : usd(h.value)}</span>
                  <span className={`num pf-pnl ${h.totalPnl == null ? '' : h.totalPnl >= 0 ? 'up' : 'down'}`}>
                    {h.totalPnl == null ? (pnlLoading ? '…' : '—') : (
                      <><span className="pf-pnl-v">{h.totalPnl >= 0 ? '+' : '−'}{usd(Math.abs(h.totalPnl))}</span>
                      {h.pnlPct != null && <span className="pf-pnl-pct">{h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(0)}%</span>}</>
                    )}
                  </span>
                </div>
                {isOpen && (
                  <div className="pf-detail">
                    {h.avgCost == null ? (
                      <div className="side-note">{pnlLoading ? 'Loading your trade history…' : 'No on-chain buys found for this token — cost basis unavailable (it may have been received as a transfer, or bought token-to-token).'}</div>
                    ) : (
                      <div className="pf-detail-grid">
                        <div className="pfd"><span className="pfd-l">Invested</span><span className="pfd-v">{usd(h.invested ?? 0)}</span></div>
                        <div className="pfd"><span className="pfd-l">Avg buy</span><span className="pfd-v">{tprice(h.avgCost)}</span></div>
                        <div className="pfd"><span className="pfd-l">Bought</span><span className="pfd-v">{compact(h.qtyBought ?? 0)} {h.symbol}</span></div>
                        <div className="pfd"><span className="pfd-l">Now worth</span><span className="pfd-v">{h.value == null ? '—' : usd(h.value)}</span></div>
                        <div className="pfd"><span className="pfd-l">Unrealized</span><span className={`pfd-v ${h.unrealized == null ? '' : h.unrealized >= 0 ? 'up' : 'down'}`}>{h.unrealized == null ? '—' : `${h.unrealized >= 0 ? '+' : '−'}${usd(Math.abs(h.unrealized))}`}</span></div>
                        {h.realized !== 0 && <div className="pfd"><span className="pfd-l">Realized</span><span className={`pfd-v ${h.realized >= 0 ? 'up' : 'down'}`}>{h.realized >= 0 ? '+' : '−'}{usd(Math.abs(h.realized))}</span></div>}
                        <div className="pfd"><span className="pfd-l">MC at your buy</span><span className="pfd-v">{fmtMc(h.mcapAtBuy)}</span></div>
                        <div className="pfd"><span className="pfd-l">MC now</span><span className="pfd-v">{fmtMc(h.mcapNow)}</span></div>
                      </div>
                    )}
                    <div className="pf-detail-actions">
                      {isOwnWallet && h.balance > 0 && <button className="pf-detail-cta send" onClick={() => setSendTok({ address: h.address, symbol: h.symbol, name: h.name, decimals: h.decimals, balance: h.balance, iconUrl: h.iconUrl })}><IconSend className="i" /> Send {h.symbol}</button>}
                      {openable && <button className="pf-detail-cta" onClick={() => onOpenToken!(h.address)}>Open {h.symbol} chart &amp; trades <IconExternal className="i" /></button>}
                    </div>
                  </div>
                )}
                </div>
              ); })}
            </div>
          )}
          {!rows.length && <div className="msg">No token holdings found for this address on {mainnet ? 'Arc Mainnet' : CHAIN.name}.</div>}
        </>
      )}
      {sendTok && wallet && <SendModal token={sendTok} wallet={wallet} onClose={() => setSendTok(null)} onSent={() => setTimeout(() => setRefreshTick((t) => t + 1), 4000)} />}
    </section></div>
  );
}
