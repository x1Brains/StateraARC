import { useEffect, useState } from 'react';

// Lightweight public visit counter (like x1emoji). Uses the free, CORS-open abacus hit counter.
// Increments once per browser tab/session (module flag guards StrictMode double-mounts), then just
// reads. Fails silently — if the counter is unreachable, we render nothing rather than a broken 0.
const NS = 'stateraarc.com';
const KEY = 'visits';
const HIT = `https://abacus.jasoncameron.dev/hit/${NS}/${KEY}`;
const GET = `https://abacus.jasoncameron.dev/get/${NS}/${KEY}`;
let counted = false; // one increment per page load

export function VisitCounter() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const url = counted ? GET : HIT;
        counted = true;
        const r = await fetch(url);
        const j = await r.json();
        if (alive && typeof j.value === 'number') setN(j.value);
      } catch { /* stay hidden */ }
    })();
    return () => { alive = false; };
  }, []);
  if (n == null) return null;
  return (
    <span className="visits" title="Total site visits">
      <span className="visits-dot" />
      {n.toLocaleString()} <span className="visits-l">visits</span>
    </span>
  );
}
