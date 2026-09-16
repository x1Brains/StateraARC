import { useEffect, useMemo, useRef, useState } from 'react';
import { compact, usd, CHAIN, fetchRadarPortfolio, fetchAddressTxs, type Token, type RadarHolding, type WalletTx } from '../lib/arc';
import { TokenLogo } from './TokenLogo';
import {
  NATIVE_USDC, SWAP_CFG, swapReady, bestQuote, decimalsOf, symbolOf, balanceOf, allowance,
  buildApproveTx, buildSwapTx, simulate, minOut, toRaw, fromRaw, feeCandidates, MAX_UINT256,
  permitInfo, buildPermitTypedData, buildSwapWithPermitTx, type Quote, type TxReq,
  setSwapMainnet, activeScan, MAINNET_CHAIN_ID, quoteCurveBuy, buildCurveBuyTx,
  quoteCurveSell, buildCurveSellTx, quoteV3, buildV3SwapTx, v3PoolFor, V3_ROUTER,
  quoteV4, buildV4SwapTx, v4CfgFor, v4Permit2Status, buildPermit2ApproveTx, PERMIT2,
} from '../lib/swap';
import { fetchWarpToken } from '../lib/warp';
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
          rpcUrls: ['https://arc-rpc.publicnode.com', 'https://rpc.mainnet.arc.io'], blockExplorerUrls: ['https://explorer.arc.io'],
        }] });
        return true;
      } catch { return false; }
    }
    return false;
  }
}

const SLIPPAGES = [0.5, 1, 3];

