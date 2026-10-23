// swap-owners — WHO really bought or sold in each swap: the wallet whose token balance went up (buy) or down (sell) in that
// transaction, from the token's own Transfer events. Used by Top traders + Holder profitability (table trader_pos).
// ⛔ 10-23 (GLITCH dev: holder profitability "off"): trades were credited to the address that SENT the transaction. Half of
// GLITCH's 139k trades were sent by one address and paid out through a router (pool → 0x3862… → buyer), and smart wallets /
// bots send for their owners — those holders had no buy at all, and the sender got credit for tokens it never held.
// The net balance change per transaction makes routers cancel out (they receive and pass on in the same tx).
// Also classifies tokens a wallet got WITHOUT a swap (table acq), so the card can say why a holder isn't counted.
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
export const PM_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ACQ_AIRDROP = 1, ACQ_MINT = 2, ACQ_TRANSFER = 4, ACQ_SHARE = 8; // SHARE: tokens out of someone else's trade (a router / aggregator fee or split)
const AIRDROP_MIN = 5; // one sender → this many recipients of the token in one tx (Disperse, multisend, claim batches)

export type Xfer = { tx: string; from: string; to: string; v: bigint };
export type Swap = { tx: string; side: number; usd: number; amt: number; ts: number; maker: string | null };
export type Pos = { bought: number; sold: number; qb: number; qs: number; nb: number; ns: number; first: number; last: number };

/** Credit one token's swaps (any block span) to their owners, given ALL of that token's Transfers in the same blocks.
 *  `pools`: the token's pool addresses (and the V4 PoolManager) — never an owner. Falls back to the sender (maker). */
export function attribute(swaps: Swap[], xfers: Xfer[], pools: Set<string>, onSwap: (owner: string, s: Swap) => void,
  onAcq?: (wallet: string, flag: number) => void) {
  const byTx = new Map<string, Xfer[]>();
  for (const x of xfers) { const l = byTx.get(x.tx); if (l) l.push(x); else byTx.set(x.tx, [x]); }
  const swapTx = new Set<string>();
  const buyTx = new Set<string>();
  for (const s of swaps) { swapTx.add(s.tx); if (s.side > 0) buyTx.add(s.tx); }
  const own = new Map<string, { up: string | null; dn: string | null }>(), shares: [string, string][] = [];
  for (const s of swaps) {
    let o = own.get(s.tx);
    if (!o) {
      const d = new Map<string, bigint>();
      for (const x of byTx.get(s.tx) || []) { d.set(x.from, (d.get(x.from) || 0n) - x.v); d.set(x.to, (d.get(x.to) || 0n) + x.v); }
      let up: [string, bigint] | null = null, dn: [string, bigint] | null = null;
      for (const [a, v] of d) {
        if (pools.has(a) || a === ZERO || a === DEAD) continue;
        if (v > 0n && (!up || v > up[1])) up = [a, v];
        if (v < 0n && (!dn || v < dn[1])) dn = [a, v];
      }
      o = { up: up?.[0] ?? null, dn: dn?.[0] ?? null }; own.set(s.tx, o);
      // everyone else whose balance went up — and the top receiver too when the tx has no buy to credit it with
      for (const [a, v] of d) if (v > 0n && (a !== o.up || !buyTx.has(s.tx)) && !pools.has(a) && a !== ZERO && a !== DEAD) shares.push([s.tx, a]);
    }
    const w = (s.side > 0 ? o.up : o.dn) ?? s.maker;
    if (w) onSwap(w, s);
  }
  if (!onAcq) return;
  for (const [, a] of shares) onAcq(a, ACQ_SHARE);
  // tokens received outside a swap: minted, airdropped (one sender → many in one tx), or sent from another address
  for (const [tx, xs] of byTx) {
    if (swapTx.has(tx)) continue;
    const per = new Map<string, Set<string>>();
    for (const x of xs) { if (x.v <= 0n || pools.has(x.to) || x.to === ZERO || x.to === DEAD) continue; const s = per.get(x.from); if (s) s.add(x.to); else per.set(x.from, new Set([x.to])); }
    for (const [from, tos] of per) {
      const flag = from === ZERO ? ACQ_MINT : tos.size >= AIRDROP_MIN ? ACQ_AIRDROP : ACQ_TRANSFER;
      for (const to of tos) onAcq(to, flag);
    }
  }
}

export const addPos = (m: Map<string, Pos>, owner: string, s: Swap) => {
  let p = m.get(owner);
  if (!p) { p = { bought: 0, sold: 0, qb: 0, qs: 0, nb: 0, ns: 0, first: s.ts, last: s.ts }; m.set(owner, p); }
  if (s.side > 0) { p.bought += s.usd; p.qb += s.amt; p.nb++; } else { p.sold += s.usd; p.qs += s.amt; p.ns++; }
  if (s.ts < p.first) p.first = s.ts; if (s.ts > p.last) p.last = s.ts;
};
export const xferOf = (l: { transactionHash: string; topics: string[]; data: string }): Xfer | null => {
  if (!l.topics || l.topics.length < 3) return null; // ERC-721 style (4 topics, no value) or malformed
  let v = 0n; try { v = BigInt(l.data && l.data !== '0x' ? l.data.slice(0, 66) : 0); } catch { return null; }
  return { tx: l.transactionHash.toLowerCase(), from: ('0x' + l.topics[1].slice(26)).toLowerCase(), to: ('0x' + l.topics[2].slice(26)).toLowerCase(), v };
};
