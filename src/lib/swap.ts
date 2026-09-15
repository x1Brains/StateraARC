// ── Arc on-chain swap engine ─────────────────────────────────────────────────
// A best-quote aggregator, EVM-native. Given tokenIn → tokenOut it asks every known
// Arc router for getAmountsOut across candidate paths (direct + via USDC/EURC), picks the
// best fill, and builds execution with slippage-protected min-out + a deadline.
//
// Arc quirk (verified on-chain): native USDC lives at 0x3600… and is BOTH the gas token
// AND an ERC-20 precompile. As an ERC-20 it has 6 decimals and DEX pairs hold it directly —
// so every swap (including USDC-in) is a plain ERC-20 swap: approve tokenIn → then
// swapExactTokensForTokens. The payable swapExactETHForTokens path is compliance-gated
// ("Blocked address"), so we never use it.
//
// Router config is discovered from the live testnet: 0x8563… is the dominant DEX (250 pairs,
// base = native USDC). The aggregator queries all configured routers and takes the best fill,
// so no single router is a point of failure. Mainnet (Sept 16) populates the mainnet set.
//
// Proven end-to-end 2026-09-14: approve 0x2911…, swap 0x3857… (0.02 USDC → 103.66 NRLIF,
// received == quoted). See swap-proof in the repo notes.
import { NET, RPCS, CHAIN, req } from './arc';

export const NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const USDC = NATIVE_USDC.toLowerCase();
const WUSDC = '0x911b4000d3422f482f4062a913885f7b035382df'; // wrapped USDC (18-dec, deposit/withdraw)
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';
const ZERO = '0x0000000000000000000000000000000000000000';   // wrap-hop sentinel in a pair route

// Known decimals (native USDC & EURC are 6-dec as ERC-20s on Arc). Others read from chain.
const KNOWN_DEC: Record<string, number> = { [USDC]: 6, [EURC]: 6 };

const CFG: Record<string, { bases: string[]; routers: { addr: string; name: string }[] }> = {
  testnet: {
    // Intermediary hop tokens. Native USDC is the primary base (routers pair against it directly).
    bases: [USDC, EURC],
    // UniswapV2Router02 deployments verified LIVE on Arc testnet, ordered by pair count.
    // The aggregator queries all and takes the best fill.
    routers: [
      { addr: '0x8563912331dFFf503F3Ac261c470fed3C2E986a0', name: 'ArcSwap' },   // 250 pairs — dominant
      { addr: '0x9BDf0dd28c3043c43Ec84d0622ECEBe9BfFd965D', name: 'ArcSwap·II' }, // 6 pairs
      { addr: '0x109807a921d66c6D4FFcd6D3657b5E5667a9c32c', name: 'ArcSwap·III' },// 3 pairs
    ],
  },
  // Mainnet routers unknown until launch — reported as "no route" rather than guessing.
  // Arc mainnet (5042, live). WarpV2 = Warp's own UniV2-style DEX (WARP + graduated tokens).
  // ⛔ Uniswap-v4 tokens (ARGUS/CRCL/etc.) need a separate v4 router — not covered by this aggregator yet.
  mainnet: { bases: [USDC], routers: [{ addr: '0xd24227d7cf4b1ad9fba6ea6ae28392690ece47ae', name: 'WarpV2' }] },
};

export const SWAP_CFG = CFG[NET] || CFG.testnet;
export const swapReady = () => SWAP_CFG.routers.length > 0 || !!UNI_ROUTER;

// ── Universal pair router (DEX-agnostic) ─────────────────────────────────────
// Stock UniV2 routers only see pools from THEIR OWN factory, so a token whose only
// liquidity is on a custom AMM (e.g. Axpha) reads as "no route". Our on-chain
// UniversalPairRouter takes the EXACT pair address for a route, so it swaps through ANY
// UniV2-style pool regardless of factory — plus an auto WUSDC wrap hop so native USDC
// pays into WUSDC-quoted pools. Proven on-chain 2026-09-15: 0.02 USDC → 176.86 BILL via
// Axpha AMM (tx 0x3a0a0a14…), which getAmountsOut can't see. Deployed per net below.
// V2 adds swapWithPermit() — EIP-2612 gasless-approval swaps (see permit helpers below).
const UNI_ROUTER_BY_NET: Record<string, string> = {
  testnet: '0xc680832437E23cdfce9A4D5B1193d77DA12Ae7eC',
  mainnet: '', // deploy on launch day, then paste the address here
};
export const UNI_ROUTER = UNI_ROUTER_BY_NET[NET] || '';

