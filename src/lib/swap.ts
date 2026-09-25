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
import { NET, RPCS, CHAIN, req, findV4Pool } from './arc';
import { keccak_256 } from '@noble/hashes/sha3';

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
// ⛔ Mainnet used to be ONE node, ONE try: a rate-limited read (the public Arc RPCs refuse bursts past ~30 calls, and
// a page load fires more) came back as an error and the wallet's balance showed "0 USDC" while it held 3.41 (09-25).
// Now: rotate across three receipt-reliable nodes with backoff. A revert (execution error with data) is a real
// answer and is returned at once — only transport/rate-limit failures move on to the next node.
const MAINNET_RPCS = [MAINNET_RPC, 'https://arc.drpc.org', 'https://arc.gateway.tenderly.co'].filter((v, i, a) => a.indexOf(v) === i);
const isRevert = (e: any) => e && (e.data != null || /revert|execution/i.test(e.message || ''));
async function rpc(method: string, params: any[]): Promise<any> {
  const urls = ACTIVE_MAINNET || NET === 'mainnet' ? MAINNET_RPCS : RPCS;
  let last: any = { error: { message: 'all RPCs unreachable' } };
  for (let i = 0; i < urls.length * 2; i++) {
    const url = urls[i % urls.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000),
      });
      if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 200 * (i + 1))); continue; }
      const j = await r.json();
      if (!j.error) return j;
      last = { error: j.error };
      if (isRevert(j.error)) return last;
    } catch { /* next endpoint */ }
    await new Promise((res) => setTimeout(res, 150 * (i + 1)));
  }
  return last;
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
// Throws when the chain can't be read — a failed read must never pass for a zero balance.
export async function balanceOf(token: string, owner: string): Promise<bigint> {
  const r = await ethCall(token, '0x70a08231' + padA(owner)); // works for 0x3600 too (ERC-20 precompile)
  if (r == null) throw new Error('Could not read your balance from Arc — try again.');
  return BigInt(r);
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

// ── Warp bonding-curve trading (in-app, chain 5042) ──────────────────────────
// Warp curve tokens (pre-graduation) trade by calling the token's curve contract directly:
//   buy(uint256 minOut) payable — send native USDC as `value`, receive tokens. No approval.
// Verified on-chain 2026-09-16 (BLOB curve 0x96f8aa55…: 25 USDC → 6,363 BLOB). eth_call of buy(0)
// with the USDC value returns the EXACT tokens out at the current curve state — our live quote.
const CURVE_BUY_SEL = '0xd96a094a'; // buy(uint256 minOut)
const usdcToNativeHex = (usdcHuman: number): string =>
  '0x' + (BigInt(Math.round(usdcHuman * 1e6)) * (10n ** 12n)).toString(16); // USDC (6d) → native 18d wei

// Live buy quote: exact tokens out for `usdcHuman` USDC into the curve, or null.
export async function quoteCurveBuy(curve: string, usdcHuman: number, from: string): Promise<bigint | null> {
  if (usdcHuman <= 0) return null;
  const j = await rpc('eth_call', [{ from, to: curve, data: CURVE_BUY_SEL + padU(0n), value: usdcToNativeHex(usdcHuman) }, 'latest']);
  if (!j || j.error || !j.result || j.result === '0x') return null;
  try { const out = BigInt(j.result.slice(0, 66)); return out > 0n ? out : null; } catch { return null; }
}
// Buy `usdcHuman` USDC worth of the curve token, enforcing minOutRaw. Native-USDC value tx, no approval.
export function buildCurveBuyTx(curve: string, usdcHuman: number, minOutRaw: bigint, from: string): TxReq {
  return { to: curve, from, value: usdcToNativeHex(usdcHuman), data: CURVE_BUY_SEL + padU(minOutRaw) };
}
// Curve SELL: sell(uint256 amount, uint256 minUsdcOut) = 0xd79875eb. Approve token → curve, then sell.
// eth_call of sell(amount, 0) returns USDC out in 18-dec NATIVE — we convert to 6-dec for the UI.
// Verified on-chain 2026-09-16 (round-trip on BLOB curve). minUsdcOut on-chain is also 18-dec native.
const CURVE_SELL_SEL = '0xd79875eb';
export async function quoteCurveSell(curve: string, amountRaw: bigint, from: string): Promise<bigint | null> {
  if (amountRaw <= 0n) return null;
  const j = await rpc('eth_call', [{ from, to: curve, data: CURVE_SELL_SEL + padU(amountRaw) + padU(0n) }, 'latest']);
  if (!j || j.error || !j.result || j.result === '0x') return null;
  try { const native18 = BigInt(j.result.slice(0, 66)); return native18 > 0n ? native18 / (10n ** 12n) : null; } catch { return null; } // → 6-dec USDC
}
export function buildCurveSellTx(curve: string, amountRaw: bigint, minUsdc6: bigint, from: string): TxReq {
  return { to: curve, from, value: '0x0', data: CURVE_SELL_SEL + padU(amountRaw) + padU(minUsdc6 * (10n ** 12n)) };
}

// ── Uniswap V3 (Argus factory) trading (in-app, chain 5042) ──────────────────
// The deepest-liquidity Arc tokens (ARGUS/CRCL/LONG/TOLLY/Architects…) trade on Uniswap V3 pools
// (Argus factory 0xf0db7b58…). Verified on-chain 2026-09-16: SwapRouter02 0x53bf6b06… factory matches.
//   exactInputSingle((tokenIn,tokenOut,fee,recipient,amountIn,amountOutMin,sqrtPriceLimitX96)) = 0x04e45aaf
// Quote from the pool's slot0 spot price (exact for small trades; large trades protected by min-out).
export const V3_ROUTER = '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77';
const V3_POOL: Record<string, string> = {
  '0xece5ca8bf9220718e5727754026757512212cb3c': '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02', // ARGUS
  '0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b': '0x2e8180fa3967caf9abf57bbaeab9ae9063bcd7ba', // CRCL
  '0x2164bb17a2d38c1b5170e987b2c0416df1efc752': '0xda9f3d166497ddfddf37c93cacfd8aa39b71e493', // LONG
  '0xbc43ce8dec648ea298c4275559b81d6261c90b67': '0x162df51c504e7b8321e07387932f333d9be16a72', // TOLLY
  '0xf3715bf5c2de299f08b81180ffb739a8372a175f': '0x6d8db35396b5eb98dee495e32b8cca992682316d', // ARCANINE
  '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0': '0x0069cb6f70e2f848405f4483f232274c720ce6f9', // Architects
  '0x12ce1f970722ca6e08364b60099b3d25c09b5434': '0x4052ee5accb46785be42910a3fe965a1855b8313', // ARCX10
  '0x07704b06981ea962b87296362a1281484d160000': '0xcf924acee7eb1f169a922bf19b0a732810971985', // ARCAT
  '0xeb64987643db71c76b2a2be7e723decc995e5b37': '0x40732e01ba7a829dea44f51a10e7c58cd9f37765', // COOL
  '0x0bffa97f774824e9da843699aedd2835cb1b8022': '0x7dbcec05f12b14e21a79a0dc15ea9859322a4ab2', // ARCASH
  '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97': '0x482a249eb473b7de0ca8357b5496ccb7c55dfb72', // ARCBAT
};
const Q192 = 2n ** 192n;
const v3Meta = new Map<string, { token0: string; fee: number }>();
async function v3PoolMeta(pool: string): Promise<{ token0: string; fee: number } | null> {
  if (v3Meta.has(pool)) return v3Meta.get(pool)!;
  const [t0, feeHex] = await Promise.all([ethCall(pool, '0x0dfe1681'), ethCall(pool, '0xddca3f43')]); // token0(), fee()
  if (!t0 || !feeHex) return null;
  const m = { token0: ('0x' + t0.slice(-40)).toLowerCase(), fee: Number(BigInt(feeHex)) };
  v3Meta.set(pool, m); return m;
}
export const v3PoolFor = (token: string): string | undefined => V3_POOL[token.toLowerCase()];
// ANY token's Uniswap V3 USDC pool on the Arc factory (the one SwapRouter02 is bound to): getPool for every fee tier,
// deepest by USDC held. Before 09-25 only the 11 pools above could trade in-app. The $500 guard in quoteV3 still
// keeps a thin pool from giving a ruinous fill.
const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
const v3Found = new Map<string, string | null>();
export async function findV3Pool(token: string): Promise<string | null> {
  const t = token.toLowerCase();
  if (V3_POOL[t]) return V3_POOL[t];
  if (v3Found.has(t)) return v3Found.get(t)!;
  const pools = (await Promise.all([100, 500, 3000, 10000].map((fee) =>
    ethCall(V3_FACTORY, '0x1698ee82' + padA(t) + padA(USDC) + padU(fee)).then((r) => (r && r.length >= 66 ? ('0x' + r.slice(-40)).toLowerCase() : null)))))
    .filter((p): p is string => !!p && p !== ZERO);
  let best: string | null = null, bestBal = 0n;
  for (const p of pools) {
    const b = await ethCall(USDC, '0x70a08231' + padA(p)); // USDC held (ERC-20 face == native balance, verified 09-25)
    const v = b ? BigInt(b) : 0n;
    if (v > bestBal) { bestBal = v; best = p; }
  }
  v3Found.set(t, best);
  return best;
}
// Exact-in output for a V3 swap that stays inside the current tick range, from sqrtPrice + in-range liquidity
// (standard V3 swap math). Verified 09-25 against 7,453 real swaps on ARGUS/TOLLY/COOL: max error 0.0002%,
// where the old spot-price quote over-promised by up to 1%. A trade that crosses a tick can still differ — the
// on-chain min-out + the pre-sign simulation cover that.
const Q96 = 1n << 96n;
function v3InRangeOut(sqrtP: bigint, L: bigint, amountIn: bigint, zeroForOne: boolean, fee: number): bigint {
  const inLessFee = (amountIn * BigInt(1_000_000 - fee)) / 1_000_000n;
  if (L <= 0n || inLessFee <= 0n) return 0n;
  if (zeroForOne) { const num = L * Q96; const sqrtN = (num * sqrtP) / (num + inLessFee * sqrtP); return (L * (sqrtP - sqrtN)) / Q96; }
  const sqrtN = sqrtP + (inLessFee * Q96) / L;
  return (L * Q96 * (sqrtN - sqrtP)) / (sqrtP * sqrtN);
}
// Quote USDC↔token on the V3 pool from slot0 spot price. Returns { outRaw, fee, pool } or null.
// A V3 pool must hold at least this much USDC to be routable — guards against near-empty pools
// (e.g. ARCX10's $16 V3 pair, whose real liquidity is a hooked Uniswap-v4 pool) giving a ruinous
// fill. Thin/absent pools return null here → the swap falls back to the Warp link, not a bad trade.
const V3_MIN_USDC = 500n * 10n ** 6n; // $500 (6-dec USDC face)
export async function quoteV3(tokenIn: string, tokenOut: string, amountInRaw: bigint, poolHint?: string | null): Promise<{ outRaw: bigint; fee: number; pool: string } | null> {
  const a = tokenIn.toLowerCase(), b = tokenOut.toLowerCase();
  const token = a === USDC ? b : (b === USDC ? a : null); // one side must be native USDC
  if (!token) return null;
  const pool = poolHint || (await findV3Pool(token)); if (!pool) return null;
  const [meta, slot0, usdcHex, liqHex] = await Promise.all([
    v3PoolMeta(pool), ethCall(pool, '0x3850c7bd'), // slot0()
    ethCall(USDC, '0x70a08231000000000000000000000000' + pool.slice(2)), // USDC balanceOf(pool)
    ethCall(pool, '0x1a686502'), // liquidity() — in-range liquidity at the current tick
  ]);
  if (!meta || !slot0 || slot0.length < 66) return null;
  // Liquidity guard: skip near-empty pools (their spot price is meaningless / fills are ruinous).
  try { if (!usdcHex || BigInt(usdcHex) < V3_MIN_USDC) return null; } catch { return null; }
  let sqrtP: bigint; try { sqrtP = BigInt('0x' + slot0.slice(2, 66)); } catch { return null; }
  if (sqrtP <= 0n) return null;
  let L = 0n; try { if (liqHex) L = BigInt(liqHex); } catch { /* */ }
  let outRaw: bigint;
  if (L > 0n) outRaw = v3InRangeOut(sqrtP, L, amountInRaw, a === meta.token0, meta.fee); // real in-range math (price impact included)
  else { // no liquidity() answer: spot × (1 − fee), the old approximation
    const p2 = sqrtP * sqrtP; // price(token1/token0, raw) = p2 / 2^192
    outRaw = a === meta.token0 ? (amountInRaw * p2) / Q192 : (amountInRaw * Q192) / p2;
    outRaw = (outRaw * BigInt(1_000_000 - meta.fee)) / 1_000_000n;
  }
  if (outRaw <= 0n) return null;
  return { outRaw, fee: meta.fee, pool };
}
export function buildV3SwapTx(tokenIn: string, tokenOut: string, fee: number, amountInRaw: bigint, amountOutMinRaw: bigint, recipient: string): TxReq {
  const data = '0x04e45aaf' + padA(tokenIn) + padA(tokenOut) + padU(fee) + padA(recipient) + padU(amountInRaw) + padU(amountOutMinRaw) + padU(0n);
  return { to: V3_ROUTER, from: recipient, data, value: '0x0' };
}

// ── Uniswap V4 (Universal Router + hooked pools) ─────────────────────────────
// For tokens whose real liquidity is a v4 pool (thin/no V3), e.g. ARCX10. Swaps go through the
// Universal Router: execute(0x10 V4_SWAP, [actions 0x06/0x0c/0x0f + params], deadline), funds pulled
// via Permit2. The hand-rolled calldata below was verified BYTE-IDENTICAL to a proven on-chain swap,
// and real ARCX10 buy+sell were executed to confirm (2026-09-16). Quote from the pool's slot0
// (extsload of a precomputed state slot — avoids in-browser keccak), consistent within ~3.6% of fills.
export const UNIVERSAL_ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951'; // v4 PoolManager singleton (extsload for pool state)
export interface V4Cfg { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; stateSlot: string; }
const V4_TOKENS: Record<string, V4Cfg> = {
  '0x12ce1f970722ca6e08364b60099b3d25c09b5434': { // ARCX10 / USDC (currency0 < currency1)
    currency0: '0x12ce1f970722ca6e08364b60099b3d25c09b5434', currency1: NATIVE_USDC, fee: 10000, tickSpacing: 200,
    hooks: '0x462b30e1d11455440eeec627bc5e30b84b18e044',
    stateSlot: '0x62ed14a4ecec4f041ce9a441e680bace03dfc8e823c5eb146ede512974e62d7e',
  },
  '0x08adbf431569a1aacac2606d2adcd18f4ebf2a71': { // GLITCH / USDC — potato.fm launch, hooked (2% tax/side)
    currency0: '0x08adbf431569a1aacac2606d2adcd18f4ebf2a71', currency1: NATIVE_USDC, fee: 10000, tickSpacing: 200,
    hooks: '0x19b58a4555760558763d62f16250bb1890182044',
    stateSlot: '0x2940c9ecef106eeeffb1c7e9a6627f238f5f91e21ba99732cbef89dda283e380',
  },
};
export const v4CfgFor = (token: string): V4Cfg | undefined => V4_TOKENS[token.toLowerCase()];
const hx = (u8: Uint8Array) => '0x' + Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => { h = h.replace(/^0x/, ''); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const padI = (n: number) => (n < 0 ? ((1n << 256n) + BigInt(n)) : BigInt(n)).toString(16).padStart(64, '0'); // int24 → two's complement word
/** poolId = keccak256(abi.encode(PoolKey)) — the check that a key really belongs to the pool we priced. */
export const v4PoolIdOf = (c: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }) =>
  hx(keccak_256(unhex(padA(c.currency0) + padA(c.currency1) + padU(c.fee) + padI(c.tickSpacing) + padA(c.hooks))));
const v4SlotOf = (poolId: string) => hx(keccak_256(unhex(poolId.replace(/^0x/, '').padStart(64, '0') + padU(6))));
const POSM = '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b'; // Uniswap V4 PositionManager on Arc
/**
 * The V4 route for ANY token with a USDC V4 pool — not just the two hardcoded above.
 * Key source: the screener row (the indexer stores fee/tickSpacing/hooks per pool), else PositionManager.poolKeys
 * (knows every pool that ever had a position). Either way the key is only used if keccak(key) == the poolId, so a
 * wrong or stale hint can never route a trade into a different pool.
 */
export interface V4Hint { poolId?: string | null; usdcIsC0?: boolean; v4fee?: number | null; v4tick?: number | null; hooks?: string | null }
const v4Found = new Map<string, V4Cfg | null>();
export async function findV4Route(token: string, hint?: V4Hint | null): Promise<V4Cfg | null> {
  const t = token.toLowerCase();
  if (V4_TOKENS[t]) return V4_TOKENS[t];
  if (v4Found.has(t)) return v4Found.get(t)!;
  // No poolId from the screener → find the token's real (most-traded) USDC V4 pool on-chain. A miss here is not
  // cached, so a later call that does carry a hint still gets its chance.
  const poolId = (hint?.poolId || (await findV4Pool(t).catch(() => null))?.poolId)?.toLowerCase();
  if (!poolId) return null;
  let key: Omit<V4Cfg, 'stateSlot'> | null = null;
  if (hint?.v4fee != null && hint?.v4tick != null) {
    const usdcC0 = !!hint.usdcIsC0;
    key = { currency0: usdcC0 ? USDC : t, currency1: usdcC0 ? t : USDC, fee: hint.v4fee, tickSpacing: hint.v4tick, hooks: (hint.hooks || ZERO).toLowerCase() };
    if (v4PoolIdOf(key) !== poolId) key = null;
  }
  if (!key) {
    const r = await ethCall(POSM, '0x86b6be7d' + poolId.slice(2, 52).padEnd(64, '0')); // poolKeys(bytes25)
    if (r && r.length >= 2 + 64 * 5) {
      const w = (i: number) => r.slice(2 + i * 64, 2 + i * 64 + 64);
      let ts = BigInt('0x' + w(3)); if (ts >= (1n << 255n)) ts -= 1n << 256n;
      const k = { currency0: ('0x' + w(0).slice(24)).toLowerCase(), currency1: ('0x' + w(1).slice(24)).toLowerCase(), fee: Number(BigInt('0x' + w(2))), tickSpacing: Number(ts), hooks: ('0x' + w(4).slice(24)).toLowerCase() };
      if (v4PoolIdOf(k) === poolId && (k.currency0 === USDC || k.currency1 === USDC)) key = k;
    }
  }
  const cfg = key ? { ...key, stateSlot: v4SlotOf(poolId) } : null;
  v4Found.set(t, cfg);
  return cfg;
}
// ABI encode a `bytes` value: length word + right-padded data.
const encBytes = (hex: string): string => { const h = hex.replace(/^0x/, ''); return padU(BigInt(h.length / 2)) + h.padEnd(Math.ceil(h.length / 64) * 64, '0'); };
// ABI encode a `bytes[]`: count + offsets + concatenated element encodings.
const encBytesArr = (arr: string[]): string => {
  const n = arr.length; const enc = arr.map(encBytes); let offs = '', data = '', cur = n * 32;
  for (const e of enc) { offs += padU(BigInt(cur)); data += e; cur += e.length / 2; }
  return padU(BigInt(n)) + offs + data;
};
const Q192_V4 = 2n ** 192n;
// Official Uniswap V4 Quoter (docs.arc.io/arc/references/contract-addresses). Returns the REAL amountOut
// for an exact-in swap — including price impact AND hook tax — which the slot0 spot math ignores (it over-
// quotes ~11% on a $1k trade and misses hook fees entirely; verified on the GLITCH pool 2026-09-21).
// quoteExactInputSingle((address,address,uint24,int24,address),bool,uint128,bytes) = 0xaa9d21cb. eth_call-safe.
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
async function quoteV4Exact(cfg: V4Cfg, zeroForOne: boolean, amountInRaw: bigint): Promise<bigint | null> {
  // params tuple: poolKey(5 static words) + zeroForOne + exactAmount + offset(0x100) + hookData len(0).
  const params = padA(cfg.currency0) + padA(cfg.currency1) + padU(cfg.fee) + padU(cfg.tickSpacing) + padA(cfg.hooks)
    + padU(zeroForOne ? 1n : 0n) + padU(amountInRaw) + padU(0x100n) + padU(0n);
  const j = await rpc('eth_call', [{ to: V4_QUOTER, data: '0xaa9d21cb' + padU(0x20n) + params }, 'latest']).catch(() => null);
  if (!j || j.error || !j.result || j.result === '0x') return null;
  try { const out = BigInt('0x' + j.result.slice(2, 66)); return out > 0n ? out : null; } catch { return null; }
}
// V4 quote: the official Quoter first (true executable out), slot0 spot × (1 − fee) only as a fallback.
export async function quoteV4(tokenIn: string, tokenOut: string, amountInRaw: bigint, cfgIn?: V4Cfg | null): Promise<{ outRaw: bigint; zeroForOne: boolean } | null> {
  const a = tokenIn.toLowerCase(), b = tokenOut.toLowerCase();
  const token = a === USDC ? b : (b === USDC ? a : null); if (!token) return null;
  const cfg = cfgIn || V4_TOKENS[token]; if (!cfg) return null;
  const zeroForOne = a === cfg.currency0; // tokenIn is currency0 → 0→1
  const q = await quoteV4Exact(cfg, zeroForOne, amountInRaw);
  if (q != null && q > 0n) return { outRaw: q, zeroForOne };
  // Fallback (quoter reverted — some hooks block quoting): slot0 spot × (1 − pool fee), impact/hook NOT reflected.
  const j = await rpc('eth_call', [{ to: PM_V4, data: '0x1e2eaeaf' + cfg.stateSlot.slice(2) }, 'latest']); // PoolManager.extsload(stateSlot)
  if (!j || j.error || !j.result || j.result === '0x') return null;
  let sqrtP: bigint; try { sqrtP = BigInt(j.result) & ((1n << 160n) - 1n); } catch { return null; } // slot0 packs sqrtPriceX96 in low 160 bits
  if (sqrtP <= 0n) return null;
  const p2 = sqrtP * sqrtP;
  let outRaw = zeroForOne ? (amountInRaw * p2) / Q192_V4 : (amountInRaw * Q192_V4) / p2;
  outRaw = (outRaw * BigInt(1_000_000 - cfg.fee)) / 1_000_000n;
  if (outRaw <= 0n) return null;
  return { outRaw, zeroForOne };
}
// Build the Universal Router execute() calldata for a V4 exact-in swap. Verified byte-identical.
export function buildV4SwapTx(token: string, zeroForOne: boolean, amountInRaw: bigint, minOutRaw: bigint, from: string, cfgIn?: V4Cfg | null): TxReq | null {
  const cfg = cfgIn || V4_TOKENS[token.toLowerCase()]; if (!cfg) return null;
  const settleCur = zeroForOne ? cfg.currency0 : cfg.currency1; // paying this currency
  const takeCur = zeroForOne ? cfg.currency1 : cfg.currency0;   // receiving this currency
  const params0 = '0x' + padU(0x20n) + padA(cfg.currency0) + padA(cfg.currency1) + padU(BigInt(cfg.fee)) + padU(BigInt(cfg.tickSpacing)) + padA(cfg.hooks)
    + padU(zeroForOne ? 1n : 0n) + padU(amountInRaw) + padU(minOutRaw) + padU(0n) + padU(0x140n) + padU(0n);
  const settle = '0x' + padA(settleCur) + padU(amountInRaw);
  const take = '0x' + padA(takeCur) + padU(minOutRaw);
  const actions = '0x060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const v4 = '0x' + padU(64n) + padU(BigInt(64 + encBytes(actions).length / 2)) + encBytes(actions) + encBytesArr([params0, settle, take]);
  const cEnc = encBytes('0x10'), iEnc = encBytesArr([v4]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const head = padU(96n) + padU(BigInt(96 + cEnc.length / 2)) + padU(deadline);
  return { to: UNIVERSAL_ROUTER, from, value: '0x0', data: '0x3593564c' + head + cEnc + iEnc };
}
// Permit2 status: does the wallet need to (a) approve the ERC-20 to Permit2, (b) Permit2-approve the router?
export async function v4Permit2Status(token: string, owner: string, amountInRaw: bigint): Promise<{ needErc20: boolean; needPermit2: boolean }> {
  const erc20Allow = await allowance(token, owner, PERMIT2);
  // Permit2.allowance(owner, token, spender) → (uint160 amount, uint48 expiration, uint48 nonce)
  const r = await rpc('eth_call', [{ to: PERMIT2, data: '0x927da105' + padA(owner) + padA(token) + padA(UNIVERSAL_ROUTER) }, 'latest']);
  let p2amt = 0n, p2exp = 0n;
  try { if (r && r.result && r.result !== '0x') { p2amt = BigInt('0x' + r.result.slice(2, 66)); p2exp = BigInt('0x' + r.result.slice(66, 130)); } } catch { /* treat as none */ }
  const now = BigInt(Math.floor(Date.now() / 1000));
  return { needErc20: erc20Allow < amountInRaw, needPermit2: p2amt < amountInRaw || p2exp < now };
}
// Permit2.approve(token, spender, amount uint160, expiration uint48) = 0x87517c45
export function buildPermit2ApproveTx(token: string, from: string): TxReq {
  const MAX160 = (1n << 160n) - 1n, exp = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  return { to: PERMIT2, from, value: '0x0', data: '0x87517c45' + padA(token) + padA(UNIVERSAL_ROUTER) + padU(MAX160) + padU(exp) };
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
  // toString() gives "1e-7" for tiny numbers (BigInt then throws and the quote hangs) — print it plainly.
  const plain = human.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  const [i, f = ''] = plain.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((i || '0') + frac);
};
export const fromRaw = (raw: bigint, decimals: number): number => {
  const s = raw.toString().padStart(decimals + 1, '0');
  return Number(s.slice(0, -decimals) + '.' + s.slice(-decimals));
};
