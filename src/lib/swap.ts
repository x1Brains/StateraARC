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
import { NET, RPCS } from './arc';

export const NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const USDC = NATIVE_USDC.toLowerCase();
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';

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
  mainnet: { bases: [], routers: [] },
};

export const SWAP_CFG = CFG[NET] || CFG.testnet;
export const swapReady = () => SWAP_CFG.routers.length > 0;

// ── low-level rpc (same failover list as arc.ts) ──
async function rpc(method: string, params: any[]): Promise<any> {
  for (const url of RPCS) {
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
  for (const base of SWAP_CFG.bases) {
    const bl = base.toLowerCase();
    if (bl !== a && bl !== b) paths.push([tin, base, tout]);
  }
  return paths;
}

export interface Quote {
  router: string; routerName: string; path: string[];
  amountInRaw: bigint; amountOutRaw: bigint; hops: number;
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

// Ask every router × every candidate path; return the single best fill.
export async function bestQuote(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<Quote | null> {
  if (!swapReady() || amountInRaw <= 0n) return null;
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
  const paths = candidatePaths(tokenIn, tokenOut);
  const jobs: Promise<Quote | null>[] = [];
  for (const r of SWAP_CFG.routers)
    for (const path of paths)
      jobs.push(
        getAmountsOut(r.addr, amountInRaw, path).then((out) =>
          out ? { router: r.addr, routerName: r.name, path, amountInRaw, amountOutRaw: out, hops: path.length - 1 } : null,
        ),
      );
  const results = (await Promise.all(jobs)).filter(Boolean) as Quote[];
  if (!results.length) return null;
  return results.reduce((a, b) => (b.amountOutRaw > a.amountOutRaw ? b : a));
}

// slippage in % → amountOutMin (integer floor)
export const minOut = (out: bigint, slippagePct: number): bigint =>
  (out * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;

export interface TxReq { to: string; from: string; data: string; value: string }

// approve(spender, amount) = 0x095ea7b3
export function buildApproveTx(token: string, spender: string, amountRaw: bigint, from: string): TxReq {
  return { to: token, from, value: '0x0', data: '0x095ea7b3' + padA(spender) + padU(amountRaw) };
}

// swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline) = 0x38ed1739
export function buildSwapTx(q: Quote, opts: { amountOutMinRaw: bigint; recipient: string; deadlineSec?: number }): TxReq {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSec ?? 600));
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