// ── Mainnet execution override (Warp tokens) ─────────────────────────────────
// Arc mainnet 5042 is LIVE (rpc.mainnet.arc.io serves 0x13b2), but the app's global NET stays
// 'testnet' so the Blockscout-backed screener keeps working (the mainnet explorer API isn't
// Blockscout-compatible yet). When the user trades a Warp/mainnet token, Swap.tsx flips this ON so
// quotes/reads/simulations/txs target mainnet (rpc.mainnet.arc.io + WarpV2 router + chain 5042)
// WITHOUT a global flip. Safe because ONLY Swap.tsx imports this module — no other reads are affected.
const MAINNET_RPC = (import.meta.env.VITE_ARC_MAINNET_RPC as string) || 'https://rpc.mainnet.arc.io';
export const MAINNET_CHAIN_ID = 5042;
export const MAINNET_SCAN = 'https://arc-scan.org';
let ACTIVE_MAINNET = false;
export function setSwapMainnet(on: boolean) { ACTIVE_MAINNET = on; }
export const swapMainnetActive = () => ACTIVE_MAINNET;
export const activeChainId = () => (ACTIVE_MAINNET ? MAINNET_CHAIN_ID : CHAIN.chainId);
export const activeScan = () => (ACTIVE_MAINNET ? MAINNET_SCAN : CHAIN.scan);
const activeCfg = () => (ACTIVE_MAINNET ? CFG.mainnet : (CFG[NET] || CFG.testnet));

// Bases the pair adapter recognizes as the "quote" side of a pool.
const PAIR_BASES = [USDC, WUSDC, EURC];
// Pool swap fee (bps) keyed by the pool's factory; UniV2 standard is 30 (0.3%).
const FACTORY_FEE: Record<string, number> = {
  '0x63830a168bba4bdfc7b83e17b462d1ae86f9ce0a': 50, // Axpha AMM (verified on-chain)
};
// Fee ladder for execution-time auto-correction when a pool's real fee is unknown.
export const feeCandidates = (base?: number): number[] => {
  const b = base ?? 30;
  return [b, 30, 50, 100, 25, 60, 15].filter((v, i, a) => v >= b && a.indexOf(v) === i);
};

// ── low-level rpc (same failover list as arc.ts) ──
async function rpc(method: string, params: any[]): Promise<any> {
  for (const url of (ACTIVE_MAINNET ? [MAINNET_RPC] : RPCS)) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      return j.error ? { error: j.error } : j;
    } catch { /* next endpoint */ }
  }
  return { error: { message: 'all RPCs unreachable' } };
}
const ethCall = async (to: string, data: string): Promise<string | null> => {
  const j = await rpc('eth_call', [{ to, data }, 'latest']);
  return j && j.result && j.result !== '0x' ? j.result : null;
};

// ── ABI encode helpers (no ethers dep) ──
const padA = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const padU = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const encArr = (addrs: string[]) => padU(addrs.length) + addrs.map(padA).join('');
// browser-safe hex → utf8 (no Buffer)
const hexToStr = (hex: string): string => {
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) { const c = parseInt(hex.substr(i, 2), 16); if (c) s += String.fromCharCode(c); }
  return s;
};