interface Preload { address: string; symbol: string; name?: string; price?: number | null }
export function Swap({ tokens, wallet, onConnect, preload, mainnet = false }: { tokens: Token[]; wallet: string | null; onConnect: () => void; preload?: Preload | null; mainnet?: boolean }) {
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

  // Connected wallet's holdings (top tokens) + recent transactions — the side panel (X1-style).
  const [holdings, setHoldings] = useState<RadarHolding[] | null>(null);
  const [pfTotal, setPfTotal] = useState<number | null>(null);
  const [acts, setActs] = useState<WalletTx[] | null>(null);
  useEffect(() => {
    if (!wallet) { setHoldings(null); setActs(null); setPfTotal(null); return; }
    let alive = true;
    setHoldings((h) => h ?? null); setActs((a) => a ?? null);
    fetchRadarPortfolio(wallet).then((pf) => { if (alive) { setHoldings(pf.holdings); setPfTotal(pf.total); } }).catch(() => { if (alive) setHoldings([]); });
    fetchAddressTxs(wallet, 12).then((t) => { if (alive) setActs(t); }).catch(() => { if (alive) setActs([]); });
    return () => { alive = false; };
  }, [wallet, phaseTick]); // eslint-disable-line

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
  // On the mainnet site every trade uses the mainnet engine; a Warp-priced token also forces it.
  const warpMode = mainnet || !!(from && warpPx[from.address.toLowerCase()] != null) || !!(to && warpPx[to.address.toLowerCase()] != null);
  // The mainnet token in the pair (the non-USDC side) — used for curve detection + the Warp link.
  const warpTokenAddr = mainnet
    ? (to && to.address.toLowerCase() !== usdcK ? to.address : (from && from.address.toLowerCase() !== usdcK ? from.address : null))
    : (to && warpPx[to.address.toLowerCase()] != null) ? to.address
    : (from && warpPx[from.address.toLowerCase()] != null) ? from.address : null;
  // Declared BEFORE the quote effect so it commits first — engine is on mainnet when bestQuote runs.
  useEffect(() => { setSwapMainnet(warpMode); return () => setSwapMainnet(false); }, [warpMode]);

  // Warp bonding-curve metadata for the loaded token (curve contract + graduated status), so a
  // non-graduated curve token can be BOUGHT in-app (curve.buy) instead of punting to Warp.
  const [warpMeta, setWarpMeta] = useState<{ addr: string; curve: string | null; migrated: boolean } | null>(null);
  useEffect(() => {
    if (!warpTokenAddr) { setWarpMeta(null); return; }
    const k = warpTokenAddr.toLowerCase(); let alive = true;
    fetchWarpToken(warpTokenAddr).then((w) => { if (alive) setWarpMeta({ addr: k, curve: w?.curveAddress ?? null, migrated: !!w?.migrated }); })
      .catch(() => { if (alive) setWarpMeta(null); });
    return () => { alive = false; };
  }, [warpTokenAddr]);
  const [curveOut, setCurveOut] = useState<bigint | null>(null); // in-app curve-buy expected tokens
  const [curveSellOut, setCurveSellOut] = useState<bigint | null>(null); // curve-sell expected USDC (6-dec)
  const [v3q, setV3q] = useState<{ outRaw: bigint; fee: number; tokenIn: string; tokenOut: string } | null>(null); // Uni V3 quote
  const [v4q, setV4q] = useState<{ outRaw: bigint; zeroForOne: boolean } | null>(null); // Uni V4 quote
  // Curve BUY = paying USDC into a non-graduated curve token's curve contract (no WarpV2 route needed).
  const curveBuyable = !!(warpMode && warpMeta && !warpMeta.migrated && warpMeta.curve
    && fromA.toLowerCase() === usdcK && to && to.address.toLowerCase() === warpMeta.addr);
  // Curve SELL = sending a non-graduated curve token back into its curve for USDC.
  const curveSellable = !!(warpMode && warpMeta && !warpMeta.migrated && warpMeta.curve
    && toA.toLowerCase() === usdcK && from && from.address.toLowerCase() === warpMeta.addr);
  // Uniswap V3 (Argus factory) trade = one side USDC, the other a V3-pooled token (buy OR sell).
  const v3Trade = !!(warpMode && from && to && ((fromA.toLowerCase() === usdcK && v3PoolFor(to.address)) || (toA.toLowerCase() === usdcK && v3PoolFor(from.address))));
  // Uniswap V4 trade = one side USDC, the other a V4-only token (e.g. ARCX10, hooked pool).
  const v4Trade = !!(warpMode && from && to && ((fromA.toLowerCase() === usdcK && v4CfgFor(to.address)) || (toA.toLowerCase() === usdcK && v4CfgFor(from.address))));
  // Auto-refresh the live quote every 12s (mainnet pools move fast — keeps the shown amount current).
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!warpMode || !amt) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), 12000);
    return () => clearInterval(id);
  }, [warpMode, amt]);

  useEffect(() => {
    const n = parseFloat(amt);
    setQuote(null); setQErr(null); setEstimate(null); setCurveOut(null); setCurveSellOut(null); setV3q(null); setV4q(null);
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
        if (q) { setQuoting(false); setQuote(q); return; }
        // Uniswap V3 (Argus factory): buy OR sell a V3-pooled token against USDC.
        if (v3Trade) {
          const r = await quoteV3(from.address, to.address, amountInRaw);
          if (seq !== qSeq.current) return;
          if (r) { setQuoting(false); setV3q({ outRaw: r.outRaw, fee: r.fee, tokenIn: from.address, tokenOut: to.address }); return; }
        }
        // Uniswap V4 (Universal Router, hooked pools): buy OR sell a V4-only token against USDC.
        if (v4Trade) {
          const r = await quoteV4(from.address, to.address, amountInRaw);
          if (seq !== qSeq.current) return;
          if (r) { setQuoting(false); setV4q(r); return; }
        }
        // Curve BUY: USDC → a non-graduated Warp curve token, quoted live from the curve contract.
        if (curveBuyable && wallet) {
          const raw = await quoteCurveBuy(warpMeta!.curve!, n, wallet);
          if (seq !== qSeq.current) return;
          if (raw) { setQuoting(false); setCurveOut(raw); return; }
        }
        // Curve SELL: a non-graduated curve token → USDC, quoted live from the curve (6-dec out).
        if (curveSellable && wallet && decIn != null) {
          const usdc6 = await quoteCurveSell(warpMeta!.curve!, toRaw(n, decIn), wallet);
          if (seq !== qSeq.current) return;
          if (usdc6) { setQuoting(false); setCurveSellOut(usdc6); return; }
        }
        setQuoting(false);
        // No route (v4-only token, or selling a curve token) → price estimate + Warp link fallback.
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
  }, [amt, fromA, toA, decIn, decOut, warpMode, warpMeta, wallet, v3Trade, v4Trade, refreshTick]); // eslint-disable-line

  const outHuman = v3q != null && decOut != null ? fromRaw(v3q.outRaw, decOut)
    : v4q != null && decOut != null ? fromRaw(v4q.outRaw, decOut)
    : curveOut != null && decOut != null ? fromRaw(curveOut, decOut)
    : curveSellOut != null && decOut != null ? fromRaw(curveSellOut, decOut)
    : estimate ? estimate.out
    : (quote && decOut != null ? fromRaw(quote.amountOutRaw, decOut) : null);
  const minRecv = quote && decOut != null ? fromRaw(minOut(quote.amountOutRaw, slip), decOut)
    : v3q != null && decOut != null ? fromRaw(minOut(v3q.outRaw, slip), decOut)
    : v4q != null && decOut != null ? fromRaw(minOut(v4q.outRaw, slip), decOut)
    : curveOut != null && decOut != null ? fromRaw(minOut(curveOut, slip), decOut)
    : (curveSellOut != null && decOut != null ? fromRaw(minOut(curveSellOut, slip), decOut) : null);
  const rate = outHuman && parseFloat(amt) ? outHuman / parseFloat(amt) : null;

  const fromBalRaw = from ? bal[from.address.toLowerCase()] : undefined;
  const toBalRaw = to ? bal[to.address.toLowerCase()] : undefined;
  const fromBal = fromBalRaw != null && decIn != null ? fromRaw(fromBalRaw, decIn) : null;
  const toBal = toBalRaw != null && decOut != null ? fromRaw(toBalRaw, decOut) : null;
  const fmtBal = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
  const timeAgo = (ms: number) => {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return `${s | 0}s`;
    if (s < 3600) return `${(s / 60) | 0}m`;
    if (s < 86400) return `${(s / 3600) | 0}h`;
    return `${(s / 86400) | 0}d`;
  };
  // Tap a holding in the side panel → load it as the sell side (holding → USDC).
  const tradeHolding = (h: RadarHolding) => {
    const k = h.address.toLowerCase();
    setExtra((p) => p.some((t) => t.address.toLowerCase() === k) ? p
      : [{ address: h.address, name: h.name, symbol: h.symbol, holders: null, totalSupply: null, type: 'ERC-20', iconUrl: h.icon, launchpad: null, isOurs: false, isEcosystem: false, price: h.price, liq: null, mcap: null }, ...p]);
    setDec((p) => (p[k] != null ? p : { ...p, [k]: h.decimals ?? 18 }));
    if (h.price != null) setWarpPx((p) => ({ ...p, [k]: h.price! }));
    setToA(USDC.address);
    setFromA(h.address);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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

  // In-app BUY of a Warp bonding-curve token: curve.buy(minOut) paying native USDC. No approval.
  const executeCurveBuy = async () => {
    if (!wallet || !warpMeta?.curve || curveOut == null) return;
    const n = parseFloat(amt); if (!n || n <= 0) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      setMsg('Switch your wallet to Arc mainnet…');
      if (!(await ensureChain(MAINNET_CHAIN_ID))) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
      // Fresh quote at execution so min-out matches the current curve price (avoids stale-price reverts).
      const fresh = await quoteCurveBuy(warpMeta.curve, n, wallet);
      const tx = buildCurveBuyTx(warpMeta.curve, n, minOut(fresh ?? curveOut, slip), wallet);
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Buy would revert: ${rev}. Try higher slippage or a smaller size.`); return; }
      setPhase('swapping'); setMsg('Confirm the buy in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Buy transaction failed.'); return; }
      setPhase('done'); setMsg(`Bought ${to?.symbol} for ${amt} USDC.`);
      setAmt(''); setPhaseTick((t) => t + 1);
    } catch (e: any) { setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.'); }
  };

  // In-app SELL of a Warp bonding-curve token: approve token → curve, then curve.sell(amount, minUsdc).
  const executeCurveSell = async () => {
    if (!wallet || !warpMeta?.curve || !from || decIn == null || curveSellOut == null) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      setMsg('Switch your wallet to Arc mainnet…');
      if (!(await ensureChain(MAINNET_CHAIN_ID))) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
      setMsg(null);
      const amountInRaw = toRaw(parseFloat(amt), decIn);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      if ((await allowance(from.address, wallet, warpMeta.curve)) < amountInRaw) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol}…`);
        if (!(await waitReceipt(await sendTx(buildApproveTx(from.address, warpMeta.curve, MAX_UINT256, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      const fresh = await quoteCurveSell(warpMeta.curve, amountInRaw, wallet); // fresh min-out at current curve price
      const tx = buildCurveSellTx(warpMeta.curve, amountInRaw, minOut(fresh ?? curveSellOut, slip), wallet);
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Sell would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the sell in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Sell transaction failed.'); return; }
      setPhase('done'); setMsg(`Sold ${amt} ${from.symbol} for USDC.`);
      setAmt(''); setPhaseTick((t) => t + 1);
    } catch (e: any) { setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.'); }
  };

  // In-app Uniswap V3 swap (Argus factory) — buy OR sell against USDC. Approve tokenIn → exactInputSingle.
  const executeV3 = async () => {
    if (!wallet || !v3q || !from || !to || decIn == null) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      setMsg('Switch your wallet to Arc mainnet…');
      if (!(await ensureChain(MAINNET_CHAIN_ID))) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
      setMsg(null);
      const amountInRaw = toRaw(parseFloat(amt), decIn);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      if ((await allowance(from.address, wallet, V3_ROUTER)) < amountInRaw) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol}…`);
        if (!(await waitReceipt(await sendTx(buildApproveTx(from.address, V3_ROUTER, MAX_UINT256, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      // Re-quote at the moment of execution so min-out reflects the CURRENT price (these pools move
      // fast; a stale display quote is what caused reverts). Approval can take a few blocks too.
      const fresh = await quoteV3(from.address, to.address, amountInRaw);
      if (!fresh) { setPhase('error'); setMsg('Could not refresh the quote — try again.'); return; }
      const tx = buildV3SwapTx(from.address, to.address, fresh.fee, amountInRaw, minOut(fresh.outRaw, slip), wallet);
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} → ${to.symbol}.`);
      setAmt(''); setPhaseTick((t) => t + 1);
    } catch (e: any) { setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.'); }
  };

  // In-app Uniswap V4 swap (Universal Router + hooked pool). Permit2 flow: ERC-20 approve → Permit2 → UR.
  const executeV4 = async () => {
    if (!wallet || !v4q || !from || !to || decIn == null) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      setMsg('Switch your wallet to Arc mainnet…');
      if (!(await ensureChain(MAINNET_CHAIN_ID))) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
      setMsg(null);
      const amountInRaw = toRaw(parseFloat(amt), decIn);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      // Permit2 two-step: (1) ERC-20 approve token→Permit2, (2) Permit2 approve token→Universal Router.
      const st = await v4Permit2Status(from.address, wallet, amountInRaw);
      if (st.needErc20) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol} (1/2)…`);
        if (!(await waitReceipt(await sendTx(buildApproveTx(from.address, PERMIT2, MAX_UINT256, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      if (st.needPermit2) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol} (2/2)…`);
        if (!(await waitReceipt(await sendTx(buildPermit2ApproveTx(from.address, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      const fresh = await quoteV4(from.address, to.address, amountInRaw); // fresh min-out at current price
      const outRaw = fresh?.outRaw ?? v4q.outRaw;
      const tx = buildV4SwapTx(from.address.toLowerCase() === usdcK ? to.address : from.address, v4q.zeroForOne, amountInRaw, minOut(outRaw, slip), wallet);
      if (!tx) { setPhase('error'); setMsg('Could not build the V4 swap.'); return; }
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} → ${to.symbol}.`);
      setAmt(''); setPhaseTick((t) => t + 1);
    } catch (e: any) { setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.'); }
  };

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
          {v3q != null && rate != null && (
            <div className="swap-quote">
              <div className="sq-row"><span>Rate</span><span className="mono">1 {from?.symbol} ≈ {compact(rate)} {to?.symbol}</span></div>
              <div className="sq-row"><span>Min received</span><span className="mono">{minRecv != null ? compact(minRecv) : '—'} {to?.symbol}</span></div>
              <div className="sq-row"><span>Route</span><span className="mono">Uniswap V3 · {(v3q.fee / 10000).toFixed(2)}% fee</span></div>
            </div>
          )}
          {v4q != null && rate != null && (
            <div className="swap-quote">
              <div className="sq-row"><span>Rate</span><span className="mono">1 {from?.symbol} ≈ {compact(rate)} {to?.symbol}</span></div>
              <div className="sq-row"><span>Min received</span><span className="mono">{minRecv != null ? compact(minRecv) : '—'} {to?.symbol}</span></div>
              <div className="sq-row"><span>Route</span><span className="mono">Uniswap V4 · hooked pool</span></div>
            </div>
          )}
          {(curveOut != null || curveSellOut != null) && rate != null && (
            <div className="swap-quote">
              <div className="sq-row"><span>Rate</span><span className="mono">1 {from?.symbol} ≈ {compact(rate)} {to?.symbol}</span></div>
              <div className="sq-row"><span>Min received</span><span className="mono">{minRecv != null ? compact(minRecv) : '—'} {to?.symbol}</span></div>
              <div className="sq-row"><span>Route</span><span className="mono">Warp bonding curve</span></div>
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
                : v3q != null
                  ? <><b>Arc mainnet · live.</b> Routed through Uniswap V3 (Argus) on Arc mainnet (chain 5042). One-time token approval, then min received is enforced at your slippage.</>
                : v4q != null
                  ? <><b>Arc mainnet · live.</b> Routed through Uniswap V4 (Universal Router) on Arc mainnet (chain 5042). First trade needs two one-time approvals (Permit2), then min received is enforced at your slippage.</>
                : (curveBuyable && curveOut != null)
                  ? <><b>Arc mainnet · live.</b> Buying on Warp's bonding curve, in-app (chain 5042) — you pay USDC directly, no approval. Min received is enforced at your slippage.</>
                : (curveSellable && curveSellOut != null)
                  ? <><b>Arc mainnet · live.</b> Selling on Warp's bonding curve, in-app (chain 5042). One-time token approval, then min received is enforced at your slippage.</>
                  : <><b>Arc mainnet · live (chain 5042).</b> Fetching the best route for this pair… if it doesn't resolve, it may route only on Uniswap v4 — you can trade it on Warp meanwhile.</>}
            </div>
          )}
          {qErr && <div className="swap-info err"><span>{qErr}</span><span /></div>}

          {!wallet
            ? <button className="btn solid swap-cta" onClick={onConnect}>Connect Wallet</button>
            : (v3q != null)
              ? <button className="btn solid swap-cta" onClick={executeV3} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : `Swap ${from?.symbol} → ${to?.symbol}`}
                </button>
            : (v4q != null)
              ? <button className="btn solid swap-cta" onClick={executeV4} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : `Swap ${from?.symbol} → ${to?.symbol}`}
                </button>
            : (curveBuyable && curveOut != null)
              ? <button className="btn solid swap-cta" onClick={executeCurveBuy} disabled={busy}>
                  {phase === 'swapping' ? 'Buying…' : `Buy ${to?.symbol}`}
                </button>
            : (curveSellable && curveSellOut != null)
              ? <button className="btn solid swap-cta" onClick={executeCurveSell} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Selling…' : `Sell ${from?.symbol}`}
                </button>
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
          {/* Your holdings — top tokens by value (RadarDEX), one tap to trade */}
          <div className="panel side-card sp-card">
            <div className="sp-head"><h3>Your Holdings</h3>{pfTotal != null && <span className="sp-total">{usd(pfTotal)}</span>}</div>
            {!wallet ? <p className="side-note">Connect your wallet to see your holdings and recent trades here.</p>
              : holdings == null ? <div className="side-note">Loading holdings…</div>
              : !holdings.length ? <div className="side-note">No tokens held on Arc yet.</div>
              : <div className="sp-holds">
                  {holdings.slice(0, 6).map((h) => (
                    <button className="sp-hold" key={h.address} onClick={() => tradeHolding(h)} title={`Trade ${h.symbol}`}>
                      <TokenLogo symbol={h.symbol} seed={h.address} url={h.icon} />
                      <span className="sp-h-id"><span className="sp-h-sym">{h.symbol}</span><span className="sp-h-amt">{compact(h.amount)}</span></span>
                      <span className="sp-h-usd">{h.usd != null ? usd(h.usd) : '—'}</span>
                    </button>
                  ))}
                </div>}
          </div>

          {/* Recent transactions — the connected wallet's activity (arc-scan) */}
          <div className="panel side-card sp-card">
            <h3>Recent Transactions</h3>
            {!wallet ? <p className="side-note">Your latest swaps &amp; transfers will show here once connected.</p>
              : acts == null ? <div className="side-note">Loading activity…</div>
              : !acts.length ? <div className="side-note">No recent transactions found on Arc.</div>
              : <div className="sp-acts">
                  {acts.map((t) => (
                    <a className="sp-act" key={t.hash} href={`https://explorer.arc.io/tx/${t.hash}`} target="_blank" rel="noreferrer">
                      <span className={`sp-a-m ${t.status ? '' : 'fail'}`}>{t.method}</span>
                      <span className="sp-a-v">{t.value != null && t.value > 0 ? `${compact(t.value)} ${t.symbol || ''}` : ''}</span>
                      <span className="sp-a-t">{timeAgo(t.ts)}</span>
                    </a>
                  ))}
                </div>}
          </div>

          {/* Compact how-it-works — small, no longer competing with the swap */}
          <details className="sp-how">
            <summary>How routing works</summary>
            <p className="side-note">{warpMode
              ? <>Graduated tokens fill through WarpV2; bonding-curve &amp; Uniswap-v3/v4 tokens route on their own pools in-app. Native USDC (0x3600) is the gas token. Paste any Arc ERC-20 in a token menu to import it — no pool shows "no route", never a bad fill. Min received enforced on-chain.</>
              : <>Quoted against every live router on {CHAIN.name} ({SWAP_CFG.routers.length} tracked) for the deepest fill. Native USDC (0x3600) is Arc's gas token. Paste any ERC-20 to import it. Min received enforced on-chain at your slippage.</>}</p>
          </details>
        </aside>
      </div>
    </section></div>
  );
}
