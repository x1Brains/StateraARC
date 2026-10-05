// THE RULES — the token shape, the real assets pinned by ADDRESS, and the HARD RULES every number passes before it reaches
// a page. Pure (no env, no fetch, no DOM) so the browser, the VPS API and the snapshot builder can share ONE copy.
// Moved out of arc.ts 2026-09-28 unchanged (arc.ts re-exports everything here). ⛔ Node imports this file with
// type-stripping: no enums/namespaces; imports must carry the .ts extension.

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
  mcap: number | null;
  transfers?: number;      // pre-public (5042): transfer-event count in the scan window
  flags?: string[];        // pre-public: 'lookalike' | 'dup-symbol' | 'reserved-name'
  premain?: boolean;       // sourced from the unofficial 5042 index
  createdAt?: number | null; // ms epoch the token was deployed (for "recent launches" sorting)
  volume24h?: number | null; // 24h USDC volume (RadarDEX aggregate)
  change5m?: number | null;  // 5m price change, percent
  change24h?: number | null; // 24h price change, percent (RadarDEX)
  change1h?: number | null;  // 1h price change, percent
  change6h?: number | null;  // 6h price change, percent
  fdv?: number | null;       // fully-diluted valuation
  source?: string | null;    // top DEX / pool version (e.g. Uni V3, WarpV2)
  pool?: string | null;      // on-chain: the token's V3 pool address (for live re-pricing)
  poolId?: string | null;    // on-chain: the token's V4 poolId (for live re-pricing)
  v4PoolId?: string | null;  // on-chain: the token's busiest V4 USDC pool — kept also when pool/poolId point at a V3 pool
  v4UsdcIsC0?: boolean;      // on-chain: USDC is currency0 in that V4 pool
  v2Pairs?: { pair: string; label: string }[] | null; // on-chain: USDC V2-style pairs from factory enumeration (getPair can miss them)
  usdcIsC0?: boolean;        // on-chain: USDC is currency0/token0 in that pool
  decimals?: number;         // on-chain: token decimals (for live re-pricing)
  hooked?: boolean;          // on-chain: V4 pool has a hook (may charge a swap tax)
  v4fee?: number | null;     // on-chain: V4 PoolKey fee (with v4tick + hooks the swap can route the pool)
  v4tick?: number | null;    // on-chain: V4 PoolKey tickSpacing
  hooks?: string | null;     // on-chain: V4 PoolKey hooks address
  priceFrom?: 'chain' | 'radar' | 'warp' | null; // where the snapshot's price came from — 'chain' rows are never overwritten by an indexer
  txns24?: number | null;    // 24h transaction count
  spark?: number[] | null;   // sparkline price series (recent → last)
}

export const NATIVE_USDC_ADDR = '0x3600000000000000000000000000000000000000';
// Curated notable mainnet tokens (symbol/decimals known) — always scanned.
export const MAINNET_CORE: { address: string; name: string; symbol: string; decimals: number }[] = [
  { address: '0x384c60f98ecd4c26345499345c03d677e40f115e', name: 'Warp', symbol: 'WARP', decimals: 18 },
  { address: '0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0', name: 'Architects', symbol: 'Architects', decimals: 18 },
  { address: '0xece5ca8bf9220718e5727754026757512212cb3c', name: 'Argus', symbol: 'ARGUS', decimals: 18 },
  { address: '0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b', name: 'CRCL', symbol: 'CRCL', decimals: 18 },
  { address: '0xbc43ce8dec648ea298c4275559b81d6261c90b67', name: 'Tolly', symbol: 'TOLLY', decimals: 18 },
  { address: '0xf3715bf5c2de299f08b81180ffb739a8372a175f', name: 'Arcanine', symbol: 'ARCANINE', decimals: 18 },
  { address: '0x12ce1f970722ca6e08364b60099b3d25c09b5434', name: 'Arc Index 10', symbol: 'ARCX10', decimals: 18 },
  { address: '0xd17014b731d33994e4e482c374ef375b68240087', name: 'Machines Muxing Money', symbol: 'MMM', decimals: 18 },
  { address: '0x07704b06981ea962b87296362a1281484d160000', name: 'Arcat', symbol: 'ARCAT', decimals: 18 },
  { address: '0xeb64987643db71c76b2a2be7e723decc995e5b37', name: 'Cool', symbol: 'COOL', decimals: 18 },
  { address: '0x0bffa97f774824e9da843699aedd2835cb1b8022', name: 'Arcash', symbol: 'ARCASH', decimals: 18 },
  { address: '0xbe0cad585ea2d13de2f4e36376be755c0afd8b97', name: 'Arcbat', symbol: 'ARCBAT', decimals: 18 },
  { address: '0x2164bb17a2d38c1b5170e987b2c0416df1efc752', name: 'Long', symbol: 'LONG', decimals: 18 },
];

