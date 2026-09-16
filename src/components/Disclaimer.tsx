import { useState } from 'react';

// First-visit risk gate. Stored per-browser so it shows once. Deliberately detailed — StateraArc
// surfaces unaudited, pre-public, and paste-any-token data, and users are responsible for their
// own wallets. Wrapped in try/catch so a blocked localStorage never hard-locks the site.
const KEY = 'statera-disclaimer-v1';
export function disclaimerAcked(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; } // fail open, never trap the user
}

const POINTS = [
  ['Not financial advice', 'A data & tooling hub, not an advisor. Nothing here is a recommendation.'],
  ['Extremely volatile', 'Most tokens go to zero. Never risk what you can’t afford to lose.'],
  ['Unaudited software', 'This site and the contracts it touches aren’t audited. Use at your own risk.'],
  ['Unofficial data', 'Arc mainnet (5042) & testnet data comes from third-party indexers — unverified, treat as indicative only.'],
  ['Your keys, your risk', 'You’re responsible for your wallet and every tx you sign. Verify addresses yourself.'],
  ['No liability', 'No recourse, refund, or insurance. Do your own research.'],
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
        <p className="dsc-lede">StateraArc is a high-risk, experimental hub for Circle’s Arc chain. Please read before you continue.</p>
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
