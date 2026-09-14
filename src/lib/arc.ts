// StateraArc — Arc chain data layer. Reads Blockscout's public API (no key, client-side).
// Flip NET to 'mainnet' when Arc mainnet + its explorer go live (Sept 16, 2026).

export type Net = 'testnet' | 'mainnet';

export const NETS: Record<Net, { name: string; chainId: number; scan: string; api: string }> = {
  testnet: { name: 'Arc Testnet', chainId: 5042002, scan: 'https://testnet.arcscan.app', api: 'https://testnet.arcscan.app/api/v2' },
  // Mainnet explorer URL TBD at launch — update the moment it's known.
  mainnet: { name: 'Arc', chainId: 0, scan: '', api: '' },
};

export const NET: Net = (import.meta.env.VITE_ARC_NET as Net) || 'testnet';
export const CHAIN = NETS[NET];

// Known launchpads / factories from our radar (deployers that minted many tokens).
export const LAUNCHPADS: Record<string, string> = {
  '0x95d262c8ab207a54c08569887177fa301e7f9687': 'Memepad',
  '0x34a0b64a88bbd4bf6acba8a0ff8f27c8add67e9c': 'LP factory',
  '0x1594f838177784f4fcba8f4082d3ca53aeb2672b': 'Launcher',
  '0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad': 'Curve factory',
};

// Our own + notable ecosystem tokens, tagged for the views.
export const OURS = new Set(['0xc8e1ffc83da48b347dd89a42a19fd510723f16bb']); // BRAINS
export const ECOSYSTEM = /xylo|swaparc|synthra|arcflow|curve|cir|usyc|eurc|usdc|usdt/i;

export interface Token {
  address: string;
  name: string;
  symbol: string;
  holders: number | null;
  totalSupply: string | null;
  type: string;
  iconUrl: string | null;
  launchpad: string | null;
  isOurs: boolean;
  isEcosystem: boolean;
  price: number | null;
  liq: number | null;
}

