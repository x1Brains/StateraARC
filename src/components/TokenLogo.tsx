import { useState } from 'react';

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

// Deterministic pixel-art avatar for any token without a real logo — so every token shows an image
// (this is the same DiceBear style Warp itself uses for its logo-less tokens).
const dicebear = (seed: string) => `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(seed || '?')}&backgroundColor=26262c,1b1b20&radius=50`;

export function TokenLogo({ symbol, seed, url }: { symbol: string; seed: string; url?: string | null }) {
  const [stage, setStage] = useState(0); // 0 = primary src, 1 = dicebear, 2 = letter fallback
  const color = colorFor(seed || symbol);
  const real = url || KNOWN[(symbol || '').toUpperCase()] || KNOWN[symbol] || '';
  const src = stage === 0 && real ? real : stage <= 1 ? dicebear(seed || symbol) : '';
  if (src) {
    return <img className="tlogo" src={src} alt={symbol} loading="lazy" onError={() => setStage((s) => s + 1)} />;
  }
  const letter = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?';
  return (
    <div className="tmono" style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}>{letter}</div>
  );
}
