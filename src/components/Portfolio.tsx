import { useEffect, useMemo, useState } from 'react';
import { sanitizeToken, ECOSYSTEM_ADDRS } from '../lib/rules';
import { mergeHoldings, fetchHoldings, fetchHoldingsMainnet, fetchHoldingsOnchain, fetchPortfolioMainnet, fetchRadarPortfolio, fetchNftHoldings, fetchWalletPnl, prefetchWalletPnl, priceMainnet, isAddress, tprice, usd, compact, CHAIN, type Token, type Holding, type RadarHolding, type NftHolding, type TokenPnl } from '../lib/arc';
import { fetchWarpToken } from '../lib/warp';
import { TokenLogo } from './TokenLogo';
import { SendModal, type SendToken } from './SendModal';
import { NftPanel } from './NftPanel';
import { IconExternal, IconCheck, IconCopy, IconSend } from './icons';
import { useNames, displayName, hasName } from '../lib/names';
import { v2Enabled, v2WalletSwaps, type V2WalletSwap } from '../lib/v2';
import { storePnl, type StorePnl } from '../lib/pnl';
import { PnlChart } from './PnlChart';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
const USDC_ADDR = '0x3600000000000000000000000000000000000000';
const STR_ADDR = '0xaaeea145196107f96a209a843e4f14a69dae99d0';

