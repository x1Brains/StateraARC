import { useEffect, useMemo, useRef, useState } from 'react';
import { compact, CHAIN, type Token } from '../lib/arc';
import {
  NATIVE_USDC, SWAP_CFG, swapReady, bestQuote, decimalsOf, symbolOf, balanceOf, allowance,
  buildApproveTx, buildSwapTx, simulate, minOut, toRaw, fromRaw, feeCandidates, MAX_UINT256, type Quote, type TxReq,
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

const SLIPPAGES = [0.5, 1, 3];

export function Swap({ tokens, wallet, onConnect }: { tokens: Token[]; wallet: string | null; onConnect: () => void }) {
  const [extra, setExtra] = useState<Token[]>([]);
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
  const [qErr, setQErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const qSeq = useRef(0);
  const decIn = from ? dec[from.address.toLowerCase()] : undefined;
  const decOut = to ? dec[to.address.toLowerCase()] : undefined;

  useEffect(() => {
    const n = parseFloat(amt);
    setQuote(null); setQErr(null);
    if (!from || !to || !n || n <= 0 || decIn == null || decOut == null) return;
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
  }, [amt, fromA, toA, decIn, decOut]); // eslint-disable-line

  const outHuman = quote && decOut != null ? fromRaw(quote.amountOutRaw, decOut) : null;
  const minRecv = quote && decOut != null ? fromRaw(minOut(quote.amountOutRaw, slip), decOut) : null;
  const rate = quote && outHuman && parseFloat(amt) ? outHuman / parseFloat(amt) : null;

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
      const amountInRaw = quote.amountInRaw;
      const amountOutMinRaw = minOut(quote.amountOutRaw, slip);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      const allow = await allowance(from.address, wallet, quote.router);
      if (allow < amountInRaw) {
        // One-time unlimited approval per token — after this, every future swap of it is a single tx.
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol} (only needed once)…`);
        const ah = await sendTx(buildApproveTx(from.address, quote.router, MAX_UINT256, wallet));
        const ok = await waitReceipt(ah);
        if (!ok) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      let swapTx = buildSwapTx(quote, { amountOutMinRaw, recipient: wallet });
      let revert = await simulate(swapTx);
      // Pair-router fills: if the pool's real fee differs from our estimate the swap reverts —
      // walk the fee ladder (post-approval, so the simulated transferFrom succeeds) until one passes.
      if (revert && quote.kind === 'pair') {
        for (const fee of feeCandidates(quote.feeBps)) {
          const tx = buildSwapTx(quote, { amountOutMinRaw, recipient: wallet, feeBpsOverride: fee });
          if (!(await simulate(tx))) { swapTx = tx; revert = null; break; }
        }
      }
      if (revert) { setPhase('error'); setMsg(`Swap would revert: ${revert}`); return; }
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
          {qErr && <div className="swap-info err"><span>{qErr}</span><span /></div>}

          {!wallet
            ? <button className="btn solid swap-cta" onClick={onConnect}>Connect Wallet</button>
            : <button className="btn solid swap-cta" onClick={execute} disabled={!quote || busy}>
                {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : quote ? `Swap ${from?.symbol} → ${to?.symbol}` : to ? 'Enter an amount' : 'Select a token'}
              </button>}

          {msg && (
            <div className={`swap-status ${phase}`}>
              {msg}
              {hash && <> · <a href={`${CHAIN.scan}/tx/${hash}`} target="_blank" rel="noreferrer">view tx ↗</a></>}
            </div>
          )}
          <div className="swap-note">Best-fill routing across live Arc DEX liquidity. The first time you trade a token you approve it once (an EVM requirement) — every trade after is a single transaction. Min-out enforced, dry-run simulated before you sign. Not financial advice — DYOR.</div>
        </div>

        <aside className="swap-side">
          <div className="panel side-card">
            <h3>How it works</h3>
            <p className="side-note">StateraArc quotes your trade against every live router on {CHAIN.name} ({SWAP_CFG.routers.length} tracked) and picks the deepest fill. Native USDC (0x3600) is Arc's gas token — swaps approve it as an ERC-20, then route through on-chain pools. Your min received is enforced on-chain at your chosen slippage.</p>
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