// ── ERC-20 metadata (cached) ──
const decCache = new Map<string, number>();
export async function decimalsOf(token: string): Promise<number> {
  const k = token.toLowerCase();
  if (k in KNOWN_DEC) return KNOWN_DEC[k];
  if (decCache.has(k)) return decCache.get(k)!;
  const r = await ethCall(token, '0x313ce567');
  const d = r ? Number(BigInt(r)) : 18;
  decCache.set(k, d);
  return d;
}
export async function symbolOf(token: string): Promise<string | null> {
  if (token.toLowerCase() === USDC) return 'USDC';
  const r = await ethCall(token, '0x95d89b41');
  if (!r || r === '0x') return null;
  try {
    const len = Number(BigInt('0x' + r.slice(66, 130)));
    return hexToStr(r.slice(130, 130 + len * 2)) || null;
  } catch { return null; }
}
export async function balanceOf(token: string, owner: string): Promise<bigint> {
  const r = await ethCall(token, '0x70a08231' + padA(owner)); // works for 0x3600 too (ERC-20 precompile)
  return r ? BigInt(r) : 0n;
}
export async function allowance(token: string, owner: string, spender: string): Promise<bigint> {
  const r = await ethCall(token, '0xdd62ed3e' + padA(owner) + padA(spender));
  return r ? BigInt(r) : 0n;
}

// candidate paths: direct, then via each base token (USDC / EURC)
function candidatePaths(tin: string, tout: string): string[][] {
  const a = tin.toLowerCase(), b = tout.toLowerCase();
  const paths: string[][] = [[tin, tout]];
  for (const base of activeCfg().bases) {
    const bl = base.toLowerCase();
    if (bl !== a && bl !== b) paths.push([tin, base, tout]);
  }
  return paths;
}

export interface Quote {
  kind: 'univ2' | 'pair';           // which engine builds/executes this fill
  router: string;                   // spender to approve + tx target (a UniV2 router, or our pair router)
  routerName: string; path: string[];
  amountInRaw: bigint; amountOutRaw: bigint; hops: number;
  pairs?: string[]; feeBps?: number; // pair-adapter route only (address(0) = a WUSDC wrap hop)
}

// getAmountsOut(uint256, address[]) = 0xd06ca61f ; decode the LAST array element (final output)
async function getAmountsOut(router: string, amountIn: bigint, path: string[]): Promise<bigint | null> {
  const data = '0xd06ca61f' + padU(amountIn) + padU(64) + encArr(path);
  const r = await ethCall(router, data);
  if (!r || r.length < 194) return null;
  try {
    const len = Number(BigInt('0x' + r.slice(66, 130)));
    if (!len) return null;
    const last = r.slice(2 + 64 + 64 + (len - 1) * 64, 2 + 64 + 64 + len * 64);
    const out = BigInt('0x' + last);
    return out > 0n ? out : null;
  } catch { return null; }
}