// CIRCLE & ARC CORE ecosystem assets — Circle's own infra on Arc, NOT third-party projects. USDC is the
// native gas token (added separately). Every address here is VERIFIED on-chain (name/symbol/decimals via
// arc-scan + eth_call) — never a symbol regex, which tagged squatters like "Chelsea USDC" as core.
// ⛔ Only list a token whose address is confirmed. cirETH / the ARC token have no pool yet + the explorer is
// Cloudflare-blocked, so they are pending the owner's addresses rather than a guess (a wrong address here
// would show a squatter's price as "core").
export const ECOSYSTEM_TOKENS: { address: string; name: string; symbol: string; price: number | null; holders: number; decimals?: number }[] = [
  // All verified on Arc mainnet (arc-scan + Circle docs docs.arc.io/arc/references/contract-addresses).
  { address: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', name: 'Circle Wrapped Bitcoin', symbol: 'cirBTC', price: null, holders: 3826, decimals: 8 },
  { address: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', name: 'Wrapped Ether', symbol: 'WETH', price: null, holders: 822, decimals: 18 },   // Arc's canonical WETH (NOT 0xd02d, a different one)
  { address: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', name: 'EURC', symbol: 'EURC', price: null, holders: 4310, decimals: 6 },           // Circle euro stablecoin (official)
  { address: '0x8a5d989bbb96929f689b0200f435f53da42bf490', name: 'US Yield Coin', symbol: 'USYC', price: null, holders: 0, decimals: 6 },     // Circle yield token
  { address: '0xa12cd81d0f9988e3d60c4b6a0d52d368ef3c788d', name: 'Arc', symbol: 'ARC', price: null, holders: 11, decimals: 6 },              // official Circle ARC token — 10B supply, no pool yet (sniper watches for launch)
];
// Ecosystem is decided by ADDRESS, never symbol — a fake "USDC" lookalike must NOT be tagged ECO.
export const ECOSYSTEM_ADDRS = new Set<string>([NATIVE_USDC_ADDR.toLowerCase(), ...ECOSYSTEM_TOKENS.map((e) => e.address.toLowerCase())]);

// ═════════ HARD RULES — every token passes these before ANY number reaches the page (owner 09-25, while promoting the site:
// "we can't have this happen ever again"). The full-history sweep pulled in junk/fake pools: ARC BAT's emptied V3 pool read
// $6.97e27/token, V4 tokens valued by tokens parked in the PoolManager showed $78T (BTCBR), $2.8T (CETH), $213M ("Blockchain
// USD", 99 holders), and a fake "CRCL" (25,745 airdropped holders) outranked the real one. The snapshot builder applies the
// same rules; this is the last line, so a bad build can never reach the screen. ═════════
// Real tokens pinned BY ADDRESS: for their ticker they are always the canonical one, however many holders a copycat airdrops.
// ── Statera impersonators (owner 09-30: "add a FAKE — not associated with us banner") ──
// Statera has not launched a token yet ($STR is announced, not deployed), so ANY token using the Statera name is not
// ours. When $STR ships, put its address in OFFICIAL_STATERA and it is never flagged. KNOWN_FAKES = copycats seen
// without the exact name (0x1101… 'StateraARC' / STRT, 09-30).
export const OFFICIAL_STATERA = new Set<string>([]);
const KNOWN_FAKES = new Set<string>(['0x1101ece603b96f5e5db610b63be9807fbb544235']);
export const isStateraImpersonator = (t: { address: string; name?: string | null; symbol?: string | null }): boolean => {
  const a = (t.address || '').toLowerCase();
  if (OFFICIAL_STATERA.has(a)) return false;
  return KNOWN_FAKES.has(a) || /statera/i.test(`${t.name || ''} ${t.symbol || ''}`);
};
export const stateraHasToken = () => OFFICIAL_STATERA.size > 0;

export const PINNED = new Set<string>([NATIVE_USDC_ADDR, ...ECOSYSTEM_TOKENS.map((e) => e.address), ...MAINNET_CORE.map((t) => t.address)].map((a) => a.toLowerCase()));
// Impersonator = claims to BE a Circle / major asset: that exact ticker, or a name that starts like the real one. (Was any
// name containing circle/usdc — the 09-25 audit found it hid meme tokens that only MENTION Circle: "Circled" 2,076 holders,
// "Circle Inu", "DogInCircle", "USDC Bull". Every fake from the owner's screenshots still matches this narrower rule.)
const IMPOSTOR_SYM = /^(usdc|usdt|eurc|usyc|cirbtc|crcl|weth|wbtc|dai|usd)$/i;
const IMPOSTOR_NAME = /^\s*(usd coin|circle internet|circle wrapped|euro coin|us yield coin|tether|wrapped ether|wrapped bitcoin)/i;
const PRICE_MAX = 1e6, LIQ_MAX = 5e7, MCAP_MAX = 5e8;
/** Scrub impossible numbers and flag fakes. Flagged rows (`bad`) are hidden from the screener, dashboard and totals. */
export function sanitizeToken<T extends Token>(t: T): T & { bad?: string } {
  const pinned = PINNED.has(t.address.toLowerCase()) || t.isEcosystem;
  const r: T & { bad?: string } = { ...t };
  const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);
  r.price = num(r.price); r.liq = num(r.liq); r.mcap = num(r.mcap);
  if (r.volume24h != null) r.volume24h = num(r.volume24h);
  if (r.price != null && (r.price <= 0 || r.price >= PRICE_MAX)) { r.price = null; r.liq = null; r.mcap = null; r.volume24h = null; r.bad = 'price'; }
  if (!pinned) {
    if (r.mcap != null && r.mcap > MCAP_MAX) { r.mcap = null; r.bad = r.bad || 'mcap'; }
    if (r.liq != null && r.liq > LIQ_MAX) { r.liq = null; r.bad = r.bad || 'liq'; }
    if (r.volume24h != null && r.volume24h > 5e7) { r.volume24h = null; r.bad = r.bad || 'vol'; }
    // A pool can't hold more than the whole token is worth: liquidity > 1.5x market cap = fake (09-26: "Arcanium Launchpad"
    // $27.9M liq on a $3,655 mcap, 0 volume). Real tokens: median 0.63x, 97% under 1.12x — only 2 of 314 exceed 1.5x.
    if (r.liq != null && r.mcap != null && r.mcap > 0 && r.liq > r.mcap * 1.5) { r.liq = null; r.bad = r.bad || 'liq>mcap'; }
    // Wash trading: 60-110x its own liquidity in a day from 4-5 wallets (ONBOARD, BLINKR, fake "SP500 xStock"…) is not volume.
    if (r.volume24h != null && r.liq != null && r.liq > 0 && r.volume24h > r.liq * 20) r.volume24h = null;
    if (IMPOSTOR_SYM.test((r.symbol || '').trim()) || IMPOSTOR_NAME.test(r.name || '')) r.bad = r.bad || 'impersonator';
  }
  if (r.spark && r.spark.some((x) => !isFinite(x) || x <= 0 || x >= PRICE_MAX)) r.spark = null;
  return r;
}
