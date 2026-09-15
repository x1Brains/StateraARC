import { useEffect, useMemo, useRef, useState } from 'react';
import { isAddress, type Token } from '../lib/arc';
import { TokenLogo } from './TokenLogo';

// Statera-styled token selector — a pill button that opens a themed modal (search + list +
// paste-any-address). Replaces the native <select> so there is never OS-white chrome.
export function TokenPicker({ value, tokens, exclude, onSelect, onAddAddress, adding }: {
  value?: Token;
  tokens: Token[];
  exclude?: string;
  onSelect: (t: Token) => void;
  onAddAddress: (addr: string) => void;   // resolve + add a pasted address
  adding?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const list = useMemo(() => {
    const ex = exclude?.toLowerCase();
    const s = q.trim().toLowerCase();
    return tokens.filter((t) => {
      if (t.address.toLowerCase() === ex) return false;
      if (!s) return true;
      return t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.address.toLowerCase().includes(s);
    });
  }, [tokens, q, exclude]);

  const pasteHit = isAddress(q.trim()) && !tokens.some((t) => t.address.toLowerCase() === q.trim().toLowerCase());

  const pick = (t: Token) => { onSelect(t); setOpen(false); };
  const addPasted = () => { onAddAddress(q.trim()); setOpen(false); };

  return (
    <>
      <button type="button" className="tk-pill tk-btn" onClick={() => setOpen(true)}>
        <TokenLogo symbol={value?.symbol || '?'} seed={value?.address || ''} url={value?.iconUrl || null} />
        <span className="tk-btn-sym">{value?.symbol || 'Select'}</span>
        <span className="tk-caret">▾</span>
      </button>

      {open && (
        <div className="tk-modal-bg" onClick={() => setOpen(false)}>
          <div className="tk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tk-modal-head">
              <span>Select a token</span>
              <button type="button" className="tk-x" onClick={() => setOpen(false)} aria-label="close">✕</button>
            </div>
            <input ref={inputRef} className="tk-search" placeholder="Search name or paste address (0x…)"
              value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter' && pasteHit) addPasted(); }} />
            {pasteHit && (
              <button type="button" className="tk-add-row" onClick={addPasted} disabled={adding}>
                <TokenLogo symbol="?" seed={q.trim()} url={null} />
                <div className="tk-row-id"><b>{adding ? 'Adding…' : 'Add this token'}</b><span className="tk-row-addr">{q.trim().slice(0, 10)}…{q.trim().slice(-6)}</span></div>
                <span className="tk-row-go">Import ↗</span>
              </button>
            )}
            <div className="tk-list">
              {list.length === 0 && !pasteHit && <div className="tk-empty">No tokens match. Paste a token address to import it.</div>}
              {list.map((t) => (
                <button type="button" key={t.address} className={`tk-row ${value?.address.toLowerCase() === t.address.toLowerCase() ? 'on' : ''}`} onClick={() => pick(t)}>
                  <TokenLogo symbol={t.symbol} seed={t.address} url={t.iconUrl} />
                  <div className="tk-row-id">
                    <b>{t.symbol}</b>
                    <span className="tk-row-addr">{t.name !== t.symbol ? t.name : `${t.address.slice(0, 6)}…${t.address.slice(-4)}`}</span>
                  </div>
                  {t.price != null && <span className="tk-row-px mono">${t.price < 0.01 ? t.price.toPrecision(2) : t.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
