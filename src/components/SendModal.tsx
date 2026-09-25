import { useEffect, useState } from 'react';
import { TokenLogo } from './TokenLogo';
import { IconClose, IconExternal } from './icons';
import { isAddress, compact, mCall } from '../lib/arc';

const eth = () => (window as any).ethereum;
const ARC_CHAIN_HEX = '0x13b2'; // 5042

// Parse a decimal amount string → raw bigint at the token's decimals (no float rounding).
function toRaw(amt: string, decimals: number): bigint {
  const [i, f = ''] = amt.replace(/,/g, '').split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
// Exact decimal string of a raw amount (no float): 105000000000000000000000 @18 → "105000".
function rawToStr(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}
const NATIVE_USDC = '0x3600000000000000000000000000000000000000';
// Gas reserve kept back on a native-USDC MAX send (USDC is Arc's gas token; a send of the whole balance can't pay gas).
const USDC_GAS_RESERVE = 50_000_000_000_000_000n; // 0.05 USDC, 18-dec native
// Decode a revert: ERC20InsufficientBalance(address,uint256,uint256) = 0xe450d38c, Error(string) = 0x08c379a0.
function revertReason(data: string | undefined, decimals: number, symbol: string): string | null {
  if (!data || typeof data !== 'string') return null;
  if (data.startsWith('0xe450d38c')) {
    const bal = BigInt('0x' + data.slice(74, 138)), need = BigInt('0x' + data.slice(138, 202));
    return `Balance is ${rawToStr(bal, decimals)} ${symbol}, the send needs ${rawToStr(need, decimals)}.`;
  }
  if (data.startsWith('0x08c379a0')) {
    try { const len = Number(BigInt('0x' + data.slice(74, 138))); const h = data.slice(138, 138 + len * 2); let t = ''; for (let i = 0; i < h.length; i += 2) t += String.fromCharCode(parseInt(h.substr(i, 2), 16)); return t || null; } catch { return null; }
  }
  return null;
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

  // ⛔ 09-25: MAX used `String(token.balance)` — a JS float. An 18-dec bag of 105K ARCX10 doesn't fit in a float, so the
  // amount rounded UP past the real balance and the token reverted it (ERC20InsufficientBalance, tx 0x08f87935…).
  // The exact raw balance is read from the chain when the dialog opens; MAX and the over-balance check use it.
  const isNativeUsdc = token.address.toLowerCase() === NATIVE_USDC;
  const rawDec = isNativeUsdc ? 18 : token.decimals; // native USDC sends in its 18-dec native face
  const [balRaw, setBalRaw] = useState<bigint | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let r: string | null;
        if (isNativeUsdc) {
          const j = await fetch('https://rpc.mainnet.arc.io', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [wallet, 'latest'] }) }).then((x) => x.json());
          r = j?.result ?? null;
        } else r = await mCall(token.address, '0x70a08231' + wallet.slice(2).toLowerCase().padStart(64, '0'));
        if (alive && r) setBalRaw(BigInt(r));
      } catch { /* keep null: the float balance still gates, the pre-sign simulation catches the rest */ }
    })();
    return () => { alive = false; };
  }, [token.address, wallet, isNativeUsdc]);
  const maxRaw = balRaw == null ? null : isNativeUsdc ? (balRaw > USDC_GAS_RESERVE ? balRaw - USDC_GAS_RESERVE : 0n) : balRaw;
  const setMax = () => { if (maxRaw != null) setAmt(rawToStr(maxRaw, rawDec)); else setAmt(String(token.balance)); };

  useEffect(() => { const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', onEsc); return () => document.removeEventListener('keydown', onEsc); }, [onClose]);

  const amtNum = parseFloat(amt || '0');
  const amtRaw = (() => { try { return /^\d*\.?\d*$/.test(amt.replace(/,/g, '')) && amt ? toRaw(amt, rawDec) : 0n; } catch { return 0n; } })();
  // Exact check against the on-chain balance when we have it; the float compare only until it arrives.
  const overBal = balRaw != null ? amtRaw > (isNativeUsdc ? maxRaw ?? 0n : balRaw) : amtNum > token.balance + 1e-12;
  const validTo = isAddress(to.trim());
  const canSend = validTo && amtNum > 0 && !overBal && phase !== 'sending';

  const send = async () => {
    if (!canSend) return;
    setPhase('sending'); setMsg('Confirm in your wallet…'); setHash(null);
    try {
      if (!eth()) throw new Error('No wallet found.');
      if (!(await ensureArc())) throw new Error('Switch your wallet to Arc mainnet to send.');
      const recipient = to.trim();
      // USDC is Arc's NATIVE gas token (0x3600) — it does NOT support a direct ERC-20 transfer() call
      // (that reverts). Send it as a native value transfer (18-dec) instead. All other tokens: ERC-20.
      let params: any;
      if (isNativeUsdc) {
        const wei = toRaw(amt, 18); // native gas token is 18-dec
        params = { from: wallet, to: recipient, value: '0x' + wei.toString(16) };
      } else {
        const raw = toRaw(amt, token.decimals);
        const data = '0xa9059cbb' + recipient.slice(2).toLowerCase().padStart(64, '0') + raw.toString(16).padStart(64, '0');
        params = { from: wallet, to: token.address, data, value: '0x0' };
      }
      // Dry-run first: a send that would revert is stopped HERE with the reason, before the user signs and pays gas.
      setMsg('Checking the transfer…');
      const sim = await fetch('https://rpc.mainnet.arc.io', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [params, 'latest'] }) }).then((x) => x.json()).catch(() => null);
      if (sim?.error && (sim.error.data || /revert/i.test(sim.error.message || ''))) {
        throw new Error(`This send would fail: ${revertReason(sim.error.data, rawDec, token.symbol) || sim.error.message || 'reverted'}. Nothing was sent.`);
      }
      setMsg('Confirm in your wallet…');
      const txHash: string = await eth().request({ method: 'eth_sendTransaction', params: [params] });
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
            <label>Amount <button type="button" className="sm-max" onClick={setMax}>MAX</button></label>
            <div className="sm-amt-row">
              <input className="sm-in" placeholder="0.0" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
              <span className="sm-sym">{token.symbol}</span>
            </div>
            <span className="sm-bal">Balance: {compact(token.balance)} {token.symbol}{isNativeUsdc ? ' · MAX keeps 0.05 for gas' : ''}{overBal && <span className="sm-warn"> · exceeds balance</span>}</span>
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
