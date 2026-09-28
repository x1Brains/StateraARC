import { useEffect, useState } from 'react';
import { usd } from '../lib/arc';
import { v2Chain, v2Lending, type V2Chain, type V2Lending } from '../lib/v2';
import { IconArrowRight } from './icons';

// "ARC, LIVE" banner on the landing page — a slim strip of Arc's headline numbers that opens the Network page.
// Owner 09-28: the first version was "pretty much the whole network page on the landing page" (and its validator logos
// bled out on phones) — "just a little small section or a banner … click here to go to the network page".
// Same /v2 feeds as Network.tsx, so the numbers match.
export function ArcLive({ onOpen }: { onOpen: () => void }) {
  const [c, setC] = useState<V2Chain | null>(null);
  const [l, setL] = useState<V2Lending | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => { v2Chain().then((x) => { if (alive) setC(x); }).catch(() => {}); v2Lending().then((x) => { if (alive) setL(x); }).catch(() => {}); };
    load(); const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!c) return null;
  const money = c.supplyUsd ? ['USDC', 'EURC', 'cirBTC'].reduce((s, k) => s + (c.supplyUsd?.[k] ?? 0), 0) : null;
  const lent = l ? l.aave.supplyUsd + (l.morpho.complete ? l.morpho.supplyUsd : 0) : null;
  return (
    <button type="button" className="alb" onClick={onOpen} aria-label="Open the Arc Network page">
      <span className="alb-tag"><span className="live-dot" /> Arc, live</span>
      <span className="alb-stats">
        <span><b className="f">{usd(money)}</b><i>money on Arc</i></span>
        <span><b>{lent ? usd(lent) : '—'}</b><i>lent</i></span>
        <span><b>{c.m5 ? Math.round(c.m5.tps) : '—'}/s</b><i>transactions</i></span>
        <span><b>{c.validatorCount}</b><i>validators</i></span>
      </span>
      <span className="alb-go">Network <IconArrowRight className="arw" /></span>
    </button>
  );
}
