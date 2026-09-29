import { useEffect, useState } from 'react';
import { resolveTokenLogo } from '../lib/arc';
// Tokens with a static logo in public/l (scripts/logo-static.mjs, from the VPS logo cache). Baked into the bundle at build
// time, so the list always matches the files that deploy carried — no extra request, no 404 probes.
import STATIC_LOGOS from '../../public/l/index.json';
const STATIC = new Set<string>(STATIC_LOGOS as string[]);

const PALETTE = ['#ff6a1a', '#00c98d', '#00d4ff', '#bf5af2', '#d6a44b', '#ff4466', '#22c55e'];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Recognizable assets get their real logo even when the explorer has none. Keyed by SYMBOL only for
// display/alias contexts where no address is passed (e.g. USDC.X). ⛔ For a real 0x address we do NOT
// match by symbol — impersonators mint fake "USDC"/"EURC" tickers and would otherwise inherit the real
// logo (e.g. "UpSideDownCat" symbol USDC showing Circle's logo). Addressed tokens match KNOWN_ADDR only.
const KNOWN: Record<string, string> = {
  USDC: '/coins/USDC.svg', 'USDC.X': '/coins/USDC.svg', WUSDC: '/coins/USDC.svg', 'USDC.A': '/coins/USDC.svg',
  EURC: '/coins/EURC.svg', USDT: '/coins/USDT.png', WBTC: '/coins/BTC.png', WETH: '/coins/ETH.png', PAXG: '/coins/PAXG.png', GOLD: '/coins/PAXG.png',
};
// Canonical contract → official logo. Only these exact addresses get the pinned logo; any other address
// claiming the same ticker falls through to its own icon/on-chain/tolly/letter.
const KNOWN_ADDR: Record<string, string> = {
  '0x3600000000000000000000000000000000000000': '/coins/USDC.svg', // native USDC (Arc gas token)
};

// Arc-wide per-address token-image service (Tolly Labs) — the source other Arc sites use. Covers tokens
// that have no icon URL and no on-chain imageURI (e.g. ARCAT/MMM), so we fall back to it before a letter.
const tollyImg = (addr: string) => `https://api.tollylabs.com/token-image/${addr.toLowerCase()}.png`;

export function TokenLogo({ symbol, seed, url }: { symbol: string; seed: string; url?: string | null }) {
  const [staticBroke, setStaticBroke] = useState(false);
  const [primaryBroke, setPrimaryBroke] = useState(false);
  const [ipfsBroke, setIpfsBroke] = useState(false);
  const [cacheBroke, setCacheBroke] = useState(false);
  const [onchain, setOnchain] = useState<string | null>(null);
  const [onchainBroke, setOnchainBroke] = useState(false);
  const [tollyBroke, setTollyBroke] = useState(false);
  const color = colorFor(seed || symbol);
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(seed || '');
  // Addressed tokens: own icon → canonical-address logo → (no symbol match; impersonators don't inherit
  // real logos). Non-addressed (alias/display) tokens: fall back to the symbol map.
  const rawPrimary = url || KNOWN_ADDR[(seed || '').toLowerCase()] || (isAddr ? '' : (KNOWN[(symbol || '').toUpperCase()] || KNOWN[symbol] || ''));
  // ⛔ Dedicated Pinata gateways (…mypinata.cloud/ipfs/CID) intermittently drop browser <img> loads under
  // list bursts (BLOB kept showing a letter). Use the reliable public gateway as the PRIMARY, and keep a
  // second public IPFS gateway as the fallback before on-chain/tolly/letter.
  const primary = (rawPrimary || '').replace(/https?:\/\/[a-z0-9-]+\.mypinata\.cloud\/ipfs\//i, 'https://gateway.pinata.cloud/ipfs/');
  const ipfsCid = (() => { const m = (primary || '').match(/\/ipfs\/([A-Za-z0-9]+)/); return m ? m[1] : null; })();
  // Reset failure state when the token (url/seed) changes — the component is reused across list rows.
  useEffect(() => { setStaticBroke(false); setPrimaryBroke(false); setIpfsBroke(false); setCacheBroke(false); setOnchainBroke(false); setTollyBroke(false); }, [primary, seed]);
  // Resolve the on-chain logo when we have no primary OR the primary image failed to load (flaky IPFS
  // gateways 429 on bursts, e.g. the swap picker opening 10+ icons at once). This is the real fallback:
  // url → on-chain → letter, so a dead/rate-limited icon URL still shows the token's logo.
  const noPrimary = !primary || (primaryBroke && (!ipfsCid || ipfsBroke));
  // The VPS logo cache (/api/logo/<addr>, a 192px PNG made by scripts/logo-cache.mjs, edge-cached a day) comes BEFORE the
  // on-chain lookup: that lookup is 2 eth_calls per token in every visitor's browser (~275 RPC calls on one screener page).
  const needFallback = noPrimary && isAddr && cacheBroke;
  useEffect(() => {
    if (!needFallback) return;
    let alive = true;
    resolveTokenLogo(seed).then((l) => { if (alive && l) setOnchain(l); }).catch(() => {});
    return () => { alive = false; };
  }, [seed, needFallback]);

  // 09-29 ("logos are loading slow af"): a static CDN file first — /api/logo relays to the VPS and a rarely-viewed token
  // missed Vercel's regional cache every time (median 1.2 s per logo on the screener).
  const low = (seed || '').toLowerCase();
  if (isAddr && STATIC.has(low) && !staticBroke) {
    return <img className="tlogo" src={`/l/${low}.webp`} alt={symbol} loading="lazy" onError={() => setStaticBroke(true)} />;
  }
  // An IPFS-hosted logo goes to the VPS copy FIRST: the public gateways now refuse cross-site image loads (Chrome ORB /
  // CORP — 09-28: pinata + ipfs.io both blocked), so trying them first cost 2 failed requests per logo before the cache.
  if (ipfsCid && isAddr && !cacheBroke) {
    return <img className="tlogo" src={`/api/logo/${seed.toLowerCase()}`} alt={symbol} loading="lazy" onError={() => setCacheBroke(true)} />;
  }
  if (primary && !primaryBroke) {
    return <img className="tlogo" src={primary} alt={symbol} loading="lazy" onError={() => setPrimaryBroke(true)} />;
  }
  if (ipfsCid && !ipfsBroke) {
    return <img className="tlogo" src={`https://ipfs.io/ipfs/${ipfsCid}`} alt={symbol} loading="lazy" onError={() => setIpfsBroke(true)} />;
  }
  if (noPrimary && isAddr && !cacheBroke) {
    return <img className="tlogo" src={`/api/logo/${seed.toLowerCase()}`} alt={symbol} loading="lazy" onError={() => setCacheBroke(true)} />;
  }
  if (onchain && !onchainBroke) {
    return <img className="tlogo" src={onchain} alt={symbol} loading="lazy" onError={() => setOnchainBroke(true)} />;
  }
  if (isAddr && !tollyBroke) {
    return <img className="tlogo" src={tollyImg(seed)} alt={symbol} loading="lazy" onError={() => setTollyBroke(true)} />;
  }
  const letter = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?';
  return (
    <div className="tmono" style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}>{letter}</div>
  );
}
