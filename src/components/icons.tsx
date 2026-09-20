// Inline SVG icons. We use these instead of Unicode arrow/symbol glyphs (→ ↗ ⇅ ✕ ✓ ←) because those
// render as blank "tofu" squares on many mobile devices. SVGs draw identically everywhere and inherit
// the surrounding text color via currentColor. All are 1em-sized so they sit inline with text.
const base = { width: '1em', height: '1em', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export function IconArrowRight({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M3 8h9M8.5 4l4 4-4 4" /></svg>;
}
export function IconArrowLeft({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M13 8H4M7.5 4l-4 4 4 4" /></svg>;
}
export function IconExternal({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M13.5 2.5 7 9" /></svg>;
}
export function IconChevronDown({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M4 6l4 4 4-4" /></svg>;
}
// The X (Twitter) logo — a filled glyph, so it uses fill rather than the stroke base above.
export function IconX({ className }: { className?: string }) {
  return <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
}
export function IconSwapVertical({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M5 2v12M5 14l-2.5-2.5M5 14l2.5-2.5M11 14V2M11 2 8.5 4.5M11 2l2.5 2.5" /></svg>;
}
export function IconClose({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
}
export function IconCheck({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M3 8.5 6.5 12 13 4.5" /></svg>;
}
export function IconCopy({ className }: { className?: string }) {
  return <svg {...base} className={className}><rect x="5.5" y="5.5" width="8" height="8" rx="1.3" /><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>;
}
export function IconSwitch({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M3 5.5h8M8.5 3 11 5.5 8.5 8M13 10.5H5M7.5 8 5 10.5 7.5 13" /></svg>;
}
export function IconPower({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M8 2v6M4.5 4.5a5 5 0 1 0 7 0" /></svg>;
}
export function IconSend({ className }: { className?: string }) {
  return <svg {...base} className={className}><path d="M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5L14 2Z" /></svg>;
}
