import { useEffect, useState } from 'react';
import { resolveTokenLogo } from '../lib/arc';

const PALETTE = ['#ff6a1a', '#00c98d', '#00d4ff', '#bf5af2', '#d6a44b', '#ff4466', '#22c55e'];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Recognizable assets get their real logo even when the explorer has none.
const KNOWN: Record<string, string> = {
  USDC: '/coins/USDC.svg', 'USDC.X': '/coins/USDC.svg', WUSDC: '/coins/USDC.svg', 'USDC.A': '/coins/USDC.svg',
  EURC: '/coins/EURC.svg', USDT: '/coins/USDT.png', WBTC: '/coins/BTC.png', WETH: '/coins/ETH.png', PAXG: '/coins/PAXG.png', GOLD: '/coins/PAXG.png',
};

// Arc-wide per-address token-image service (Tolly Labs) — the source other Arc sites use. Covers tokens
// that have no icon URL and no on-chain imageURI (e.g. ARCAT/MMM), so we fall back to it before a letter.
const tollyImg = (addr: string) => `https://api.tollylabs.com/token-image/${addr.toLowerCase()}.png`;

export function TokenLogo({ symbol, seed, url }: { symbol: string; seed: string; url?: string | null }) {
  const [primaryBroke, setPrimaryBroke] = useState(false);
  const [ipfsBroke, setIpfsBroke] = useState(false);
  const [onchain, setOnchain] = useState<string | null>(null);
  const [onchainBroke, setOnchainBroke] = useState(false);
  const [tollyBroke, setTollyBroke] = useState(false);
  const color = colorFor(seed || symbol);
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(seed || '');
  const primary = url || KNOWN[(symbol || '').toUpperCase()] || KNOWN[symbol] || '';
  // Dedicated Pinata gateways (…mypinata.cloud/ipfs/CID) hotlink-block / rate-limit the browser (the
  // image loads via curl but the <img> onErrors — e.g. BLOB). Retry the SAME CID on the reliable public
  // Pinata gateway before falling through to on-chain/tolly/letter.
  const ipfsCid = (() => { const m = (primary || '').match(/\/ipfs\/([A-Za-z0-9]+)/); return m && !/\/\/gateway\.pinata\.cloud\//.test(primary) ? m[1] : null; })();
  // Reset failure state when the token (url/seed) changes — the component is reused across list rows.
  useEffect(() => { setPrimaryBroke(false); setIpfsBroke(false); setOnchainBroke(false); setTollyBroke(false); }, [primary, seed]);
  // Resolve the on-chain logo when we have no primary OR the primary image failed to load (flaky IPFS
  // gateways 429 on bursts, e.g. the swap picker opening 10+ icons at once). This is the real fallback:
  // url → on-chain → letter, so a dead/rate-limited icon URL still shows the token's logo.
  const needFallback = (!primary || (primaryBroke && (!ipfsCid || ipfsBroke))) && isAddr;
  useEffect(() => {
    if (!needFallback) return;
    let alive = true;
    resolveTokenLogo(seed).then((l) => { if (alive && l) setOnchain(l); }).catch(() => {});
    return () => { alive = false; };
  }, [seed, needFallback]);

  if (primary && !primaryBroke) {
    return <img className="tlogo" src={primary} alt={symbol} loading="lazy" onError={() => setPrimaryBroke(true)} />;
  }
  if (ipfsCid && !ipfsBroke) {
    return <img className="tlogo" src={`https://gateway.pinata.cloud/ipfs/${ipfsCid}`} alt={symbol} loading="lazy" onError={() => setIpfsBroke(true)} />;
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
