import { useState } from 'react';

// Screener snapshot (owner 10-29): the top 10 / 20 / 30 tokens by liquidity as one image (api/report.js ?view=screener),
// the same card family as the token and network snapshots. Fetched first and saved only if it IS an image (same rule as
// the token page's Snapshot button — a server error must never download as a text file).
export function ScreenerSnapshot() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const take = async (n: number) => {
    if (busy) return;
    setBusy(n); setErr(false);
    try {
      const r = await fetch(`/api/report?view=screener&n=${n}&download=1&t=${Date.now()}`);
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.startsWith('image/')) throw new Error(`snapshot ${r.status}`);
      const blob = await r.blob();
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `statera-arc-top${n}.png`;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setOpen(false);
    } catch { setErr(true); setTimeout(() => setErr(false), 4000); }
    finally { setBusy(null); }
  };
  return (
    <span className="scr-snap">
      <button className={`dupe-toggle${open ? ' on' : ''}`} onClick={() => setOpen((v) => !v)} title="Download the top tokens as one image to post">
        {err ? 'Snapshot failed — retry' : 'Snapshot'}
      </button>
      {open && [10, 20, 30].map((n) => (
        <button key={n} className="dupe-toggle scr-snap-n" disabled={busy != null} onClick={() => take(n)}>
          {busy === n ? 'Saving…' : `Top ${n}`}
        </button>
      ))}
    </span>
  );
}
