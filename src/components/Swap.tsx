import { useEffect, useMemo, useRef, useState } from 'react';
import { PINNED } from '../lib/rules';
import { MIN_VOL_24H } from '../lib/board';
import { tprice, compact, usd, CHAIN, mergeHoldings, fetchPortfolioMainnet, fetchHoldingsOnchain, fetchRadarPortfolio, fetchAddressTxs, type Token, type RadarHolding, type WalletTx, activeEth } from '../lib/arc';
import { TokenLogo } from './TokenLogo';
import { IconSwapVertical, IconExternal } from './icons';
import {
  NATIVE_USDC, SWAP_CFG, swapReady, bestQuote, decimalsOf, symbolOf, balanceOf, allowance,
  buildApproveTx, buildSwapTx, simulate, minOut, toRawStr, rawToStr, fromRaw, feeCandidates, MAX_UINT256,
  permitInfo, buildPermitTypedData, buildSwapWithPermitTx, type Quote, type TxReq,
  setSwapMainnet, activeScan, MAINNET_CHAIN_ID, quoteCurveBuy, buildCurveBuyTx,
  quoteCurveSell, buildCurveSellTx, quoteV3, buildV3SwapTx, v3PoolFor, V3_ROUTER,
  quoteV4, buildV4SwapTx, v4Permit2Status, buildPermit2ApproveTx, PERMIT2,
  findV3Pool, findV4Route, type V4Cfg, findCLPools, quoteCL, buildCLSwapTx, type CLRoute,
  networkFeeUsdc, clPoolFeeBps, hookTaxBps, ROUTER_FEE_BPS, VENUE_GAS,
  findArctidePair, quoteArctide, buildArctideSwapTx, ARCTIDE_ROUTER, type ArctideRoute,
} from '../lib/swap';
import { fetchWarpToken } from '../lib/warp';
import { TokenPicker } from './TokenPicker';

const USDC: Token = {
  address: NATIVE_USDC, name: 'USD Coin', symbol: 'USDC', holders: null, totalSupply: null,
  type: 'ERC-20', iconUrl: null, launchpad: null, isOurs: false, isEcosystem: true, price: 1, liq: null, mcap: null,
};

const eth = () => activeEth();
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
          rpcUrls: ['https://rpc.mainnet.arc.io', 'https://arc.drpc.org'], blockExplorerUrls: ['https://explorer.arc.io'],
        }] });
        return true;
      } catch { return false; }
    }
    return false;
  }
}