// Ask every UniV2 router × every candidate path; return the single best fill.
async function univ2BestQuote(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<Quote | null> {
  const cfg = activeCfg();
  if (!cfg.routers.length) return null;
  const paths = candidatePaths(tokenIn, tokenOut);
  const jobs: Promise<Quote | null>[] = [];
  for (const r of cfg.routers)
    for (const path of paths)
      jobs.push(
        getAmountsOut(r.addr, amountInRaw, path).then((out) =>
          out ? { kind: 'univ2', router: r.addr, routerName: r.name, path, amountInRaw, amountOutRaw: out, hops: path.length - 1 } : null,
        ),
      );
  const results = (await Promise.all(jobs)).filter(Boolean) as Quote[];
  if (!results.length) return null;
  return results.reduce((a, b) => (b.amountOutRaw > a.amountOutRaw ? b : a));
}

// ── pair-adapter: discover a token's pool on ANY factory, route through UniversalPairRouter ──
const readAddr = async (to: string, sel: string): Promise<string | null> => {
  const r = await ethCall(to, sel);
  if (!r || r.length < 66) return null;
  const a = '0x' + r.slice(-40);
  return a === '0x0000000000000000000000000000000000000000' ? null : a.toLowerCase();
};
// token0()=0x0dfe1681 token1()=0xd21220a7 factory()=0xc45a0155
const pairCache = new Map<string, { pair: string; base: string; feeBps: number } | null>();
async function findPair(token: string): Promise<{ pair: string; base: string; feeBps: number } | null> {
  const key = token.toLowerCase();
  if (PAIR_BASES.includes(key)) return null; // a base isn't the "token" side of a pool
  if (pairCache.has(key)) return pairCache.get(key)!;
  let found: { pair: string; base: string; feeBps: number } | null = null;
  try {
    // A token's liquidity pool is one of its largest holders (it custodies the reserves).
    const j = await req(`${CHAIN.api}/tokens/${token}/holders`);
    const holders = (j.items || [])
      .slice(0, 12)
      .map((h: any) => (h.address?.hash || h.address?.address_hash || h.address || '').toString().toLowerCase())
      .filter(Boolean);
    for (const h of holders) {
      const t0 = await readAddr(h, '0x0dfe1681'); // token0()
      if (!t0) continue;                            // not a UniV2-style pair
      const t1 = await readAddr(h, '0xd21220a7'); // token1()
      if (!t1) continue;
      const pair = [t0, t1];
      if (!pair.includes(key)) continue;            // pool must hold our token
      const base = PAIR_BASES.find((b) => pair.includes(b) && b !== key);
      if (!base) continue;                          // …paired with a base we can price/route
      const fac = await readAddr(h, '0xc45a0155');  // factory() → per-DEX fee
      found = { pair: h, base, feeBps: (fac && FACTORY_FEE[fac]) || 30 };
      break;
    }
  } catch { /* discovery failed — fall through to null */ }
  pairCache.set(key, found);
  return found;
}
// A hop segment from one base to another (identity, or a 1:1 WUSDC wrap/unwrap).
function bridge(from: string, to: string): { pairs: string[]; path: string[] } | null {
  if (from === to) return { pairs: [], path: [from] };
  if ((from === USDC && to === WUSDC) || (from === WUSDC && to === USDC)) return { pairs: [ZERO], path: [from, to] };
  return null; // USDC↔EURC etc. would need a base/base pool — left to the UniV2 aggregator
}
// Build (pairs[], path[], feeBps) for tokenIn→tokenOut, or null if no pair route exists.
async function buildPairRoute(tokenIn: string, tokenOut: string): Promise<{ pairs: string[]; path: string[]; feeBps: number } | null> {
  const a = tokenIn.toLowerCase(), b = tokenOut.toLowerCase();
  const aBase = PAIR_BASES.includes(a), bBase = PAIR_BASES.includes(b);
  if (aBase && bBase) return null; // base→base is a wrap, not a trade
  if (aBase && !bBase) {           // BUY: base → token
    const info = await findPair(b); if (!info) return null;
    const br = bridge(a, info.base); if (!br) return null;
    return { pairs: [...br.pairs, info.pair], path: [...br.path, b], feeBps: info.feeBps };
  }
  if (!aBase && bBase) {           // SELL: token → base
    const info = await findPair(a); if (!info) return null;
    const br = bridge(info.base, b); if (!br) return null;
    return { pairs: [info.pair, ...br.pairs], path: [a, ...br.path], feeBps: info.feeBps };
  }
  // token → token: only when both pools share a base and the same fee (router uses one feeBps)
  const [ia, ib] = await Promise.all([findPair(a), findPair(b)]);
  if (!ia || !ib || ia.base !== ib.base || ia.feeBps !== ib.feeBps) return null;
  return { pairs: [ia.pair, ib.pair], path: [a, ia.base, b], feeBps: ia.feeBps };
}
// quote(address[],address[],uint256,uint256) = 0x69fb7b4c — reads live reserves, view-safe.
async function pairRouterQuote(pairs: string[], path: string[], amountIn: bigint, feeBps: number): Promise<bigint | null> {
  const off1 = 128;                                  // 4 head slots × 32
  const off2 = off1 + (1 + pairs.length) * 32;
  const data = '0x69fb7b4c' + padU(off1) + padU(off2) + padU(amountIn) + padU(feeBps) + encArr(pairs) + encArr(path);
  const r = await ethCall(UNI_ROUTER, data);
  if (!r) return null;
  try { const out = BigInt(r); return out > 0n ? out : null; } catch { return null; }
}
async function pairBestQuote(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<Quote | null> {
  // Pair discovery reads the testnet Blockscout API (CHAIN.api). It can't see mainnet pools, so in
  // mainnet mode we rely solely on the WarpV2 UniV2 engine above.
  if (ACTIVE_MAINNET || !UNI_ROUTER) return null;
  const route = await buildPairRoute(tokenIn, tokenOut);
  if (!route) return null;
  const out = await pairRouterQuote(route.pairs, route.path, amountInRaw, route.feeBps);
  if (!out) return null;
  const hops = route.pairs.filter((p) => p !== ZERO).length;
  return { kind: 'pair', router: UNI_ROUTER, routerName: 'Statera Router', path: route.path,
    amountInRaw, amountOutRaw: out, hops, pairs: route.pairs, feeBps: route.feeBps };
}

// Best fill across BOTH engines (stock UniV2 routers + our universal pair router).
export async function bestQuote(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<Quote | null> {
  if (amountInRaw <= 0n) return null;
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
  const [uni, pair] = await Promise.all([
    univ2BestQuote(tokenIn, tokenOut, amountInRaw),
    pairBestQuote(tokenIn, tokenOut, amountInRaw),
  ]);
  const cands = [uni, pair].filter(Boolean) as Quote[];
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.amountOutRaw > a.amountOutRaw ? b : a));
}

// slippage in % → amountOutMin (integer floor)
export const minOut = (out: bigint, slippagePct: number): bigint =>
  (out * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;

export interface TxReq { to: string; from: string; data: string; value: string }

// Max uint256 — a one-time "unlimited" approval so a token is approved ONCE per spender,
// not per trade (mirrors the SVM feel). Our pair router is immutable + ownerless + holds no
// funds, so an unlimited allowance to it can only ever be used mid-swap, and is revocable.
export const MAX_UINT256 = (1n << 256n) - 1n;

// approve(spender, amount) = 0x095ea7b3
export function buildApproveTx(token: string, spender: string, amountRaw: bigint, from: string): TxReq {
  return { to: token, from, value: '0x0', data: '0x095ea7b3' + padA(spender) + padU(amountRaw) };
}

// ── EIP-2612 permit (gasless approval) ───────────────────────────────────────
// A token that implements permit (Arc native USDC & EURC do — verified on-chain, domain
// name/version read from the token) can be authorized by a SIGNATURE instead of an approval
// tx. Combined with the pair router's swapWithPermit(), that's one signature + one tx, no
// standing allowance — the closest EVM gets to the SVM (no-approval) feel.
async function readString(token: string, sel: string): Promise<string | null> {
  const r = await ethCall(token, sel);
  if (!r || r === '0x' || r.length < 130) return null;
  try {
    const len = Number(BigInt('0x' + r.slice(66, 130)));
    if (!len) return null;
    return hexToStr(r.slice(130, 130 + len * 2)) || null;
  } catch { return null; }
}
export interface PermitInfo { name: string; version: string; nonce: bigint; chainId: number; token: string; }
// Returns the EIP-712 permit parameters for a token, or null if it doesn't support permit.
// We require name() AND version() getters so the domain is deterministic (no local keccak
// needed to match DOMAIN_SEPARATOR) — the wallet computes the digest from the typed data.
export async function permitInfo(token: string, owner: string): Promise<PermitInfo | null> {
  const [name, version, nonceHex, ds] = await Promise.all([
    readString(token, '0x06fdde03'),                 // name()
    readString(token, '0x54fd4d50'),                 // version()
    ethCall(token, '0x7ecebe00' + padA(owner)),      // nonces(owner)
    ethCall(token, '0x3644e515'),                    // DOMAIN_SEPARATOR() — presence = EIP-2612
  ]);
  if (!name || !version || !nonceHex || !ds) return null;
  return { name, version, nonce: BigInt(nonceHex), chainId: activeChainId(), token };
}
// Build the eth_signTypedData_v4 payload for an EIP-2612 permit (exact value, given deadline).
export function buildPermitTypedData(info: PermitInfo, owner: string, spender: string, value: bigint, deadline: bigint) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: { name: info.name, version: info.version, chainId: info.chainId, verifyingContract: info.token },
    message: { owner, spender, value: value.toString(), nonce: info.nonce.toString(), deadline: deadline.toString() },
  };
}
// Split a 65-byte signature into { v, r, s }.
function splitSig(sig: string): { v: number; r: string; s: string } {
  const h = sig.replace('0x', '');
  const r = h.slice(0, 64), s = h.slice(64, 128);
  let v = parseInt(h.slice(128, 130), 16);
  if (v < 27) v += 27; // some wallets return 0/1
  return { v, r, s };
}
// swapWithPermit(address[],address[],uint256,uint256,address,uint256,uint256,uint8,bytes32,bytes32) = 0x00b88335
// The permit was signed for exactly amountIn with THIS deadline (contract enforces both equal).
export function buildSwapWithPermitTx(
  q: Quote,
  opts: { amountOutMinRaw: bigint; recipient: string; deadline: bigint; feeBpsOverride?: number; sig: string },
): TxReq {
  const pairs = q.pairs || [];
  const feeBps = opts.feeBpsOverride ?? q.feeBps ?? 30;
  const { v, r, s } = splitSig(opts.sig);
  const off1 = 320;                                  // 10 head slots × 32
  const off2 = off1 + (1 + pairs.length) * 32;
  const data =
    '0x00b88335' + padU(off1) + padU(off2) + padU(q.amountInRaw) + padU(opts.amountOutMinRaw) +
    padA(opts.recipient) + padU(opts.deadline) + padU(feeBps) + padU(v) + r + s + encArr(pairs) + encArr(q.path);
  return { to: q.router, from: opts.recipient, data, value: '0x0' };
}

