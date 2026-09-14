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
  launchpad: string | null;
  isOurs: boolean;
  isEcosystem: boolean;
}

const addrOf = (o: any): string =>
  (o && (o.hash || o.address_hash || o.address)) || (typeof o === 'string' ? o : '');

export async function fetchTokens(limit = 300): Promise<Token[]> {
  const out: Token[] = [];
  let params = new URLSearchParams({ type: 'ERC-20' });
  while (out.length < limit) {
    const r = await fetch(`${CHAIN.api}/tokens?${params.toString()}`, { headers: { accept: 'application/json' } });
    if (!r.ok) break;
    const j = await r.json();
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
        launchpad: null, // filled lazily via enrichLaunchpad
        isOurs: OURS.has(address),
        isEcosystem: ECOSYSTEM.test(`${t.name} ${t.symbol}`),
      });
    }
    if (!j.next_page_params) break;
    params = new URLSearchParams({ type: 'ERC-20', ...j.next_page_params });
  }
  return out.slice(0, limit);
}

// Fetch a token's deployer and tag it if the deployer is a known launchpad. Called on demand
// (one request per token) so the initial table paints fast.
export async function enrichLaunchpad(t: Token): Promise<Token> {
  try {
    const r = await fetch(`${CHAIN.api}/addresses/${t.address}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return t;
    const j = await r.json();
    const creator = addrOf(j.creator_address_hash).toLowerCase();
    return { ...t, launchpad: LAUNCHPADS[creator] || null };
  } catch { return t; }
}

export const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString());
