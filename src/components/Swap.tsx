import { useEffect, useMemo, useRef, useState } from 'react';
import { compact, CHAIN, type Token } from '../lib/arc';
import {
  NATIVE_USDC, SWAP_CFG, swapReady, bestQuote, decimalsOf, symbolOf, balanceOf, allowance,
  buildApproveTx, buildSwapTx, simulate, minOut, toRaw, fromRaw, feeCandidates, MAX_UINT256,
  permitInfo, buildPermitTypedData, buildSwapWithPermitTx, type Quote, type TxReq,
  setSwapMainnet, activeScan, MAINNET_CHAIN_ID,
} from '../lib/swap';
import { TokenPicker } from './TokenPicker';

const USDC: Token = {
  address: NATIVE_USDC, name: 'USD Coin', symbol: 'USDC', holders: null, totalSupply: null,
  type: 'ERC-20', iconUrl: null, launchpad: null, isOurs: false, isEcosystem: true, price: 1, liq: null, mcap: null,
};

const eth = () => (window as any).ethereum;
async function sendTx(tx: TxReq): Promise<string> {
  return await eth().request({ method: 'eth_sendTransaction', params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }] });
}
async function waitReceipt(hash: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
    if (r) return BigInt(r.status) === 1n;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

// Warp tokens live on Arc mainnet (5042). Make sure the wallet is on that chain before a trade.
async function ensureChain(chainId: number): Promise<boolean> {
  const hexId = '0x' + chainId.toString(16);
  try {
    const cur = await eth().request({ method: 'eth_chainId' });
    if (typeof cur === 'string' && parseInt(cur, 16) === chainId) return true;
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    return true;
  } catch (e: any) {
    if (e?.code === 4902) {
      try {
        await eth().request({ method: 'wallet_addEthereumChain', params: [{
          chainId: hexId, chainName: 'Arc',
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          rpcUrls: ['https://rpc.mainnet.arc.io'], blockExplorerUrls: ['https://arc-scan.org'],
        }] });
        return true;
      } catch { return false; }
    }
    return false;
  }
}

const SLIPPAGES = [0.5, 1, 3];

interface Preload { address: string; symbol: string; name?: string; price?: number | null }
export function Swap({ tokens, wallet, onConnect, preload }: { tokens: Token[]; wallet: string | null; onConnect: () => void; preload?: Preload | null }) {
  const [extra, setExtra] = useState<Token[]>([]);
  // Warp (Arc mainnet 5042) token USD prices — presence marks a token as "mainnet/Warp": we show a
  // price-based estimate and gate live execution until mainnet, since these trade on Uniswap v4 and
  // the public RPC isn't open pre-launch.
  const [warpPx, setWarpPx] = useState<Record<string, number>>({});
  const universe = useMemo(() => {
    const seen = new Set([USDC.address.toLowerCase()]);
    const list: Token[] = [USDC];
    for (const t of [...extra, ...tokens]) {
      const k = t.address.toLowerCase();
      if (!seen.has(k)) { seen.add(k); list.push(t); }
    }
    return list;
  }, [tokens, extra]);

  const [fromA, setFromA] = useState(USDC.address);
  const [toA, setToA] = useState('');
  const [amt, setAmt] = useState('');
  const [slip, setSlip] = useState(1);

  const from = universe.find((t) => t.address.toLowerCase() === fromA.toLowerCase()) || USDC;
  const to = universe.find((t) => t.address.toLowerCase() === toA.toLowerCase());

  const [dec, setDec] = useState<Record<string, number>>({ [USDC.address.toLowerCase()]: 6 });
  useEffect(() => {
    [from?.address, to?.address].filter(Boolean).forEach(async (a) => {
      const k = a!.toLowerCase();
      if (dec[k] != null) return;
      const d = await decimalsOf(a!);
      setDec((p) => ({ ...p, [k]: d }));
    });
  }, [from?.address, to?.address]); // eslint-disable-line

  // "Trade" from the Arc trending board: load the token in, select it as the buy side, and record
  // its Warp price so the swap can quote an estimate.
  useEffect(() => {
    if (!preload?.address) return;
    const a = preload.address, k = a.toLowerCase();
    setExtra((p) => p.some((t) => t.address.toLowerCase() === k) ? p
      : [{ address: a, name: preload.name || preload.symbol, symbol: preload.symbol, holders: null, totalSupply: null, type: 'ERC-20', iconUrl: null, launchpad: null, isOurs: false, isEcosystem: false, price: preload.price ?? null, liq: null, mcap: null }, ...p]);
    setDec((p) => (p[k] != null ? p : { ...p, [k]: 18 }));
    if (preload.price != null) setWarpPx((p) => ({ ...p, [k]: preload.price! }));
    setFromA(USDC.address);
    setToA(a);
  }, [preload?.address]); // eslint-disable-line

  // wallet balances for the selected tokens (refetched on connect / token change / after a swap)
  const [bal, setBal] = useState<Record<string, bigint>>({});
  const [phaseTick, setPhaseTick] = useState(0);
  useEffect(() => {
    if (!wallet) { setBal({}); return; }
    let alive = true;
    [from?.address, to?.address].filter(Boolean).forEach(async (a) => {
      const b = await balanceOf(a!, wallet);
      if (alive) setBal((p) => ({ ...p, [a!.toLowerCase()]: b }));
    });
    return () => { alive = false; };
  }, [wallet, fromA, toA, phaseTick]); // eslint-disable-line

  const [quote, setQuote] = useState<Quote | null>(null);
  const [estimate, setEstimate] = useState<{ out: number } | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const qSeq = useRef(0);
  const decIn = from ? dec[from.address.toLowerCase()] : undefined;
  const decOut = to ? dec[to.address.toLowerCase()] : undefined;

  const usdcK = USDC.address.toLowerCase();
  const pxOf = (k?: string) => (k === usdcK ? 1 : (k ? warpPx[k] : undefined));
  // A Warp/mainnet token is selected. Arc mainnet (5042) is LIVE, so we flip the swap engine to
  // mainnet (rpc.mainnet.arc.io + WarpV2) and quote/execute for real. Tokens with no WarpV2 route
  // (e.g. Uniswap-v4-only ARGUS/CRCL) still fall back to a price estimate.
  const warpMode = !!(from && warpPx[from.address.toLowerCase()] != null) || !!(to && warpPx[to.address.toLowerCase()] != null);
  // The Warp/mainnet token in the pair (prefer the buy side) — used for the "Trade on Warp" deep link.
  const warpTokenAddr = (to && warpPx[to.address.toLowerCase()] != null) ? to.address
    : (from && warpPx[from.address.toLowerCase()] != null) ? from.address : null;
  // Declared BEFORE the quote effect so it commits first — engine is on mainnet when bestQuote runs.
  useEffect(() => { setSwapMainnet(warpMode); return () => setSwapMainnet(false); }, [warpMode]);

  useEffect(() => {
    const n = parseFloat(amt);
    setQuote(null); setQErr(null); setEstimate(null);
    if (!from || !to || !n || n <= 0) return;

    // ── Warp / mainnet token → real WarpV2 quote, with a price-estimate fallback ──
    if (warpMode) {
      if (decIn == null || decOut == null) return;
      const seq = ++qSeq.current;
      setQuoting(true);
      const id = setTimeout(async () => {
        const amountInRaw = toRaw(n, decIn);
        const q = await bestQuote(from.address, to.address, amountInRaw); // engine is on mainnet (see flip effect)
        if (seq !== qSeq.current) return;
        setQuoting(false);
        if (q) { setQuote(q); return; }
        // No WarpV2 route (v4-only token, e.g. ARGUS/CRCL) → show a price estimate, no live execution.
        const pf = pxOf(from.address.toLowerCase()), pt = pxOf(to.address.toLowerCase());
        if (pf && pt) setEstimate({ out: (n * pf) / pt });
        else setQErr('No WarpV2 route for this pair — it may trade only on Uniswap v4 (not yet routable here).');
      }, 450);
      return () => clearTimeout(id);
    }

    if (decIn == null || decOut == null) return;
    if (!swapReady()) { setQErr('Swaps go live with Arc mainnet on Sept 16.'); return; }
    const seq = ++qSeq.current;
    setQuoting(true);
    const id = setTimeout(async () => {
      const amountInRaw = toRaw(n, decIn);
      const q = await bestQuote(from.address, to.address, amountInRaw);
      if (seq !== qSeq.current) return;
      setQuoting(false);
      if (!q) { setQErr('No route via our supported DEXes — this token’s pool may be on a DEX we don’t aggregate yet (e.g. a custom launchpad AMM).'); return; }
      setQuote(q);
    }, 450);
    return () => clearTimeout(id);
  }, [amt, fromA, toA, decIn, decOut, warpMode]); // eslint-disable-line

  const outHuman = estimate ? estimate.out : (quote && decOut != null ? fromRaw(quote.amountOutRaw, decOut) : null);
  const minRecv = quote && decOut != null ? fromRaw(minOut(quote.amountOutRaw, slip), decOut) : null;
  const rate = outHuman && parseFloat(amt) ? outHuman / parseFloat(amt) : null;

  const fromBalRaw = from ? bal[from.address.toLowerCase()] : undefined;
  const toBalRaw = to ? bal[to.address.toLowerCase()] : undefined;
  const fromBal = fromBalRaw != null && decIn != null ? fromRaw(fromBalRaw, decIn) : null;
  const toBal = toBalRaw != null && decOut != null ? fromRaw(toBalRaw, decOut) : null;
  const fmtBal = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });

  // resolve + add a pasted token address, and select it into the given side
  const [adding, setAdding] = useState(false);
  const addToken = async (addr: string, side: 'from' | 'to') => {
    const a = addr.trim();
    const existing = universe.find((t) => t.address.toLowerCase() === a.toLowerCase());
    if (existing) { (side === 'from' ? setFromA : setToA)(existing.address); return; }
    setAdding(true);
    const [sym, d] = await Promise.all([symbolOf(a), decimalsOf(a)]);
    setAdding(false);
    if (!sym) { setQErr('That address is not an ERC-20 token on Arc.'); return; }
    const t: Token = { address: a, name: sym, symbol: sym, holders: null, totalSupply: null, type: 'ERC-20', iconUrl: null, launchpad: null, isOurs: false, isEcosystem: false, price: null, liq: null, mcap: null };
    setDec((p) => ({ ...p, [a.toLowerCase()]: d }));
    setExtra((p) => [t, ...p]);
    (side === 'from' ? setFromA : setToA)(a);
  };

  const flip = () => { const f = fromA; setFromA(toA || (universe[1]?.address ?? '')); setToA(f); };

  const [phase, setPhase] = useState<'idle' | 'approving' | 'swapping' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const execute = async () => {
    if (!wallet || !quote || !from || decIn == null) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      // Warp tokens trade on Arc mainnet (5042) — make sure the wallet is on that chain first.
      if (warpMode) {
        setMsg('Switch your wallet to Arc mainnet…');
        const ok = await ensureChain(MAINNET_CHAIN_ID);
        if (!ok) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
        setMsg(null);
      }
      const amountInRaw = quote.amountInRaw;
      const amountOutMinRaw = minOut(quote.amountOutRaw, slip);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      const allow = await allowance(from.address, wallet, quote.router);
      let swapTx: TxReq | null = null;

      // ── PERMIT PATH ── pair-router fill + a permit-capable pay token (USDC/EURC) + no
      // standing allowance → sign once (no gas, no approval tx) and swap in ONE transaction.
      if (quote.kind === 'pair' && allow < amountInRaw) {
        const pinfo = await permitInfo(from.address, wallet);
        if (pinfo) {
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
          setPhase('approving'); setMsg(`Sign to authorize ${from.symbol} — no gas, no approval tx…`);
          let sig: string | null = null;
          try {
            const typed = buildPermitTypedData(pinfo, wallet, quote.router, amountInRaw, deadline);
            sig = await eth().request({ method: 'eth_signTypedData_v4', params: [wallet, JSON.stringify(typed)] });
          } catch { setPhase('error'); setMsg('Signature rejected.'); return; }
          if (sig) {
            let tx = buildSwapWithPermitTx(quote, { amountOutMinRaw, recipient: wallet, deadline, sig });
            let rev = await simulate(tx);
            if (rev) for (const fee of feeCandidates(quote.feeBps)) { // signature stays valid across fee changes
              const t = buildSwapWithPermitTx(quote, { amountOutMinRaw, recipient: wallet, deadline, sig, feeBpsOverride: fee });
              if (!(await simulate(t))) { tx = t; rev = null; break; }
            }
            if (!rev) swapTx = tx; // permit route validated; else fall through to approval
          }
        }
      }

      // ── APPROVAL PATH ── non-permit tokens, or already-approved: one-time approval, then swap.
      if (!swapTx) {
        if (allow < amountInRaw) {
          setPhase('approving'); setMsg(`One-time approval for ${from.symbol} (only needed once)…`);
          const ah = await sendTx(buildApproveTx(from.address, quote.router, MAX_UINT256, wallet));
          const ok = await waitReceipt(ah);
          if (!ok) { setPhase('error'); setMsg('Approval failed.'); return; }
        }
        let tx = buildSwapTx(quote, { amountOutMinRaw, recipient: wallet });
        let rev = await simulate(tx);
        if (rev && quote.kind === 'pair') {
          for (const fee of feeCandidates(quote.feeBps)) {
            const t = buildSwapTx(quote, { amountOutMinRaw, recipient: wallet, feeBpsOverride: fee });
            if (!(await simulate(t))) { tx = t; rev = null; break; }
          }
        }
        if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}`); return; }
        swapTx = tx;
      }

      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(swapTx);
      setHash(sh);
      const ok = await waitReceipt(sh);
      if (!ok) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} → ${to?.symbol}.`);
      setAmt(''); setPhaseTick((t) => t + 1); // refresh balances
    } catch (e: any) {
      setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.');
    }
  };

  const busy = phase === 'approving' || phase === 'swapping';

  return (
    <div className="wrap"><section className="section">
      <div className="section-head">
        <div><div className="kicker">Swap</div><h2>Swap Tokens</h2>
          <p>Trade any Arc token — routed through the deepest on-chain liquidity, with slippage-protected execution. Any token address works.</p></div>
      </div>

      <div className="swap-wrap">
        <div className="swap-card">
          <div className="swap-box">
            <div className="swap-row">
              <span className="swap-l">You pay</span>
              {wallet && fromBal != null && (
                <span className="swap-bal">Balance: {fmtBal(fromBal)} {from?.symbol}
                  {fromBal > 0 && <button type="button" className="swap-max" onClick={() => setAmt(String(fromBal))}>MAX</button>}
                </span>
              )}
            </div>
            <div className="swap-in">
              <input className="swap-amt" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
              <TokenPicker value={from} tokens={universe} exclude={toA} onSelect={(t) => setFromA(t.address)} onAddAddress={(a) => addToken(a, 'from')} adding={adding} />
            </div>
          </div>

          <button className="swap-flip" onClick={flip} aria-label="flip">⇅</button>

          <div className="swap-box">
            <div className="swap-row">
              <span className="swap-l">You receive (est.)</span>
              {wallet && to && toBal != null && <span className="swap-bal">Balance: {fmtBal(toBal)} {to.symbol}</span>}
            </div>
            <div className="swap-in">
              <input className="swap-amt" placeholder="0.0" value={outHuman != null ? compact(outHuman) : ''} readOnly />
              <TokenPicker value={to} tokens={universe} exclude={fromA} onSelect={(t) => setToA(t.address)} onAddAddress={(a) => addToken(a, 'to')} adding={adding} />
            </div>
          </div>

          <div className="swap-settings">
            <span className="swap-l">Max slippage</span>
            <div className="slip-opts">
              {SLIPPAGES.map((s) => <button key={s} className={slip === s ? 'on' : ''} onClick={() => setSlip(s)}>{s}%</button>)}
            </div>
          </div>

          {quoting && <div className="swap-info"><span>Finding best route…</span><span /></div>}
          {quote && rate != null && (
            <div className="swap-quote">
              <div className="sq-row"><span>Rate</span><span className="mono">1 {from?.symbol} ≈ {compact(rate)} {to?.symbol}</span></div>
              <div className="sq-row"><span>Min received</span><span className="mono">{minRecv != null ? compact(minRecv) : '—'} {to?.symbol}</span></div>
              <div className="sq-row"><span>Route</span><span className="mono">{quote.routerName} · {quote.hops === 1 ? 'direct' : `${quote.hops} hops`}</span></div>
            </div>
          )}
          {estimate && rate != null && (
            <div className="swap-quote">
              <div className="sq-row"><span>Est. rate</span><span className="mono">1 {from?.symbol} ≈ {compact(rate)} {to?.symbol}</span></div>
              <div className="sq-row"><span>You’d receive</span><span className="mono">≈ {outHuman != null ? compact(outHuman) : '—'} {to?.symbol}</span></div>
              <div className="sq-row"><span>Route</span><span className="mono">Warp · Uniswap v4</span></div>
            </div>
          )}
          {warpMode && (
            <div className="swap-warp-note">
              {quote
                ? <><b>Arc mainnet · live.</b> Routed through WarpV2 on Arc mainnet (chain 5042). Your wallet will switch to Arc mainnet to trade.</>
                : <><b>Arc mainnet token (via Warp).</b> No WarpV2 route — it trades on Warp's bonding curve or Uniswap v4, which this swap can't fill. The figure is a price <b>estimate</b>; trade it directly on Warp below.</>}
            </div>
          )}
          {qErr && <div className="swap-info err"><span>{qErr}</span><span /></div>}

          {!wallet
            ? <button className="btn solid swap-cta" onClick={onConnect}>Connect Wallet</button>
            : (warpMode && !quote)
              ? (warpTokenAddr && !quoting
                  ? <a className="btn solid swap-cta" href={`https://circlewarp.fun/trade/${warpTokenAddr}`} target="_blank" rel="noreferrer">Trade {(to && warpPx[to.address.toLowerCase()] != null ? to.symbol : from?.symbol) || ''} on Warp ↗</a>
                  : <button className="btn solid swap-cta" disabled>{quoting ? 'Finding route…' : to ? 'Enter an amount' : 'Select a token'}</button>)
              : <button className="btn solid swap-cta" onClick={execute} disabled={!quote || busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : quote ? `Swap ${from?.symbol} → ${to?.symbol}` : to ? 'Enter an amount' : 'Select a token'}
                </button>}

          {msg && (
            <div className={`swap-status ${phase}`}>
              {msg}
              {hash && <> · <a href={`${(warpMode ? activeScan() : CHAIN.scan)}/tx/${hash}`} target="_blank" rel="noreferrer">view tx ↗</a></>}
            </div>
          )}
          <div className="swap-note">Best-fill routing across live Arc DEX liquidity. Paying with USDC or EURC, you just sign once — no gas, no approval tx (EIP-2612 permit). Other tokens: one approval the first time, then single-tx trades. Min-out enforced, dry-run simulated before you sign. Not financial advice — DYOR.</div>
        </div>

        <aside className="swap-side">
          <div className="panel side-card">
            <h3>How it works</h3>
            <p className="side-note">{warpMode
              ? <>Trading Arc mainnet (chain 5042) tokens: StateraArc routes graduated tokens through WarpV2 and fills them here. Bonding-curve and Uniswap-v4 tokens can't be filled by this router — for those you'll get a live price estimate and a one-tap link to trade on Warp. Native USDC (0x3600) is the gas token; min received is enforced on-chain.</>
              : <>StateraArc quotes your trade against every live router on {CHAIN.name} ({SWAP_CFG.routers.length} tracked) and picks the deepest fill. Native USDC (0x3600) is Arc's gas token — swaps approve it as an ERC-20, then route through on-chain pools. Your min received is enforced on-chain at your chosen slippage.</>}</p>
          </div>
          <div className="panel side-card">
            <h3>Paste &amp; trade</h3>
            <p className="side-note">Open either token menu and paste any Arc ERC-20 address to import it instantly. If there's no pool yet, you'll see "no route" rather than a bad fill.</p>
          </div>
        </aside>
      </div>
    </section></div>
  );
}
