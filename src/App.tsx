import { useEffect, useMemo, useState } from 'react';
import { fetchTokens, enrichLaunchpad, fmt, CHAIN, NET, LAUNCHPADS, type Token } from './lib/arc';

type Tab = 'all' | 'new' | 'eco' | 'ours';
type SortKey = 'holders' | 'name';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All Tokens' },
  { key: 'new', label: '🔥 Launchpad' },
  { key: 'eco', label: '🏛️ Ecosystem' },
  { key: 'ours', label: '🧠 Ours' },
];

export default function App() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('holders');

  async function load() {
    setLoading(true); setErr(null);
    try {
      const list = await fetchTokens(300);
      setTokens(list);
      // Enrich launchpad tags in the background (bounded concurrency).
      (async () => {
        for (let i = 0; i < list.length; i += 6) {
          const batch = await Promise.all(list.slice(i, i + 6).map(enrichLaunchpad));
          setTokens((prev) => {
            const m = new Map(prev.map((t) => [t.address, t]));
            for (const b of batch) if (b.launchpad) m.set(b.address, b);
            return [...m.values()];
          });
        }
      })();
    } catch (e: any) { setErr(e.message || 'failed to load'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    let r = tokens;
    if (tab === 'new') r = r.filter((t) => t.launchpad);
    else if (tab === 'eco') r = r.filter((t) => t.isEcosystem);
    else if (tab === 'ours') r = r.filter((t) => t.isOurs);
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((t) => t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s) || t.address.includes(s));
    }
    return [...r].sort((a, b) =>
      sort === 'holders' ? (b.holders ?? -1) - (a.holders ?? -1) : a.name.localeCompare(b.name));
  }, [tokens, tab, q, sort]);

  const launchpadCount = tokens.filter((t) => t.launchpad).length;

  return (
    <div className="wrap">
      <header>
        <div className="brand">
          <span className="logo">⚖️</span>
          <div>
            <h1>StateraArc</h1>
            <p className="tag">Token screener for Circle's Arc · <span className="net">{CHAIN.name}</span></p>
          </div>
        </div>
        <div className="stats">
          <div><b>{tokens.length}</b><span>tokens</span></div>
          <div><b>{launchpadCount}</b><span>launchpad</span></div>
          <div><b>{Object.keys(LAUNCHPADS).length}</b><span>pads tracked</span></div>
          <button className="refresh" onClick={load} disabled={loading}>{loading ? '…' : '↻ refresh'}</button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
        <input className="search" placeholder="search name / symbol / address…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="holders">sort: holders</option>
          <option value="name">sort: name</option>
        </select>
      </nav>

      {err && <div className="err">⚠️ {err}</div>}
      {loading && !tokens.length && <div className="loading">loading Arc tokens…</div>}

      <table>
        <thead>
          <tr><th>#</th><th>Token</th><th>Symbol</th><th className="r">Holders</th><th>Flags</th><th>Address</th></tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={t.address} className={t.isOurs ? 'ours' : ''}>
              <td className="dim">{i + 1}</td>
              <td className="name">{t.name}</td>
              <td className="sym">{t.symbol}</td>
              <td className="r">{fmt(t.holders)}</td>
              <td className="flags">
                {t.launchpad && <span className="pill pad">🏭 {t.launchpad}</span>}
                {t.isEcosystem && <span className="pill eco">🏛️</span>}
                {t.isOurs && <span className="pill mine">🧠 ours</span>}
              </td>
              <td><a href={`${CHAIN.scan}/token/${t.address}`} target="_blank" rel="noreferrer" className="addr">{t.address.slice(0, 8)}…{t.address.slice(-4)}</a></td>
            </tr>
          ))}
          {!loading && !rows.length && <tr><td colSpan={6} className="loading">no tokens match</td></tr>}
        </tbody>
      </table>

      <footer>
        <span>Data: Arcscan (Blockscout). {NET === 'testnet' ? 'Testnet — flips to mainnet at launch.' : 'Mainnet.'}</span>
        <span>Not financial advice · early launches are high-risk</span>
      </footer>
    </div>
  );
}
