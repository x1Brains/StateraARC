import { useEffect, useRef, useState } from 'react';
import { IconCheck } from './icons';

// Themed select — no native OS picker. Button + anchored popover in Statera's aesthetic.
export function Dropdown<T extends string>({ value, options, onChange, align = 'left' }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <div className={`dd ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="dd-btn" onClick={() => setOpen((o) => !o)}>
        <span>{current?.label ?? value}</span>
        <span className="dd-caret">▾</span>
      </button>
      {open && (
        <div className={`dd-menu ${align === 'right' ? 'r' : ''}`}>
          {options.map((o) => (
            <button type="button" key={o.value} className={`dd-opt ${o.value === value ? 'on' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
              {o.value === value && <span className="dd-check"><IconCheck /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