const SLIPPAGES = [0.5, 1, 3];
// Token amounts: compact (1.3K) at >= 1, significant digits below — `compact` rounded 0.000118 cirBTC to "0".
const amtFmt = (n: number) => (n >= 1 ? compact(n) : n > 0 ? String(Number(n.toPrecision(4))) : '0');

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

  // What the pickers OFFER (owner 09-29: "just trade indexed tokens and filter out all the other"): the screener's own
  // tokens — traded in the last 24h, ecosystem or pinned (109 of the 384 real tokens) — plus anything already loaded here
  // (your own holdings tapped from the side panel, a token page's Trade button, the current pair).
  const pickList = useMemo(() => universe.filter((t) => {
    const k = t.address.toLowerCase();
    return k === USDC.address.toLowerCase() || t.isEcosystem || PINNED.has(k) || (t.volume24h ?? 0) >= MIN_VOL_24H || extra.some((x) => x.address.toLowerCase() === k);
  }), [universe, extra]);
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
    // ⛔ was `?? 18`: a guessed decimals made every 8-dec cirBTC amount 10^10 off (quote read "0 cirBTC", 09-25).
    // The decimals effect reads the real value from the contract.
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
      // A failed read throws (never a fake 0) — keep what's shown and try again on the next change.
      try { const b = await balanceOf(a!, wallet); if (alive) setBal((p) => ({ ...p, [a!.toLowerCase()]: b })); } catch { /* keep */ }
    });
    return () => { alive = false; };
  }, [wallet, fromA, toA, phaseTick]); // eslint-disable-line

  // Connected wallet's holdings (top tokens) + recent transactions — the side panel (X1-style).
  const [holdings, setHoldings] = useState<RadarHolding[] | null>(null);
  const [acts, setActs] = useState<WalletTx[] | null>(null);
  useEffect(() => {
    if (!wallet) { setHoldings(null); setActs(null); return; }
    let alive = true;
    setHoldings((h) => h ?? null); setActs((a) => a ?? null);
    // Same source as the Portfolio page (09-25 — this panel showed $61 of a ~$190 bag): the explorer / RadarDEX
    // paint first, then the COMPLETE on-chain read (/api/holdings: every token the wallet ever received, balances
    // via Multicall, priced V3/V2/V4/Warp) replaces it. Prices the endpoint left blank come from the screener list.
    const byScreener = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
    const priced = (list: RadarHolding[]) => list.map((h) => {
      const k = h.address.toLowerCase();
      let price = h.price ?? byScreener.get(k)?.price ?? null;
      if (price != null && !(isFinite(price) && price > 0 && price < 1e6)) price = null; // same sanity clamp as Portfolio
      const v = price != null ? h.amount * price : null;
      return { ...h, icon: h.icon ?? byScreener.get(k)?.iconUrl ?? null, price, usd: v != null && v < 1e9 ? v : null };
    }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.amount - a.amount);
    fetchPortfolioMainnet(wallet)
      .then(async (pf) => (pf.holdings.length ? pf : await fetchRadarPortfolio(wallet).catch(() => pf)))
      .then((pf) => { if (alive) setHoldings((prev) => priced(mergeHoldings(pf.holdings, prev ?? []))); })
      .catch(() => { if (alive) setHoldings((prev) => prev ?? []); });
    fetchHoldingsOnchain(wallet).then((oc) => {
      if (alive && oc.ok && oc.holdings.length) setHoldings((prev) => priced(mergeHoldings(prev ?? [], oc.holdings))); // merged, never replaced (10-02)
    }).catch(() => { /* the fast view stands */ });
    fetchAddressTxs(wallet, 12).then((t) => { if (alive) setActs(t); }).catch(() => { if (alive) setActs([]); });
    return () => { alive = false; };
  }, [wallet, phaseTick]); // eslint-disable-line

  // Total = sum of the listed holdings' USD, so it always matches what's shown (incl. the phase-2 core merge).
  const byAddrEco = (a: string) => !!tokens.find((t) => t.address.toLowerCase() === a.toLowerCase() && t.isEcosystem);
  const pfTotal = holdings && holdings.some((h) => h.usd != null) ? holdings.reduce((s, h) => s + (h.usd ?? 0), 0) : null;

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
  // Uniswap V3 / V4 pools for the traded token, found on-chain for ANY token (09-25 — before, only 11 hardcoded V3
  // pools and 2 V4 tokens could trade here). The V4 key comes from the screener row and is checked against the poolId.
  const [route, setRoute] = useState<{ addr: string; v3: string | null; v4: V4Cfg | null; cl: CLRoute[]; at: ArctideRoute | null } | null>(null);
  useEffect(() => {
    if (!warpTokenAddr) { setRoute(null); return; }
    const k = warpTokenAddr.toLowerCase(); let alive = true;
    // Pool hint from the SCREENER row (it carries poolId + PoolKey); a token loaded via Trade/paste is a bare stub.
    const hint = tokens.find((t) => t.address.toLowerCase() === k) || universe.find((t) => t.address.toLowerCase() === k);
    Promise.all([findV3Pool(k).catch(() => null), findV4Route(k, hint).catch(() => null), findCLPools(k).catch(() => [] as CLRoute[]), findArctidePair(k).catch(() => null)])
      .then(([v3, v4, cl, at]) => { if (alive) setRoute({ addr: k, v3, v4, cl, at }); });
    return () => { alive = false; };
  }, [warpTokenAddr, tokens.length]); // eslint-disable-line
  const routeFor = (a?: string) => (route && a && route.addr === a.toLowerCase() ? route : null);
  const [curveOut, setCurveOut] = useState<bigint | null>(null); // in-app curve-buy expected tokens
  const [curveSellOut, setCurveSellOut] = useState<bigint | null>(null); // curve-sell expected USDC (6-dec)
  const [v3q, setV3q] = useState<{ outRaw: bigint; fee: number; tokenIn: string; tokenOut: string } | null>(null); // Uni V3 quote
  const [v4q, setV4q] = useState<{ outRaw: bigint; zeroForOne: boolean } | null>(null); // Uni V4 quote
  const [clq, setClq] = useState<{ outRaw: bigint; route: CLRoute } | null>(null); // Aerodrome / Archery (CL) quote
  const [atq, setAtq] = useState<{ outRaw: bigint; feeBps: number; route: ArctideRoute } | null>(null); // Arctide quote
  // Curve BUY = paying USDC into a non-graduated curve token's curve contract (no WarpV2 route needed).
  const curveBuyable = !!(warpMode && warpMeta && !warpMeta.migrated && warpMeta.curve
    && fromA.toLowerCase() === usdcK && to && to.address.toLowerCase() === warpMeta.addr);
  // Curve SELL = sending a non-graduated curve token back into its curve for USDC.
  const curveSellable = !!(warpMode && warpMeta && !warpMeta.migrated && warpMeta.curve
    && toA.toLowerCase() === usdcK && from && from.address.toLowerCase() === warpMeta.addr);
  // Uniswap V3 (Argus factory) trade = one side USDC, the other a V3-pooled token (buy OR sell).
  const v3Trade = !!(warpMode && from && to && ((fromA.toLowerCase() === usdcK && (v3PoolFor(to.address) || routeFor(to.address)?.v3)) || (toA.toLowerCase() === usdcK && (v3PoolFor(from.address) || routeFor(from.address)?.v3))));
  // Uniswap V4 trade = one side USDC, the other a V4-only token (e.g. ARCX10, hooked pool).
  const v4Trade = !!(warpMode && from && to && ((fromA.toLowerCase() === usdcK && routeFor(to.address)?.v4) || (toA.toLowerCase() === usdcK && routeFor(from.address)?.v4)));
  const tradeToken = from && fromA.toLowerCase() !== usdcK ? from.address : to?.address;
  const v3PoolSel = v3Trade ? (v3PoolFor(tradeToken || '') || routeFor(tradeToken)?.v3 || null) : null;
  const v4CfgSel = v4Trade ? (routeFor(tradeToken)?.v4 || null) : null;
  // Aerodrome / Archery (concentrated-liquidity forks) = one side USDC, the other a token with a CL pool on either venue.
  const clRoutes = warpMode && from && to && (fromA.toLowerCase() === usdcK || toA.toLowerCase() === usdcK) ? (routeFor(tradeToken)?.cl || []) : [];
  // Arctide = one side USDC, the other a token with an Arctide pair (its own router; fee read from the pair).
  const atRoute = warpMode && from && to && (fromA.toLowerCase() === usdcK || toA.toLowerCase() === usdcK) ? (routeFor(tradeToken)?.at || null) : null;
  // Auto-refresh the live quote every 12s (mainnet pools move fast — keeps the shown amount current).
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!warpMode || !amt) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), 12000);
    return () => clearInterval(id);
  }, [warpMode, amt]);

  useEffect(() => {
    const n = parseFloat(amt);
    setQuote(null); setQErr(null); setEstimate(null); setCurveOut(null); setCurveSellOut(null); setV3q(null); setV4q(null); setClq(null); setAtq(null);
    if (!from || !to || !n || n <= 0) return;

    // ── Warp / mainnet token → real WarpV2 quote, with a price-estimate fallback ──
    if (warpMode) {
      if (decIn == null || decOut == null) return;
      // ⛔ 10-05: quote only once EVERY venue's pools are known for this token. Before, the stock V2 routers answered
      // first and for ~1-2 s the page showed (and the button would execute) a dust V2 pool's fill: ARCH 0.35 instead of
      // 30.7K, EURC 0.139 instead of 0.89 per USDC — then V3/CL replaced it.
      if (warpTokenAddr && !routeFor(warpTokenAddr)) { setQuoting(true); return; }
      const seq = ++qSeq.current;
      setQuoting(true);
      const id = setTimeout(async () => {
        const amountInRaw = toRawStr(amt, decIn);
        // Every venue the token trades on, quoted together — the best fill wins (a token can have WarpV2 AND V3 AND
        // V4 pools; the first one that answered used to win even when another paid more).
        const [q, r3, r4, rc, ra] = await Promise.all([
          bestQuote(from.address, to.address, amountInRaw).catch(() => null), // engine is on mainnet (see flip effect)
          v3Trade ? quoteV3(from.address, to.address, amountInRaw, v3PoolSel).catch(() => null) : Promise.resolve(null),
          v4Trade ? quoteV4(from.address, to.address, amountInRaw, v4CfgSel).catch(() => null) : Promise.resolve(null),
          clRoutes.length ? quoteCL(from.address, to.address, amountInRaw, clRoutes).catch(() => null) : Promise.resolve(null),
          atRoute ? quoteArctide(from.address, to.address, amountInRaw, atRoute).catch(() => null) : Promise.resolve(null),
        ]);
        if (seq !== qSeq.current) return;
        const outs = [q?.amountOutRaw ?? -1n, r3?.outRaw ?? -1n, r4?.outRaw ?? -1n, rc?.outRaw ?? -1n, ra?.outRaw ?? -1n];
        const best = outs.reduce((bi, v, i) => (v > outs[bi] ? i : bi), 0);
        if (outs[best] > 0n) {
          setQuoting(false);
          if (best === 0) setQuote(q);
          else if (best === 1) setV3q({ outRaw: r3!.outRaw, fee: r3!.fee, tokenIn: from.address, tokenOut: to.address });
          else if (best === 2) setV4q(r4);
          else if (best === 3) setClq(rc);
          else setAtq(ra);
          return;
        }
        // Curve BUY: USDC → a non-graduated Warp curve token, quoted live from the curve contract.
        if (curveBuyable && wallet) {
          const raw = await quoteCurveBuy(warpMeta!.curve!, n, wallet);
          if (seq !== qSeq.current) return;
          if (raw) { setQuoting(false); setCurveOut(raw); return; }
        }
        // Curve SELL: a non-graduated curve token → USDC, quoted live from the curve (6-dec out).
        if (curveSellable && wallet && decIn != null) {
          const usdc6 = await quoteCurveSell(warpMeta!.curve!, toRawStr(amt, decIn), wallet);
          if (seq !== qSeq.current) return;
          if (usdc6) { setQuoting(false); setCurveSellOut(usdc6); return; }
        }
        setQuoting(false);
        // No route via WarpV2 / V3 / V4 / curve. If we at least know both prices, show an estimate;
        // otherwise there's no tradeable pool for this token yet on any Arc DEX we route.
        const pf = pxOf(from.address.toLowerCase()), pt = pxOf(to.address.toLowerCase());
        if (pf && pt) setEstimate({ out: (n * pf) / pt });
        else setQErr('No liquidity pool found for this token on Arc yet — there’s nothing to trade against. It becomes buyable here automatically once a pool is created.');
      }, 450);
      return () => clearTimeout(id);
    }

    if (decIn == null || decOut == null) return;
    if (!swapReady()) { setQErr('Swaps go live with Arc mainnet on Sept 16.'); return; }
    const seq = ++qSeq.current;
    setQuoting(true);
    const id = setTimeout(async () => {
      const amountInRaw = toRawStr(amt, decIn);
      const q = await bestQuote(from.address, to.address, amountInRaw);
      if (seq !== qSeq.current) return;
      setQuoting(false);
      if (!q) { setQErr('No route via our supported DEXes — this token’s pool may be on a DEX we don’t aggregate yet (e.g. a custom launchpad AMM).'); return; }
      setQuote(q);
    }, 450);
    return () => clearTimeout(id);
  }, [amt, fromA, toA, decIn, decOut, warpMode, warpMeta, wallet, v3Trade, v4Trade, v3PoolSel, v4CfgSel, clRoutes.length, atRoute, route, refreshTick]); // eslint-disable-line

  const outHuman = atq != null && decOut != null ? fromRaw(atq.outRaw, decOut)
    : clq != null && decOut != null ? fromRaw(clq.outRaw, decOut)
    : v3q != null && decOut != null ? fromRaw(v3q.outRaw, decOut)
    : v4q != null && decOut != null ? fromRaw(v4q.outRaw, decOut)
    : curveOut != null && decOut != null ? fromRaw(curveOut, decOut)
    : curveSellOut != null && decOut != null ? fromRaw(curveSellOut, decOut)
    : estimate ? estimate.out
    : (quote && decOut != null ? fromRaw(quote.amountOutRaw, decOut) : null);
  const minRecv = quote && decOut != null ? fromRaw(minOut(quote.amountOutRaw, slip), decOut)
    : clq != null && decOut != null ? fromRaw(minOut(clq.outRaw, slip), decOut)
    : atq != null && decOut != null ? fromRaw(minOut(atq.outRaw, slip), decOut)
    : v3q != null && decOut != null ? fromRaw(minOut(v3q.outRaw, slip), decOut)
    : v4q != null && decOut != null ? fromRaw(minOut(v4q.outRaw, slip), decOut)
    : curveOut != null && decOut != null ? fromRaw(minOut(curveOut, slip), decOut)
    : (curveSellOut != null && decOut != null ? fromRaw(minOut(curveSellOut, slip), decOut) : null);
  const rate = outHuman && parseFloat(amt) ? outHuman / parseFloat(amt) : null;
  // What this fill pays vs the token's market price (screener, on-chain). Thin pools and 4-5% pool fees are common
  // on Arc — a $10 cirBTC buy through its only V4 pool costs ~3x market (09-25) — so every quote shows it.
  const mkt = (() => {
    const tokSide = fromA.toLowerCase() === usdcK ? to : toA.toLowerCase() === usdcK ? from : null;
    const p = tokSide ? universe.find((t) => t.address.toLowerCase() === tokSide.address.toLowerCase())?.price : null;
    const n = parseFloat(amt);
    if (!tokSide || !p || !(p > 0) || !outHuman || !n || estimate) return null;
    // VALUE lost vs market (09-29): what you get is worth X% less than what you pay, both at the market price — the same
    // number as the % under 'You receive'. (Was 'extra price paid per token': ARCAT showed 75% here and -42.86% there.)
    return fromA.toLowerCase() === usdcK ? (1 - (outHuman * p) / n) * 100 : (1 - outHuman / (n * p)) * 100; // + = worse
  })();
  const mktRow = mkt != null && Math.abs(mkt) >= 0.5 ? (
    <div className={`sq-row${mkt >= 5 ? ' warn' : ''}`}><span>Total cost vs market</span><span className="mono" style={mkt >= 5 ? { color: '#ff5a5a' } : undefined}>{mkt >= 0 ? `${mkt.toFixed(1)}% worse` : `${(-mkt).toFixed(1)}% better`}{mkt >= 5 ? ' — thin pool / high fee' : ''}</span></div>
  ) : null;

  // ── Trade details (09-29, owner: "ticker, balance, USD price, price impact, fees — how much they pay and receive") ──
  // One panel for every venue: the winning fill, its pool fee (read or measured, never assumed), an Argus hook's tax,
  // price impact (the same venue quoted at 1/1000 of the size — fees and taxes cancel out, what's left is the slippage the
  // pool itself causes), the network fee, and USD on both sides.
  const isBuy = fromA.toLowerCase() === usdcK;
  const hooked = !!(v4CfgSel && v4CfgSel.hooks && !/^0x0+$/.test(v4CfgSel.hooks));
  const fill = quote ? { kind: 'v2' as const, out: quote.amountOutRaw, label: `${quote.routerName === 'WarpV2' ? 'Warp V2' : quote.routerName} · ${quote.hops === 1 ? 'direct' : `${quote.hops} hops`}`,
      feeBps: quote.kind === 'pair' ? (quote.feeBps ?? null) : (ROUTER_FEE_BPS[quote.routerName] ?? null) }
    : v3q ? { kind: 'v3' as const, out: v3q.outRaw, label: 'Uniswap V3 · direct', feeBps: v3q.fee / 100 }
    : clq ? { kind: 'cl' as const, out: clq.outRaw, label: `${clq.route.venue.name} · direct`, feeBps: null as number | null }
    : atq ? { kind: 'arctide' as const, out: atq.outRaw, label: 'Arctide · direct', feeBps: atq.feeBps as number | null }
    : v4q ? { kind: 'v4' as const, out: v4q.outRaw, label: `Uniswap V4${hooked ? ' · hooked pool' : ''} · direct`, feeBps: v4CfgSel ? v4CfgSel.fee / 100 : null }
    : curveOut != null ? { kind: 'curve' as const, out: curveOut, label: 'Warp bonding curve', feeBps: null }
    : curveSellOut != null ? { kind: 'curve' as const, out: curveSellOut, label: 'Warp bonding curve', feeBps: null }
    : null;
  const [det, setDet] = useState<{ key: string; impact: number | null; clFee: number | null; tax: number | null; gasUsd: number | null } | null>(null);
  const detKey = fill ? `${fill.kind}:${fromA}:${toA}:${amt}:${fill.out}` : '';
  useEffect(() => {
    if (!fill || decIn == null || !parseFloat(amt)) { setDet(null); return; }
    let alive = true; const key = detKey;
    (async () => {
      const inRaw = BigInt(toRawStr(amt, decIn)); const small = inRaw / 1000n > 0n ? inRaw / 1000n : 1n;
      const smallQ = async (): Promise<bigint | null> => {
        if (fill.kind === 'v2') return (await bestQuote(from.address, to!.address, small).catch(() => null))?.amountOutRaw ?? null;
        if (fill.kind === 'v3') return (await quoteV3(from.address, to!.address, small, v3PoolSel).catch(() => null))?.outRaw ?? null;
        if (fill.kind === 'v4') return (await quoteV4(from.address, to!.address, small, v4CfgSel).catch(() => null))?.outRaw ?? null;
        if (fill.kind === 'cl') return (await quoteCL(from.address, to!.address, small, [clq!.route]).catch(() => null))?.outRaw ?? null;
        if (fill.kind === 'arctide') return (await quoteArctide(from.address, to!.address, small, atq!.route).catch(() => null))?.outRaw ?? null;
        return null; // curve: quoted per wallet; impact shown as — rather than a guess
      };
      const [outS, clFee, tax, gasUsd] = await Promise.all([
        smallQ(),
        fill.kind === 'cl' ? clPoolFeeBps(clq!.route.pool) : Promise.resolve(null),
        fill.kind === 'v4' && hooked ? hookTaxBps(v4CfgSel!.hooks, isBuy) : Promise.resolve(fill.kind === 'v4' ? 0 : null),
        networkFeeUsdc(VENUE_GAS[fill.kind]),
      ]);
      let impact: number | null = null;
      if (outS && outS > 0n) { const r = (Number(fill.out) / Number(inRaw)) / (Number(outS) / Number(small)); impact = Math.max(0, (1 - r) * 100); }
      if (alive) setDet({ key, impact, clFee, tax, gasUsd });
    })();
    return () => { alive = false; };
  }, [detKey]); // eslint-disable-line
  const d0 = det && det.key === detKey ? det : null;
  const priceOf = (a?: string) => { const k = (a || '').toLowerCase(); if (!k) return null; if (k === usdcK) return 1; const t = universe.find((x) => x.address.toLowerCase() === k); return t?.price ?? warpPx[k] ?? null; };
  const payUsd = parseFloat(amt) > 0 && priceOf(from?.address) != null ? parseFloat(amt) * priceOf(from?.address)! : null;
  const recvUsd = outHuman != null && priceOf(to?.address) != null ? outHuman * priceOf(to?.address)! : null;
  const feeBps = fill ? (fill.kind === 'cl' ? d0?.clFee ?? null : fill.feeBps) : null;
  const usdS = (v: number | null) => (v == null || !isFinite(v) ? '—' : v > 0 && v < 0.01 ? '<$0.01' : usd(v));
  const tokSide = isBuy ? to : from;
  const details = fill && rate != null ? (
    <div className="swap-quote">
      {tokSide && priceOf(tokSide.address) != null && <div className="sq-row"><span>Price</span><span className="mono">1 {tokSide.symbol} = {tprice(priceOf(tokSide.address)!)}</span></div>}
      <div className="sq-row"><span>Rate</span><span className="mono">1 {from?.symbol} ≈ {amtFmt(rate)} {to?.symbol}</span></div>
      <div className={`sq-row${d0?.impact != null && d0.impact >= 3 ? ' warn' : ''}`}><span>Price impact</span>
        <span className="mono" style={d0?.impact != null ? { color: d0.impact >= 3 ? '#ff5a5a' : d0.impact >= 1 ? '#ffb14a' : '#4ecb71' } : undefined}>
          {d0 ? (d0.impact != null ? (d0.impact < 0.01 ? '<0.01%' : `${d0.impact.toFixed(2)}%`) : '—') : '…'}</span></div>
      <div className="sq-row"><span>Pool fee</span><span className="mono">{feeBps != null ? `${(feeBps / 100).toFixed(feeBps < 10 ? 3 : 2)}% · ${usdS(payUsd != null ? payUsd * feeBps / 10000 : null)}` : fill.kind === 'curve' ? 'included in the curve price' : d0 ? '—' : '…'}</span></div>
      {fill.kind === 'v4' && hooked && (
        <div className="sq-row"><span>Token tax</span><span className="mono">{d0 ? (d0.tax != null ? `${(d0.tax / 100).toFixed(2)}% ${isBuy ? 'buy' : 'sell'} tax · ${usdS(payUsd != null ? payUsd * d0.tax / 10000 : null)}` : 'hooked pool — may charge a tax') : '…'}</span></div>
      )}
      <div className="sq-row"><span>Network fee</span><span className="mono">{d0 ? (d0.gasUsd != null ? `≈ $${d0.gasUsd < 0.01 ? d0.gasUsd.toFixed(4) : d0.gasUsd.toFixed(2)} (paid in USDC)` : '—') : '…'}</span></div>
      <div className="sq-row"><span>Min received</span><span className="mono">{minRecv != null ? `${amtFmt(minRecv)} ${to?.symbol}${priceOf(to?.address) != null ? ` · ${usdS(minRecv * priceOf(to?.address)!)}` : ''}` : '—'}</span></div>
      <div className="sq-row"><span>Route</span><span className="mono">{fill.label}</span></div>
      {mktRow}
    </div>
  ) : null;

  const fromBalRaw = from ? bal[from.address.toLowerCase()] : undefined;
  const notEnough = (() => { try { return !!(wallet && fromBalRaw != null && decIn != null && parseFloat(amt) > 0 && BigInt(toRawStr(amt, decIn)) > fromBalRaw); } catch { return false; } })();
  const toBalRaw = to ? bal[to.address.toLowerCase()] : undefined;
  const fromBal = fromBalRaw != null && decIn != null ? fromRaw(fromBalRaw, decIn) : null;
  const toBal = toBalRaw != null && decOut != null ? fromRaw(toBalRaw, decOut) : null;
  // MAX = the exact on-chain balance (no float rounding). Paying with USDC keeps 0.05 back: USDC is also the gas token.
  const setMax = () => {
    if (fromBalRaw == null || decIn == null) return;
    const reserve = fromA.toLowerCase() === usdcK ? 50_000n : 0n; // 0.05 USDC at 6 dec
    setAmt(rawToStr(fromBalRaw > reserve ? fromBalRaw - reserve : 0n, decIn));
  };
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
    if (existing) { setExtra((p) => (p.some((x) => x.address.toLowerCase() === a.toLowerCase()) ? p : [existing, ...p])); (side === 'from' ? setFromA : setToA)(existing.address); return; }
    // Not in Statera's index (spam, a fake ticker, or a token with no real pool): not tradeable here — say so plainly.
    if (tokens.length) { setQErr("That token isn't listed on Statera. Only indexed tokens (the ones on the screener) can be traded here."); return; }
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
      const amountInRaw = toRawStr(amt, decIn);
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
      const amountInRaw = toRawStr(amt, decIn);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      if ((await allowance(from.address, wallet, V3_ROUTER)) < amountInRaw) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol}…`);
        if (!(await waitReceipt(await sendTx(buildApproveTx(from.address, V3_ROUTER, MAX_UINT256, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      // Re-quote at the moment of execution so min-out reflects the CURRENT price (these pools move
      // fast; a stale display quote is what caused reverts). Approval can take a few blocks too.
      const fresh = await quoteV3(from.address, to.address, amountInRaw, v3PoolSel);
      if (!fresh) { setPhase('error'); setMsg('Could not refresh the quote — try again.'); return; }
      const tx = buildV3SwapTx(from.address, to.address, fresh.fee, amountInRaw, minOut(fresh.outRaw, slip), wallet);
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} to ${to.symbol}.`);
      setAmt(''); setPhaseTick((t) => t + 1);
    } catch (e: any) { setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.'); }
  };

  // In-app Aerodrome / Archery swap (CL forks) — approve tokenIn to that venue's router → exactInputSingle(tickSpacing).
  const executeCL = async () => {
    if (!wallet || !clq || !from || !to || decIn == null) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      setMsg('Switch your wallet to Arc mainnet…');
      if (!(await ensureChain(MAINNET_CHAIN_ID))) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
      setMsg(null);
      const amountInRaw = toRawStr(amt, decIn);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      const router = clq.route.venue.router;
      if ((await allowance(from.address, wallet, router)) < amountInRaw) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol} on ${clq.route.venue.name}…`);
        if (!(await waitReceipt(await sendTx(buildApproveTx(from.address, router, MAX_UINT256, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      // Re-quote at execution (same pool) so min-out reflects the CURRENT price.
      const fresh = await quoteCL(from.address, to.address, amountInRaw, [clq.route]);
      if (!fresh) { setPhase('error'); setMsg('Could not refresh the quote — try again.'); return; }
      const tx = buildCLSwapTx(fresh.route, from.address, to.address, amountInRaw, minOut(fresh.outRaw, slip), wallet);
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} to ${to.symbol} on ${fresh.route.venue.name}.`);
      setAmt(''); setPhaseTick((t) => t + 1);
    } catch (e: any) { setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.'); }
  };

  // In-app Arctide swap — its pairs only trade through ITS router. Buy = native USDC as value (no approval); sell = approve
  // the token to the router once, then the router pays native USDC. The router fee comes off the USDC side (quoted in).
  const executeArctide = async () => {
    if (!wallet || !atq || !from || !to || decIn == null) return;
    setPhase('idle'); setMsg(null); setHash(null);
    try {
      setMsg('Switch your wallet to Arc mainnet…');
      if (!(await ensureChain(MAINNET_CHAIN_ID))) { setPhase('error'); setMsg('Please switch your wallet to Arc mainnet (chain 5042) to trade.'); return; }
      setMsg(null);
      const buy = from.address.toLowerCase() === usdcK;
      const amountInRaw = toRawStr(amt, decIn);
      const bal = await balanceOf(from.address, wallet);
      if (bal < amountInRaw) { setPhase('error'); setMsg(`Insufficient ${from.symbol} balance.`); return; }
      if (!buy && (await allowance(from.address, wallet, ARCTIDE_ROUTER)) < amountInRaw) {
        setPhase('approving'); setMsg(`One-time approval for ${from.symbol} on Arctide…`);
        if (!(await waitReceipt(await sendTx(buildApproveTx(from.address, ARCTIDE_ROUTER, MAX_UINT256, wallet))))) { setPhase('error'); setMsg('Approval failed.'); return; }
      }
      // Re-quote at execution so min-out reflects the CURRENT price.
      const fresh = await quoteArctide(from.address, to.address, amountInRaw, atq.route);
      if (!fresh) { setPhase('error'); setMsg('Could not refresh the quote — try again.'); return; }
      const tx = buildArctideSwapTx(fresh.route, buy, amountInRaw, minOut(fresh.outRaw, slip), wallet);
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} to ${to.symbol} on Arctide.`);
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
      const amountInRaw = toRawStr(amt, decIn);
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
      const fresh = await quoteV4(from.address, to.address, amountInRaw, v4CfgSel); // fresh min-out at current price
      const outRaw = fresh?.outRaw ?? v4q.outRaw;
      const tx = buildV4SwapTx(from.address.toLowerCase() === usdcK ? to.address : from.address, v4q.zeroForOne, amountInRaw, minOut(outRaw, slip), wallet, v4CfgSel);
      if (!tx) { setPhase('error'); setMsg('Could not build the V4 swap.'); return; }
      const rev = await simulate(tx);
      if (rev) { setPhase('error'); setMsg(`Swap would revert: ${rev}. Try a higher slippage.`); return; }
      setPhase('swapping'); setMsg('Confirm the swap in your wallet…');
      const sh = await sendTx(tx); setHash(sh);
      if (!(await waitReceipt(sh))) { setPhase('error'); setMsg('Swap transaction failed.'); return; }
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} to ${to.symbol}.`);
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
      setPhase('done'); setMsg(`Swapped ${amt} ${from.symbol} to ${to?.symbol}.`);
      setAmt(''); setPhaseTick((t) => t + 1); // refresh balances
    } catch (e: any) {
      setPhase('error'); setMsg(e?.message?.slice(0, 120) || 'Transaction rejected.');
    }
  };

  const busy = phase === 'approving' || phase === 'swapping';

  return (
    <div className="wrap"><section className="section swap-section">
      <div className="section-head swap-section-head">
        <div><div className="kicker">Swap</div><h2>Swap Tokens</h2>
          <p>Trade any Arc token — routed through the deepest on-chain liquidity, with slippage-protected execution. Any token address works.</p></div>
      </div>

      <div className="swap-wrap">
        <div className="swap-card">
          <div className="swap-head">
            <span className="swap-head-title">Swap</span>
            <span className="swap-head-net"><span className="dot" /> Arc Mainnet</span>
          </div>
          <div className="swap-box">
            <div className="swap-row">
              <span className="swap-l">You pay</span>
              {wallet && fromBal != null && (
                <span className="swap-bal">Balance: {fmtBal(fromBal)} {from?.symbol}
                  {fromBal > 0 && <button type="button" className="swap-max" onClick={setMax}>MAX</button>}
                </span>
              )}
            </div>
            <div className="swap-in">
              <input className="swap-amt" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
              <TokenPicker value={from} tokens={pickList} exclude={toA} onSelect={(t) => setFromA(t.address)} onAddAddress={(a) => addToken(a, 'from')} adding={adding} />
            </div>
            <div className="swap-usd">{payUsd != null ? `≈ ${usdS(payUsd)}` : '\u00a0'}</div>
          </div>

          <button className="swap-flip" onClick={flip} aria-label="flip"><IconSwapVertical /></button>

          <div className="swap-box">
            <div className="swap-row">
              <span className="swap-l">You receive (est.)</span>
              {wallet && to && toBal != null && <span className="swap-bal">Balance: {fmtBal(toBal)} {to.symbol}</span>}
            </div>
            <div className="swap-in">
              <input className="swap-amt" placeholder="0.0" value={outHuman != null ? amtFmt(outHuman) : ''} readOnly />
              <TokenPicker value={to} tokens={pickList} exclude={fromA} onSelect={(t) => setToA(t.address)} onAddAddress={(a) => addToken(a, 'to')} adding={adding} />
            </div>
            <div className="swap-usd">{recvUsd != null ? `≈ ${usdS(recvUsd)}${payUsd != null && payUsd > 0 ? ` (${recvUsd >= payUsd ? '+' : '−'}${Math.abs((recvUsd / payUsd - 1) * 100).toFixed(2)}%)` : ''}` : '\u00a0'}</div>
          </div>

          <div className="swap-settings">
            <span className="swap-l">Max slippage</span>
            <div className="slip-opts">
              {SLIPPAGES.map((s) => <button key={s} className={slip === s ? 'on' : ''} onClick={() => setSlip(s)}>{s}%</button>)}
            </div>
          </div>

          {quoting && <div className="swap-info"><span>Finding best route…</span><span /></div>}
          {details}
          {estimate && rate != null && (
            <div className="swap-quote">
              <div className="sq-row"><span>Est. rate</span><span className="mono">1 {from?.symbol} ≈ {amtFmt(rate)} {to?.symbol}</span></div>
              <div className="sq-row"><span>You’d receive</span><span className="mono">≈ {outHuman != null ? amtFmt(outHuman) : '—'} {to?.symbol}</span></div>
              <div className="sq-row"><span>Route</span><span className="mono">No pool found on the eight venues · price estimate only</span></div>
            </div>
          )}
          {qErr && <div className="swap-info err"><span>{qErr}</span><span /></div>}

          {!wallet
            ? <button className="btn solid swap-cta" onClick={onConnect}>Connect Wallet</button>
            // 09-29: more than the wallet holds → say so (the button used to stay live and the tx would just revert)
            : (notEnough && !busy)
              ? <button className="btn solid swap-cta" disabled>Not enough {from?.symbol}</button>
            : (atq != null)
              ? <button className="btn solid swap-cta" onClick={executeArctide} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : `Swap ${from?.symbol} to ${to?.symbol}`}
                </button>
            : (clq != null)
              ? <button className="btn solid swap-cta" onClick={executeCL} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : `Swap ${from?.symbol} to ${to?.symbol}`}
                </button>
            : (v3q != null)
              ? <button className="btn solid swap-cta" onClick={executeV3} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : `Swap ${from?.symbol} to ${to?.symbol}`}
                </button>
            : (v4q != null)
              ? <button className="btn solid swap-cta" onClick={executeV4} disabled={busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : `Swap ${from?.symbol} to ${to?.symbol}`}
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
              // ⛔ 10-05 owner: never hand a trader to another site (was a 'Trade on Warp' link). Every venue was quoted and none
              // answered — usually a dropped RPC read, so offer a re-quote; a token with no pool at all says so.
              ? (!quoting && to && amt && from
                  ? <button className="btn solid swap-cta" onClick={() => setRefreshTick((t) => t + 1)}>{(universe.find((t) => t.address.toLowerCase() === (warpTokenAddr || '').toLowerCase())?.liq ?? 0) > 0 ? 'No route found · Retry' : 'No liquidity pool yet · Retry'}</button>
                  : <button className="btn solid swap-cta" disabled>{quoting ? 'Finding route…' : !to ? 'Select a token' : 'Enter an amount'}</button>)
              : <button className="btn solid swap-cta" onClick={execute} disabled={!quote || busy}>
                  {phase === 'approving' ? 'Approving…' : phase === 'swapping' ? 'Swapping…' : quote ? `Swap ${from?.symbol} to ${to?.symbol}` : to ? 'Enter an amount' : 'Select a token'}
                </button>}

          {msg && (
            <div className={`swap-status ${phase}`}>
              {msg}
              {hash && <> · <a href={`${(warpMode ? activeScan() : CHAIN.scan)}/tx/${hash}`} target="_blank" rel="noreferrer">View tx <IconExternal className="i" /></a></>}
            </div>
          )}
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
                      <span className="sp-h-id"><span className="sp-h-sym">{/^(USDC|EURC|USDT)$/i.test(h.symbol) && h.address.toLowerCase() !== usdcK && !byAddrEco(h.address) ? h.name : h.symbol}</span><span className="sp-h-amt">{compact(h.amount)}</span></span>
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
                  {acts.slice(0, 6).map((t) => {
                    const m = t.method.toLowerCase();
                    const kind = m === 'buy' ? 'buy' : m === 'sell' ? 'sell' : (m === 'execute' || m.startsWith('swap') || m === 'exactinputsingle') ? 'swap' : m === 'approve' ? 'approve' : m === 'transfer' ? 'transfer' : 'other';
                    const label = kind === 'buy' ? 'Buy' : kind === 'sell' ? 'Sell' : kind === 'swap' ? 'Swap' : kind === 'approve' ? 'Approve' : kind === 'transfer' ? 'Transfer' : t.method;
                    // The USDC value is only meaningful on a curve buy/sell (native USDC leg); hide it elsewhere.
                    const showVal = (kind === 'buy' || kind === 'sell') && t.value != null && t.value > 0;
                    return (
                    <a className="sp-act" key={t.hash} href={`https://explorer.arc.io/tx/${t.hash}`} target="_blank" rel="noreferrer">
                      <span className={`sp-a-m k-${t.status ? kind : 'fail'}`}>{label}</span>
                      <span className="sp-a-v">{showVal ? `${compact(t.value!)} USDC` : ''}</span>
                      <span className="sp-a-t">{timeAgo(t.ts)}</span>
                    </a>
                  ); })}
                </div>}
          </div>

          {/* Compact how-it-works — small, no longer competing with the swap */}
          <details className="sp-how">
            <summary>How routing works</summary>
            <p className="side-note">{warpMode
              ? <>Statera is a swap aggregator: every trade is quoted on all eight Arc venues at once and the best fill wins.
                <ol className="sp-venues">
                  <li>Uniswap V2</li>
                  <li>Uniswap V3</li>
                  <li>Uniswap V4, including hooked pools (Permit2 + Universal Router)</li>
                  <li>Warp V2</li>
                  <li>Warp bonding curve (tokens that have not graduated yet)</li>
                  <li>Aerodrome</li>
                  <li>Archery</li>
                  <li>Arctide</li>
                </ol>
                Each swap is simulated before you sign, and min received is enforced on-chain at your slippage. Only tokens listed on the Statera screener can be traded here (or ones you already hold). Native USDC (0x3600) is Arc's gas token.</>
              : <>Quoted against every live router on {CHAIN.name} ({SWAP_CFG.routers.length} tracked) for the deepest fill. Native USDC (0x3600) is Arc's gas token. Paste any ERC-20 to import it. Min received enforced on-chain at your slippage.</>}</p>
          </details>
        </aside>
      </div>
    </section></div>
  );
}