export function Portfolio({ tokens, wallet, onConnect, onOpenToken, mainnet = false }: { tokens: Token[]; wallet: string | null; onConnect: () => void; onOpenToken?: (addr: string) => void; mainnet?: boolean }) {
  const [addr, setAddr] = useState('');
  const [startedFor, setStartedFor] = useState(''); // the address the load effect last started for (no empty-state flash)
  const [input, setInput] = useState('');
  // Arc name for the wallet being viewed. Only forward-confirmed names come back (see lib/names.ts).
  const names = useNames([addr]);
  const [copied, setCopied] = useState<string | null>(null);
  const copyAddr = (e: React.MouseEvent, a: string) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(a).then(() => { setCopied(a); setTimeout(() => setCopied((c) => (c === a ? null : c)), 1200); }).catch(() => {});
  };
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [nfts, setNfts] = useState<NftHolding[]>([]); // ERC-721/1155 collections the wallet holds
  const [loading, setLoading] = useState(false);
  const [enriching, setEnriching] = useState(false); // fast view shown; full on-chain scan still running
  const [err, setErr] = useState<string | null>(null);
  const [livePx, setLivePx] = useState<Record<string, number>>({}); // mainnet: live pool prices
  const [liveMcap, setLiveMcap] = useState<Record<string, number>>({}); // mcap for tokens not in the screener (from Warp)
  const [pnl, setPnl] = useState<Record<string, TokenPnl> | null>(null); // reconstructed cost basis
  const [pnlLoading, setPnlLoading] = useState(false);
  // 10-15 (owner: P&L must show WITH the tokens): the loading scene also waits for the first P&L — at most 3 s past the bag
  const [pnlGate, setPnlGate] = useState(false);
  // 10-20: the swap store's list of every swap in this wallet's transactions → time-ordered P&L, closed positions, P&L chart.
  // 'fail' (store unreachable / wallet still building) falls back to the in-tab receipt reconstruction below.
  const [storeSwaps, setStoreSwaps] = useState<V2WalletSwap[] | null>(null);
  const [storeState, setStoreState] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');

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
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setPnlGate(true); setStartedFor(addr); setErr(null); setHoldings([]); setNfts([]); setLivePx({}); setLiveMcap({}); setEnriching(false);
    // Map a holdings source into the view + seed the prices it already carries.
    const apply = (src: RadarHolding[]) => {
      const h = src.map((r) => ({ address: r.address, name: r.name, symbol: r.symbol, decimals: r.decimals, balance: r.amount, iconUrl: r.icon }));
      const seeded: Record<string, number> = {};
      for (const r of src) if (r.price != null) seeded[r.address] = r.price;
      setHoldings(h); setLivePx((prev) => ({ ...prev, ...seeded }));
      return { h, seeded };
    };
    // Price any holdings still lacking a price: pool price (priceMainnet) then Warp curve price. Runs on
    // whatever view we have — so it can fill prices from the FAST phase-1 bag immediately, without
    // waiting on the full scan. ⚠️ don't block on the slow scan for a price the Warp API can give in ~1s.
    const usdcK = '0x3600000000000000000000000000000000000000';
    const enrich = async (h: Holding[], seeded: Record<string, number>) => {
      const need = h.filter((x) => seeded[x.address] == null && x.address !== usdcK).map((x) => x.address);
      const px = need.length ? await priceMainnet(need).catch(() => ({} as Record<string, number>)) : {};
      if (!alive) return;
      if (Object.keys(px).length) setLivePx((prev) => ({ ...prev, ...px }));
      const missing = h.filter((x) => seeded[x.address] == null && px[x.address] == null && x.address !== usdcK).slice(0, 20);
      const got = await Promise.all(missing.map((x) =>
        fetchWarpToken(x.address).then((w) => [x.address, w?.price ?? null, w?.mcap ?? null] as const).catch(() => null)));
      const add: Record<string, number> = {}, addMc: Record<string, number> = {};
      for (const r of got) if (r) {
        if (r[1] != null && isFinite(r[1]) && r[1] > 0) add[r[0]] = r[1];
        if (r[2] != null && isFinite(r[2]) && r[2] > 0) addMc[r[0]] = r[2]; // Warp mcap → fills MC now for non-screener tokens
      }
      if (alive && Object.keys(add).length) setLivePx((prev) => ({ ...prev, ...add }));
      if (alive && Object.keys(addMc).length) setLiveMcap((prev) => ({ ...prev, ...addMc }));
    };
    // P&L's slow half (tx list + receipts) needs only the address: start it NOW, alongside the holdings load.
    if (mainnet) prefetchWalletPnl(addr).catch(() => {});
    (async () => {
      try {
        if (!mainnet) { const h = await fetchHoldings(addr); if (alive) { setHoldings(h); setLoading(false); } return; }

        // NFTs (ERC-721/1155) — non-blocking, from the same explorer endpoint; paints alongside the bag.
        fetchNftHoldings(addr).then((n) => { if (alive) setNfts(n); }).catch(() => {});

        // PHASE 2's request needs only the address — start it NOW (10-14: it used to start after phase 1 settled, i.e. up to
        // 25 s later on a new wallet, on top of its own ~60 s cold scan). It is still awaited and applied below, same as before.
        const ocP = fetchHoldingsOnchain(addr).catch(() => ({ total: null, holdings: [] as RadarHolding[], ok: false }));

        // PHASE 1 — fast indexer sources (RadarDEX + explorer) so the wallet's bag paints in ~1-2s
        // instead of a long blank spinner while the full on-chain scan runs.
        // ⛔ 10-15 (owner: "it loaded like two coins and then the rest … should load everything all at once"): the 10-14 fix
        // painted RadarDEX the moment it landed — usually just 1-2 coins — then the rest popped in. Now the loading scene
        // stays up until OUR list (/v2/wallet/<a>/holdings: every token the wallet ever received, balances live — a stored
        // wallet answers in ~3 s since 7bca3aa) lands, and the whole bag paints once. RadarDEX alone paints only if ours
        // hasn't answered in 8 s. Same "longer list wins, ours on a tie" rule as ever, so the bag it settles on is unchanged.
        let fast: RadarHolding[] = [], rpL: RadarHolding[] = [], pfL: RadarHolding[] | null = null, waited = false;
        const show = (list: RadarHolding[]) => {
          if (!alive || !list.length || list.length <= fast.length) return;
          fast = list;
          const fs = apply(fast); setLoading(false); setEnriching(true); enrich(fs.h, fs.seeded);
          // The full scan can take up to ~90s cold; the fast bag + Warp enrich is already priced, so don't
          // leave the "reading the chain" bar up that whole time — retire it after ~18s regardless. Phase 2
          // still replaces the view with the complete bag whenever it lands.
          if (!hideTimer) hideTimer = setTimeout(() => { if (alive) setEnriching(false); }, 18000);
        };
        const best = () => (pfL && pfL.length >= rpL.length ? pfL : rpL);
        const waitT = setTimeout(() => { waited = true; show(best()); }, 8000);
        await Promise.all([
          fetchRadarPortfolio(addr).catch(() => ({ total: null, holdings: [] as RadarHolding[] }))
            .then((r) => { rpL = r.holdings; if (pfL || waited) show(best()); return r; }),
          fetchPortfolioMainnet(addr).catch(() => ({ total: null, holdings: [] as RadarHolding[] }))
            .then((r) => { pfL = r.holdings; if (pfL.length && pfL.length === fast.length && fast !== pfL) fast = []; show(best()); return r; }),
        ]);
        clearTimeout(waitT);
        if (!alive) return;
        if (fast.length) {
          /* painted above */
        } else {
          // ⛔ An EMPTY wallet used to sit on a blank "Loading holdings…" for the whole cold scan (~60-90s) plus the
          // curated fallback, and read as a broken site (owner, 09-24). The quick sources found nothing, so say so
          // NOW and keep the scan bar up while the full on-chain read double-checks.
          setLoading(false); setEnriching(true);
        }

        // PHASE 2 — the COMPLETE on-chain read (Transfer-log discovery + Multicall3 balanceOf + V3/V2/
        // Warp/V4 pricing across our RPCs). It's the full, correct bag; it replaces the fast view.
        const oc = await ocP;
        if (!alive) return;
        let finalSet: { h: Holding[]; seeded: Record<string, number> };
        if (oc.holdings.length || fast.length) { finalSet = apply(mergeHoldings(fast, oc.holdings)); } // merged, never replaced (10-02)
        else if (oc.ok) { finalSet = { h: [], seeded: {} }; }   // the full scan ANSWERED: this wallet really holds nothing
        else {
          // last resort: curated on-chain balanceOf scan
          const scan = tokens.filter((t) => t.price != null || t.liq != null || t.isEcosystem || t.launchpad);
          const h = await fetchHoldingsMainnet(addr, scan.map((t) => ({ address: t.address, name: t.name, symbol: t.symbol })));
          if (!alive) return; setHoldings(h); finalSet = { h, seeded: {} };
        }
        setLoading(false); setEnriching(false);
        // re-enrich the final (full) bag for anything the endpoint didn't price.
        await enrich(finalSet.h, finalSet.seeded);
      } catch (e: any) { if (alive) setErr(e.message || 'failed to load'); }
      finally { if (alive) { setLoading(false); setEnriching(false); if (hideTimer) clearTimeout(hideTimer); } }
    })();
    return () => { alive = false; if (hideTimer) clearTimeout(hideTimer); };
  }, [addr, mainnet, refreshTick]); // eslint-disable-line

  // ⛔ 10-02 (owner: "my portfolio said $68 and I sold for $78"): prices were read ONCE when the bag loaded and never again,
  // so an open portfolio kept showing old values while a coin moved. Re-read our own holdings prices (the server re-prices
  // from the pools every 40 s) every 30 s while this wallet is on screen; balances stay as loaded.
  useEffect(() => {
    if (!mainnet || !addr || !isAddress(addr)) return;
    let alive = true;
    const tick = () => fetchPortfolioMainnet(addr).then((pf) => {
      if (!alive) return;
      const fresh: Record<string, number> = {};
      for (const h of pf.holdings) if (h.price != null && isFinite(h.price) && h.price > 0) fresh[h.address.toLowerCase()] = h.price;
      if (Object.keys(fresh).length) setLivePx((prev) => ({ ...prev, ...fresh }));
    }).catch(() => {});
    const id = setInterval(tick, 30_000);
    const vis = () => { if (document.visibilityState === 'visible') tick(); }; // back on the tab: re-price now
    document.addEventListener('visibilitychange', vis);
    return () => { alive = false; clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, [addr, mainnet]); // eslint-disable-line

  useEffect(() => {
    setStoreSwaps(null);
    if (!mainnet || !addr || !isAddress(addr) || !v2Enabled) { setStoreState('fail'); return; }
    let alive = true; setStoreState('loading');
    v2WalletSwaps(addr).then((r) => { if (!alive) return; if (r.building || !Array.isArray(r.swaps)) { setStoreState('fail'); return; } setStoreSwaps(r.swaps); setStoreState('ok'); })
      .catch(() => { if (alive) setStoreState('fail'); });
    return () => { alive = false; };
  }, [addr, mainnet, refreshTick]);
  useEffect(() => {
    if (storeState !== 'ok' || !storeSwaps) return;
    setPnl(storePnl(storeSwaps)); setPnlLoading(false); setPnlGate(false);
  }, [storeState, storeSwaps]);
  // P&L (fallback): reconstruct cost basis from the wallet's on-chain swaps once holdings are known (mainnet only).
  const holdKey = holdings.map((h) => h.address).join(',');
  useEffect(() => {
    if (storeState === 'ok' || storeState === 'loading') { if (storeState === 'loading') setPnlLoading(true); return; }
    setPnl(null);
    if (!mainnet || !addr || !isAddress(addr) || !holdings.length) return;
    let alive = true; setPnlLoading(true);
    const gateT = setTimeout(() => setPnlGate(false), 3000); // never hold the bag back longer than this for P&L
    const decs: Record<string, number> = {};
    for (const h of holdings) decs[h.address.toLowerCase()] = h.decimals ?? 18;
    fetchWalletPnl(addr, decs).then((p) => { if (alive) setPnl(p); }).catch(() => { if (alive) setPnl({}); }).finally(() => { if (alive) { setPnlLoading(false); setPnlGate(false); } });
    return () => { alive = false; clearTimeout(gateT); };
  }, [addr, mainnet, holdKey, storeState]); // eslint-disable-line

  const rows = useMemo(() => {
    return holdings
      .map((h) => {
        const rd = radarByAddr.get(h.address);
        const iconUrl = h.iconUrl || rd?.iconUrl || null; // prefer the screener's logo when the explorer has none
        const name = rd?.name || h.name;
        // Price sanity: no Arc token is worth >$1M/unit — a bigger number is a decimals/degenerate-pool
        // error (DUKE mispriced at 1e44 blew up the whole total). Drop it, and cap any $1B+ position too.
        const rawP = priceMap.get(h.address) ?? null;
        // HARD RULES on the final row, whatever priced it (holdings service, pool, Warp): an impersonator (a fake "USDC"
        // valued at $4,000 on 09-28) or an impossible price → no price, and it's counterfeit even though it "had" one.
        const flagged = !!sanitizeToken({ address: h.address, symbol: h.symbol, name, price: rawP, liq: null, mcap: null, holders: null, totalSupply: null,
          type: 'ERC-20', iconUrl: null, launchpad: null, isOurs: false, isEcosystem: ECOSYSTEM_ADDRS.has(h.address.toLowerCase()) } as Token).bad;
        const p = !flagged && rawP != null && isFinite(rawP) && rawP > 0 && rawP < 1e6 ? rawP : null;
        const value = p != null && h.balance * p < 1e9 ? h.balance * p : null;
        // Counterfeit spam (only ever flags UNPRICED tokens — a token with real value is never hidden):
        //  • duplicate: another held token shares this ticker and is priced or bigger → this is an airdrop copy
        //  • collision: a known screener token owns this ticker at a different address
        const sym = (h.symbol || '').toUpperCase();
        const st = symStats.get(sym);
        const dupSpam = !!st && st.count > 1 && p == null && (st.anyPriced || h.balance < st.maxBal);
        const real = realAddrBySymbol.get(sym);
        const collideSpam = !!real && real.addr !== h.address.toLowerCase() && p == null;
        const counterfeit = flagged || dupSpam || collideSpam;
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
        const mcapNow = mcapMap.get(h.address) ?? liveMcap[h.address] ?? null;
        // MC when you bought ≈ (avg buy price / current price) × current market cap.
        const mcapAtBuy = avgCost != null && p && p > 0 && mcapNow != null ? (avgCost / p) * mcapNow : null;
        return { ...h, iconUrl, name, counterfeit, price: p, value, avgCost, totalPnl, pnlPct, unrealized, realized,
          invested: pl?.invested ?? null, qtyBought: pl?.qtyBought ?? null, qtySold: pl?.qtySold ?? null,
          costOfBag, mcapNow, mcapAtBuy };
      })
      // Priced tokens first (by value), then real-but-unpriced by balance so the big holdings lead.
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.balance - a.balance);
  }, [holdings, priceMap, pnl, radarByAddr, realAddrBySymbol, symStats, liveMcap]);

  // Default view = your VALUED bag. Hidden by default (all revealed by "Show"): counterfeit airdrops, sub-$1
  // PRICED dust, AND unpriced tokens — the ones with no USDC pool to value them ("—"), which are almost
  // always airdrop junk (the "?" no-metadata token, dust XAUM, etc.). A real unpriced hold is one click away.
  // Our own STR is never "dust": it has no pool yet (so no price), but it's the real token every Robot mint pays out.
  const isDust = (r: typeof rows[number]) => r.address.toLowerCase() !== STR_ADDR && (r.value == null || r.value < 1);
  const hiddenCount = useMemo(() => rows.filter((r) => r.counterfeit || isDust(r)).length, [rows]);
  const spamCount = hiddenCount;
  const shownRows = useMemo(() => (showSpam ? rows : rows.filter((r) => !r.counterfeit && !isDust(r))), [rows, showSpam]);

  // Closed positions (store P&L only): tokens this wallet traded and no longer holds (or holds < $1 of) — their realized result
  // used to vanish from the page and from Total P&L.
  const closed = useMemo(() => {
    if (storeState !== 'ok' || !pnl) return [];
    const held = new Map(rows.map((r) => [r.address.toLowerCase(), r]));
    return Object.entries(pnl as Record<string, StorePnl>).filter(([a, p]) => {
      const r = held.get(a); return p.qtySold > 0 && (!r || r.balance <= 0 || (r.value != null && r.value < 1));
    }).map(([a, p]) => { const rd = radarByAddr.get(a), h = held.get(a); return { address: a, symbol: rd?.symbol || h?.symbol || short(a), name: rd?.name || h?.name || '', iconUrl: rd?.iconUrl || h?.iconUrl || null, p }; })
      .sort((x, y) => Math.abs(y.p.realized) - Math.abs(x.p.realized));
  }, [pnl, rows, storeState, radarByAddr]);
  const closedAddrs = useMemo(() => new Set(closed.map((c) => c.address)), [closed]);
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalPnlSum = rows.reduce((s, r) => s + (closedAddrs.has(r.address.toLowerCase()) ? 0 : (r.totalPnl ?? 0)), 0) + closed.reduce((s, c) => s + c.p.realized, 0);
  const hasPnl = pnl != null && (rows.some((r) => r.totalPnl != null) || closed.length > 0);
  // first render after a new address = before the load effect ran: count it as loading, not as an empty wallet
  const busy = loading || (!!addr && isAddress(addr) && startedFor !== addr) || (mainnet && pnlGate && holdings.length > 0);
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
      {busy && (
        // the Statera S breathes until the whole bag is in (same scene as a token page), then everything paints at once
        <div className="tload pf-load" role="status" aria-live="polite">
          <img className="tload-s" src="/statera-s-192.webp" alt="" />
          <div className="tload-t">Loading portfolio<span className="tload-dots"><i>.</i><i>.</i><i>.</i></span></div>
          <div className="tload-sub">reading every token this wallet holds, live from Arc</div>
        </div>
      )}

      {addr && !busy && (
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
            <div className="stat" title={addr}><div className={`v${hasName(addr, names) ? ' named' : ''}`}>{displayName(addr, names, short)}</div><div className="l">{hasName(addr, names) ? 'Arc Name' : 'Address'}</div></div>
          </div>

          {mainnet && storeState === 'ok' && storeSwaps && storeSwaps.length > 0 && <PnlChart swaps={storeSwaps} nowPx={Object.fromEntries(priceMap)} />}
          {mainnet && storeState === 'ok' && storeSwaps && storeSwaps.length > 0 && pnl && (() => {
            // positions = every token this wallet traded: win rate over the ones that realized something, best / worst by total P&L
            const sym = (a: string) => radarByAddr.get(a)?.symbol || holdings.find((x) => x.address.toLowerCase() === a)?.symbol || short(a);
            const held = new Map(rows.map((r) => [r.address.toLowerCase(), r]));
            const pos = Object.entries(pnl as Record<string, StorePnl>).map(([a, p]) => {
              const r = held.get(a), un = r && r.price != null && p.openQty > 0 ? Math.min(p.openQty, r.balance) * (r.price - (p.openCost / p.openQty)) : 0;
              return { a, p, total: p.realized + un };
            });
            const decided = pos.filter((x) => x.p.qtySold > 0), wins = decided.filter((x) => x.p.realized > 0).length;
            const best = pos.reduce<typeof pos[number] | null>((m, x) => (!m || x.total > m.total ? x : m), null), worst = pos.reduce<typeof pos[number] | null>((m, x) => (!m || x.total < m.total ? x : m), null);
            const trades = pos.reduce((s2, x) => s2 + x.p.trades, 0);
            const csv = () => {
              const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
              const lines = ['date_utc,token,token_address,side,amount,price_usd,value_usd,venue,tx'];
              for (const s2 of [...storeSwaps].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex))
                lines.push([new Date(s2.ts * 1000).toISOString(), sym(s2.token), s2.token, s2.side, String(s2.amount), String(s2.price), s2.usd.toFixed(6), s2.venue, s2.tx].map(esc).join(','));
              const b = new Blob([lines.join('\n')], { type: 'text/csv' }), el = document.createElement('a');
              el.href = URL.createObjectURL(b); el.download = `statera-trades-${addr.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`; el.click(); setTimeout(() => URL.revokeObjectURL(el.href), 4000);
            };
            const sgn = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
            return (
              <div className="pf-kpis">
                <div><span>Win rate</span><b>{decided.length ? `${Math.round((wins / decided.length) * 100)}%` : '—'}</b><small>{wins}/{decided.length} positions sold in profit</small></div>
                <div><span>Best</span><b className="up">{best && best.total > 0 ? sgn(best.total) : '—'}</b><small>{best && best.total > 0 ? sym(best.a) : ''}</small></div>
                <div><span>Worst</span><b className="down">{worst && worst.total < 0 ? sgn(worst.total) : '—'}</b><small>{worst && worst.total < 0 ? sym(worst.a) : ''}</small></div>
                <div><span>Trades</span><b>{trades.toLocaleString()}</b><small>{pos.length} tokens</small></div>
                <button className="btn ghost pf-csv" onClick={csv} title="Every swap in this wallet's history — date, token, side, amount, price, USD, tx">Export CSV</button>
              </div>
            );
          })()}

          {spamCount > 0 && (
            <div className="pf-hidden">
              <span>{spamCount} {spamCount === 1 ? 'token' : 'tokens'} {showSpam ? 'shown' : 'hidden'} — counterfeit, sub-$1 &amp; unpriced dust.</span>
              <button className="btn ghost" onClick={() => setShowSpam((s) => !s)}>{showSpam ? 'Hide' : 'Show'}</button>
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
                    {storeState === 'ok' && storeSwaps && storeSwaps.some((x) => x.token.toLowerCase() === h.address.toLowerCase()) && (
                      <PnlChart compact title={`${h.symbol} P&L over time`} swaps={storeSwaps.filter((x) => x.token.toLowerCase() === h.address.toLowerCase())} nowPx={Object.fromEntries(priceMap)} />
                    )}
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
          {closed.length > 0 && (
            <div className="pf-closed">
              <h3 className="pf-closed-h">Closed positions <span>{closed.length} · realized {(() => { const r = closed.reduce((s2, c) => s2 + c.p.realized, 0); return `${r >= 0 ? '+' : '−'}${usd(Math.abs(r))}`; })()}</span></h3>
              <div className="table">
                <div className="trow head pf-crow"><span /><span>Token</span><span className="num hidesm">Bought</span><span className="num hidesm">Sold</span><span className="num hidesm">Trades</span><span className="num">Realized</span></div>
                {closed.map((c) => (
                  <div className={`trow tok pf-crow${onOpenToken ? ' clickable' : ''}`} key={c.address} onClick={() => onOpenToken?.(c.address)} title={`Last trade ${new Date(c.p.lastTs * 1000).toLocaleDateString()}`}>
                    <TokenLogo symbol={c.symbol} seed={c.address} url={c.iconUrl} />
                    <span className="pf-id"><span className="pf-nm"><span className="tname">{c.name || c.symbol}</span></span><span className="tsym">{c.symbol}</span></span>
                    <span className="num hidesm">{usd(c.p.invested)}</span>
                    <span className="num hidesm">{usd(c.p.proceeds)}</span>
                    <span className="num hidesm">{c.p.trades}</span>
                    <span className={`num pf-pnl ${c.p.realized >= 0 ? 'up' : 'down'}`}><span className="pf-pnl-v">{c.p.realized >= 0 ? '+' : '−'}{usd(Math.abs(c.p.realized))}</span>
                      {c.p.invested >= 1 && <span className="pf-pnl-pct">{c.p.realized >= 0 ? '+' : ''}{Math.max(-100, Math.min(9999, (c.p.realized / c.p.invested) * 100)).toFixed(0)}%</span>}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {addr && <NftPanel owner={addr} wallet={wallet} isOwnWallet={isOwnWallet} collections={nfts} />}
          {!rows.length && !nfts.length && (enriching
            ? <div className="msg">No tokens found in the quick check. Doing a full on-chain scan to be sure — for a wallet the site hasn't seen before this can take up to a minute.</div>
            : <div className="msg">This wallet doesn't hold any tokens on {mainnet ? 'Arc Mainnet' : CHAIN.name}.</div>)}
        </>
      )}
      {sendTok && wallet && <SendModal token={sendTok} wallet={wallet} onClose={() => setSendTok(null)} onSent={() => setTimeout(() => setRefreshTick((t) => t + 1), 4000)} />}
    </section></div>
  );
}
