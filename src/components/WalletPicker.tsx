import { useEffect } from 'react';
import type { Wallet } from '../lib/arc';

// Our own "choose a wallet" list (EIP-6963), so Connect never falls through to another extension's picker.
// One row per installed wallet that can use Arc; the last one used is marked.
export function WalletPicker({ wallets, last, onPick, onClose }: {
  wallets: Wallet[]; last: string | null; onPick: (w: Wallet) => void; onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="dsc-overlay wp-overlay" role="dialog" aria-modal="true" aria-labelledby="wp-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dsc-card wp-card">
        <div className="wp-head">
          <h2 id="wp-title">Connect a wallet</h2>
          <button type="button" className="wp-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="wp-sub">Wallets installed in this browser that work on Arc.</p>
        <div className="wp-list">
          {wallets.map((w) => (
            <button type="button" key={w.info.rdns || w.info.uuid} className="wp-row" onClick={() => onPick(w)}>
              {w.info.icon ? <img src={w.info.icon} alt="" /> : <span className="wp-noicon">{w.info.name.slice(0, 1)}</span>}
              <span className="wp-name">{w.info.name}</span>
              {last && w.info.rdns === last && <span className="wp-last">Last used</span>}
            </button>
          ))}
        </div>
        <p className="wp-foot">Just looking? Paste any address on Portfolio — no wallet needed.</p>
      </div>
    </div>
  );
}
