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

export function TokenLogo({ symbol, seed, url }: { symbol: string; seed: string; url?: string | null }) {
  const [broken, setBroken] = useState(false);
  const [onchain, setOnchain] = useState<string | null>(null);
  const color = colorFor(seed || symbol);
  const known = url || KNOWN[(symbol || '').toUpperCase()] || KNOWN[symbol] || '';
  // No supplied/known logo → read it on-chain from the token address (cached).
  useEffect(() => {
    if (known || !/^0x[0-9a-fA-F]{40}$/.test(seed || '')) return;
    let alive = true;
    resolveTokenLogo(seed).then((l) => { if (alive && l) setOnchain(l); }).catch(() => {});
    return () => { alive = false; };
  }, [seed, known]);
  const src = known || onchain;
  if (src && !broken) {
    return <img className="tlogo" src={src} alt={symbol} loading="lazy" onError={() => setBroken(true)} />;
  }
  const letter = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?';
  return (
    <div className="tmono" style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}>{letter}</div>
  );
}
