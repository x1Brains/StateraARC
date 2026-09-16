import { useEffect, useState } from 'react';
import { TokenLogo } from './TokenLogo';
import { IconClose, IconExternal } from './icons';
import { isAddress, compact } from '../lib/arc';

const eth = () => (window as any).ethereum;
const ARC_CHAIN_HEX = '0x13b2'; // 5042

// Parse a decimal amount string → raw bigint at the token's decimals (no float rounding).
function toRaw(amt: string, decimals: number): bigint {
  const [i, f = ''] = amt.replace(/,/g, '').split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
async function ensureArc(): Promise<boolean> {
  try {
    const cur = await eth().request({ method: 'eth_chainId' });
    if (typeof cur === 'string' && cur.toLowerCase() === ARC_CHAIN_HEX) return true;
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_HEX }] });
    return true;
  } catch { return false; }
}

export interface SendToken { address: string; symbol: string; name: string; decimals: number; balance: number; iconUrl: string | null; }

export function SendModal({ token, wallet, onClose, onSent }: { token: SendToken; wallet: string; onClose: () => void; onSent?: () => void }) {
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => { const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', onEsc); return () => document.removeEventListener('keydown', onEsc); }, [onClose]);

  const amtNum = parseFloat(amt || '0');
  const overBal = amtNum > token.balance + 1e-12;
  const validTo = isAddress(to.trim());
  const canSend = validTo && amtNum > 0 && !overBal && phase !== 'sending';

  const send = async () => {
    if (!canSend) return;
    setPhase('sending'); setMsg('Confirm in your wallet…'); setHash(null);
    try {
      if (!eth()) throw new Error('No wallet found.');
      if (!(await ensureArc())) throw new Error('Switch your wallet to Arc mainnet to send.');
      const recipient = to.trim();
      const raw = toRaw(amt, token.decimals);
      // ERC-20 transfer(to, amount) — works for USDC (0x3600) and every Arc token.
      const data = '0xa9059cbb' + recipient.slice(2).toLowerCase().padStart(64, '0') + raw.toString(16).padStart(64, '0');
      const txHash: string = await eth().request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: token.address, data, value: '0x0' }] });
      setHash(txHash); setMsg('Sent — waiting for confirmation…');
      // wait for the receipt
      for (let i = 0; i < 40; i++) {
        const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [txHash] }).catch(() => null);
        if (r) { const ok = BigInt(r.status) === 1n; setPhase(ok ? 'done' : 'error'); setMsg(ok ? `Sent ${amt} ${token.symbol}.` : 'Transaction reverted.'); if (ok) onSent?.(); return; }
        await new Promise((res) => setTimeout(res, 1500));
      }
      setPhase('done'); setMsg(`Sent ${amt} ${token.symbol} (still confirming).`); onSent?.();
    } catch (e: any) {
      setPhase('error'); setMsg(e?.message?.includes('User denied') || e?.code === 4001 ? 'Cancelled in wallet.' : (e?.message || 'Send failed.'));
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal send-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-head">
          <TokenLogo symbol={token.symbol} seed={token.address} url={token.iconUrl} />
          <div className="sm-title"><b>Send {token.symbol}</b><span>{token.name}</span></div>
          <button className="sm-x" onClick={onClose} aria-label="close"><IconClose /></button>
        </div>

        <div className="sm-body">
          <div className="sm-field">
            <label>Recipient (Arc address)</label>
            <input className="sm-in mono" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
            {to && !validTo && <span className="sm-warn">Enter a valid 0x… address</span>}
          </div>

          <div className="sm-field">
            <label>Amount <button type="button" className="sm-max" onClick={() => setAmt(String(token.balance))}>MAX</button></label>
            <div className="sm-amt-row">
              <input className="sm-in" placeholder="0.0" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
              <span className="sm-sym">{token.symbol}</span>
            </div>
            <span className="sm-bal">Balance: {compact(token.balance)} {token.symbol}{overBal && <span className="sm-warn"> · exceeds balance</span>}</span>
          </div>

          <button className="btn solid sm-send" onClick={send} disabled={!canSend}>
            {phase === 'sending' ? 'Sending…' : `Send ${token.symbol}`}
          </button>

          {msg && (
            <div className={`sm-status ${phase}`}>
              {msg}
              {hash && <> · <a href={`https://explorer.arc.io/tx/${hash}`} target="_blank" rel="noreferrer">View tx <IconExternal className="i" /></a></>}
            </div>
          )}
          <p className="sm-note">Sends on Arc mainnet (chain 5042). Double-check the address — transfers are irreversible. Gas is paid in USDC.</p>
        </div>
      </div>
    </div>
  );
}