export const addrOf = (o: any): string =>
  (o && (o.hash || o.address_hash || o.address)) || (typeof o === 'string' ? o : '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch with 429 backoff — Blockscout's public API rate-limits, so retry politely.
export async function req(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await sleep(800 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  throw new Error('rate-limited (429) — try again shortly');
}
async function api(path: string): Promise<any> { return req(`${CHAIN.api}${path}`); }

export async function fetchTokens(limit = 500): Promise<Token[]> {
  // FAST PATH: pre-baked snapshot (one small file, launchpad flags already computed) — the app
  // loads the whole screener instantly instead of hammering Blockscout's rate-limited API.
  try {
    const r = await fetch('/tokens-snapshot.json', { cache: 'default' });
    if (r.ok) {
      const snap = await r.json();
      if (snap && Array.isArray(snap.tokens) && snap.tokens.length) {
        return snap.tokens.slice(0, limit).map((t: any): Token => ({
          address: t.address, name: t.name, symbol: t.symbol,
          holders: t.holders ?? null, totalSupply: null, type: 'ERC-20',
          iconUrl: t.iconUrl ?? null, launchpad: t.launchpad ?? null,
          isOurs: !!t.isOurs, isEcosystem: !!t.isEcosystem,
          price: t.price ?? null, liq: t.liq ?? null,
        }));
      }
    }
  } catch { /* fall through to the live path */ }

  // FALLBACK: live fetch (rate-limited) — only used before a snapshot exists.
  const out: Token[] = [];
  let params = new URLSearchParams({ type: 'ERC-20' });
  while (out.length < limit) {
    const j = await req(`${CHAIN.api}/tokens?${params.toString()}`);
    if (!j) break;
    for (const t of j.items || []) {
      const address = addrOf(t.address ?? t).toLowerCase();
      if (!address) continue;
      out.push({
        address,
        name: t.name || '(unnamed)',
        symbol: t.symbol || '?',
        holders: t.holders != null ? Number(t.holders) : (t.holder_count != null ? Number(t.holder_count) : null),
        totalSupply: t.total_supply ?? null,
        type: t.type || 'ERC-20',
        iconUrl: t.icon_url ?? null,
        launchpad: null, // filled lazily via enrichLaunchpad
        isOurs: OURS.has(address),
        isEcosystem: ECOSYSTEM.test(`${t.name} ${t.symbol}`),
        price: null, liq: null,
      });
    }
    if (!j.next_page_params) break;
    params = new URLSearchParams({ type: 'ERC-20', ...j.next_page_params });
    await sleep(160); // be gentle on the public API
  }
  return out.slice(0, limit);
}

// Fetch a token's deployer and tag it if the deployer is a known launchpad. Called sparingly
// (throttled by the caller) so we don't trip the public API rate limit.
export async function enrichLaunchpad(t: Token): Promise<Token> {
  try {
    const j = await req(`${CHAIN.api}/addresses/${t.address}`);
    const creator = addrOf(j.creator_address_hash).toLowerCase();
    return { ...t, launchpad: LAUNCHPADS[creator] || null };
  } catch { return t; }
}

export const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString());

// Market ticker — BTC/ETH/SOL from Coinbase's CORS-open spot API, plus the stables.
export interface MarketPx { sym: string; price: number | null }
export async function fetchMarket(): Promise<MarketPx[]> {
  const majors = ['BTC', 'ETH', 'SOL'];
  const out: MarketPx[] = [];
  await Promise.all(majors.map(async (s) => {
    try {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`);
      const j = await r.json();
      out.push({ sym: s, price: Number(j.data.amount) });
    } catch { out.push({ sym: s, price: null }); }
  }));
  out.sort((a, b) => majors.indexOf(a.sym) - majors.indexOf(b.sym));
  out.push({ sym: 'USDC', price: 1 }, { sym: 'EURC', price: 1.08 });
  return out;
}
export const price = (n: number | null) =>
  n == null ? '—' : n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(4);

export const usd = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + n.toFixed(2);
};
export const compact = (n: number | null) =>
  n == null ? '—' : n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(Math.round(n));

// Token price — handles both normal and sub-cent values.
export const tprice = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(4);
  if (n >= 1e-6) return '$' + n.toFixed(8).replace(/0+$/, '');
  return '$' + n.toExponential(2);
};

// ── token detail ──
export interface TokenDetail {
  address: string; name: string; symbol: string; decimals: number;
  totalSupply: number | null; holders: number | null; iconUrl: string | null;
  exchangeRate: number | null; marketCap: number | null; volume24h: number | null;
  creator: string | null; isVerified: boolean; transfersCount: number | null;
}
export async function fetchTokenDetail(address: string): Promise<TokenDetail> {
  const [tok, counters, addr] = await Promise.all([
    api(`/tokens/${address}`),
    api(`/tokens/${address}/counters`).catch(() => ({} as any)),
    api(`/addresses/${address}`).catch(() => ({} as any)),
  ]);
  const dec = Number(tok.decimals || 18);
  const supplyRaw = tok.total_supply != null ? Number(tok.total_supply) / 10 ** dec : null;
  return {
    address, name: tok.name || '(unnamed)', symbol: tok.symbol || '?', decimals: dec,
    totalSupply: supplyRaw,
    holders: tok.holders != null ? Number(tok.holders) : (counters.token_holders_count != null ? Number(counters.token_holders_count) : null),
    iconUrl: tok.icon_url ?? null,
    exchangeRate: tok.exchange_rate != null ? Number(tok.exchange_rate) : null,
    marketCap: tok.circulating_market_cap != null ? Number(tok.circulating_market_cap) : null,
    volume24h: tok.volume_24h != null ? Number(tok.volume_24h) : null,
    creator: addr.creator_address_hash ? addrOf(addr.creator_address_hash) : null,
    isVerified: !!(addr.is_verified),
    transfersCount: counters.transfers_count != null ? Number(counters.transfers_count) : null,
  };
}

export interface Transfer { t: number; from: string; to: string; amount: number; tx: string; method: string; }
export async function fetchTransfers(address: string, limit = 50): Promise<Transfer[]> {
  const j = await api(`/tokens/${address}/transfers`).catch(() => ({ items: [] }));
  return (j.items || []).slice(0, limit).map((it: any) => ({
    t: new Date(it.timestamp).getTime(),
    from: addrOf(it.from), to: addrOf(it.to),
    amount: Number(it.total?.value || 0) / 10 ** Number(it.total?.decimals || 18),
    tx: it.transaction_hash || it.tx_hash || '',
    method: it.method || '',
  }));
}
export const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};