// Build the execution tx for a quote. UniV2 quotes use swapExactTokensForTokens on the router;
// pair quotes use swap(pairs,path,…) on our universal router (feeBpsOverride lets execution
// auto-correct an unknown pool fee — see feeCandidates).
export function buildSwapTx(
  q: Quote,
  opts: { amountOutMinRaw: bigint; recipient: string; deadlineSec?: number; feeBpsOverride?: number },
): TxReq {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSec ?? 600));
  if (q.kind === 'pair') {
    // swap(address[],address[],uint256,uint256,address,uint256,uint256) = 0x398a5c95
    const pairs = q.pairs || [];
    const feeBps = opts.feeBpsOverride ?? q.feeBps ?? 30;
    const off1 = 224;                                 // 7 head slots × 32
    const off2 = off1 + (1 + pairs.length) * 32;
    const data =
      '0x398a5c95' + padU(off1) + padU(off2) + padU(q.amountInRaw) + padU(opts.amountOutMinRaw) +
      padA(opts.recipient) + padU(deadline) + padU(feeBps) + encArr(pairs) + encArr(q.path);
    return { to: q.router, from: opts.recipient, data, value: '0x0' };
  }
  // swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline) = 0x38ed1739
  const data =
    '0x38ed1739' + padU(q.amountInRaw) + padU(opts.amountOutMinRaw) + padU(160) +
    padA(opts.recipient) + padU(deadline) + encArr(q.path);
  return { to: q.router, from: opts.recipient, data, value: '0x0' };
}

// Dry-run a built tx via eth_call to catch reverts (bad route, no liquidity, needs approval)
// BEFORE the user signs. Returns null on success, or a decoded revert reason.
export async function simulate(tx: TxReq): Promise<string | null> {
  const j = await rpc('eth_call', [{ to: tx.to, from: tx.from, data: tx.data, value: tx.value }, 'latest']);
  if (!j.error) return null;
  const d: string | undefined = j.error.data;
  if (typeof d === 'string' && d.startsWith('0x08c379a0')) {
    try {
      const len = Number(BigInt('0x' + d.slice(10 + 64, 10 + 128)));
      const reason = hexToStr(d.slice(10 + 128, 10 + 128 + len * 2));
      if (reason) return reason;
    } catch { /* fall through */ }
  }
  return j.error.message || 'reverted';
}

// human ↔ raw
export const toRaw = (human: number, decimals: number): bigint => {
  if (!isFinite(human) || human <= 0) return 0n;
  const [i, f = ''] = human.toString().split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((i || '0') + frac);
};
export const fromRaw = (raw: bigint, decimals: number): number => {
  const s = raw.toString().padStart(decimals + 1, '0');
  return Number(s.slice(0, -decimals) + '.' + s.slice(-decimals));
};
