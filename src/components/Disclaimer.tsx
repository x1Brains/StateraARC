import { useState } from 'react';

// First-visit risk gate. Stored per-browser so it shows once. Deliberately detailed — StateraArc
// surfaces unaudited, pre-public, and paste-any-token data, and users are responsible for their
// own wallets. Wrapped in try/catch so a blocked localStorage never hard-locks the site.
const KEY = 'statera-disclaimer-v1';
export function disclaimerAcked(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; } // fail open, never trap the user
}

const POINTS = [
  ['Not financial advice', 'Nothing on StateraArc is a recommendation to buy, sell, or hold anything. We are a data & tooling hub, not an advisor or broker.'],
  ['Crypto is extremely volatile', 'Most tokens — especially new launches and memes — go to zero. You can lose everything you put in. Never risk money you can’t afford to lose.'],
  ['Unaudited, experimental software', 'This site and the contracts it interacts with are not audited. Bugs, downtime, and unexpected behavior are possible. You use it entirely at your own risk.'],
  ['Pre-public & unofficial data', 'Testnet and pre-public (chain 5042) data comes from unofficial, sometimes flaky sources and cannot be fully verified. Treat prices, volumes, and “trending” as indicative only.'],
  ['You own your wallet & keys', 'You are solely responsible for your wallet, keys, approvals, and every transaction you sign. Verify contract addresses yourself — any address can be imported, including scams and impersonators.'],
  ['No liability', 'StateraArc and its creators are not liable for any loss or damage from using this site. There is no recourse, refund, or insurance. Do your own research.'],
];

export function Disclaimer({ onAccept }: { onAccept: () => void }) {
  const [checked, setChecked] = useState(false);
  const accept = () => {
    if (!checked) return;
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    onAccept();
  };
  return (
    <div className="dsc-overlay" role="dialog" aria-modal="true" aria-labelledby="dsc-title">
      <div className="dsc-card">
        <div className="dsc-head">
          <span className="dsc-warn" aria-hidden>!</span>
          <div>
            <div className="kicker">Read this first</div>
            <h2 id="dsc-title">Before you continue</h2>
          </div>
        </div>
        <p className="dsc-lede">StateraArc is a hub for Circle’s Arc chain — a screener, portfolio tracker, and swap. It is high-risk, experimental software. Please read and understand the following before you use it.</p>
        <div className="dsc-points">
          {POINTS.map(([h, b]) => (
            <div className="dsc-point" key={h}>
              <div className="dsc-point-h">{h}</div>
              <div className="dsc-point-b">{b}</div>
            </div>
          ))}
        </div>
        <label className="dsc-agree">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I have read and understand the above. I accept that this is <b>unaudited, high-risk software</b>, that I use it <b>entirely at my own risk</b>, and that I am responsible for the security of my own wallet.</span>
        </label>
        <button className="btn solid dsc-cta" disabled={!checked} onClick={accept}>Continue</button>
        <div className="dsc-foot">Not financial advice · DYOR · You alone are responsible for your funds.</div>
      </div>
    </div>
  );
}
