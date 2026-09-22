import { useEffect, useRef, useState } from 'react';
import { IconCopy, IconCheck, IconExternal, IconSwitch, IconPower } from './icons';
import { useNames, displayName, hasName } from '../lib/names';

// Nav wallet control. Disconnected → a compact "Connect" button. Connected → the address with a
// dropdown to copy it, switch account, view on the explorer, or disconnect.
export function WalletButton({ wallet, onConnect, onDisconnect, onSwitch }: {
  wallet: string | null; onConnect: () => void; onDisconnect: () => void; onSwitch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // Forward-confirmed .arc / .circle name for the connected wallet, else the hex address.
  const names = useNames([wallet]);

  if (!wallet) return <button className="connect sm" onClick={onConnect}>Connect Wallet</button>;
  const label = displayName(wallet, names);
  const named = hasName(wallet, names);
  const copy = () => { navigator.clipboard?.writeText(wallet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };

  return (
    <div className="wbtn" ref={ref}>
      <button className="wbtn-main" onClick={() => setOpen((o) => !o)} title="Wallet">
        <span className="wbtn-dot" />
        <span className={`wbtn-addr${named ? ' named' : ''}`} title={wallet}>{label}</span>
        <span className={`wbtn-caret${open ? ' up' : ''}`} />
      </button>
      {open && (
        <div className="wbtn-menu">
          <div className="wbtn-full">{wallet}</div>
          <button className="wbtn-item" onClick={() => { copy(); }}>
            {copied ? <IconCheck className="i" /> : <IconCopy className="i" />} {copied ? 'Copied' : 'Copy address'}
          </button>
          <a className="wbtn-item" href={`https://explorer.arc.io/address/${wallet}`} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
            <IconExternal className="i" /> View on explorer
          </a>
          <button className="wbtn-item" onClick={() => { setOpen(false); onSwitch(); }}>
            <IconSwitch className="i" /> Switch wallet
          </button>
          <button className="wbtn-item danger" onClick={() => { setOpen(false); onDisconnect(); }}>
            <IconPower className="i" /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
