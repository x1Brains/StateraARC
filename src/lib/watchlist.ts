// Arc ecosystem watchlist — the projects we're tracking into mainnet, from on-chain intel
// (busiest contracts on Arc testnet) + known launches. `calls` = hits in our last testnet scan.
import { CHAIN } from './arc';

export type WatchCat = 'DEX' | 'Bridge' | 'NFT' | 'Token' | 'Social' | 'Infra';

export interface WatchProject {
  name: string;
  cat: WatchCat;
  contract: string | null;   // testnet contract (null = mainnet-only / not yet on testnet)
  symbol?: string;
  desc: string;
  calls?: number;            // activity from last testnet scan (hotness)
  site?: string;
  x?: string;                // X/Twitter handle, no @
  note?: string;
}

// Ordered by intel activity. Socials filled where verified; blanks get enriched over time.
export const WATCHLIST: WatchProject[] = [
  { name: 'Stealth Router', cat: 'DEX', contract: '0x4b33146f2bcc75574534374c85662f9e51c38aca', calls: 154,
    desc: '#2 most-called contract on Arc — unverified, router-like. A stealth DEX/aggregator worth watching.', note: 'Unverified' },
  { name: 'FlowSwap', cat: 'DEX', contract: '0x49f9636fe15883e16d5e356a4ea08c9fe6bc219b', calls: 46,
    desc: 'Native AMM — one of the busiest DEXes on Arc (no public site verified).', note: 'Unverified' },
  { name: 'Tower Exchange', cat: 'DEX', contract: '0x2de8906a641d65d490bc60a4179d961d59742bcb', calls: 29,
    desc: 'Native stablecoin DEX aggregator & smart router (USDC/EURC/cirBTC).', site: 'https://www.tower.exchange', x: 'TowerExchange', note: 'Arc-endorsed' },
  { name: 'XyloNet', cat: 'DEX', contract: '0x73742278c31a76dbb0d2587d03ef92e6e2141023', calls: 35,
    desc: 'Stablecoin DEX + cross-chain bridge + yield vaults (USDC/EURC/USYC).', site: 'https://www.xylonet.xyz', x: 'Xylonet_' },
  { name: 'Minara', cat: 'Token', contract: '0x7eab7184be6743ec46d38eb865e6af204bd9e7da', calls: 17,
    desc: 'Arc-native token launchpad ("Pump.fun of Arc") with AI launch-scoring.', site: 'https://minara.fun', x: 'minarafun' },
  { name: 'Curve StableSwap', cat: 'DEX', contract: '0x2d84d79c852f6842abe0304b70bbaa1506add457', symbol: 'USDCEURC', calls: 26,
    desc: 'Curve-style stableswap (USDC/EURC).' },
  { name: 'Universal Router', cat: 'Infra', contract: '0xe72f8175ab0991dbb778f6de62009c5bf97c17f7', calls: 47,
    desc: 'Uniswap-style universal swap router.' },
  { name: 'Bridge Kit (CCTP)', cat: 'Bridge', contract: '0xc5567a5e3370d4dbfb0540025078e283e36a363d', calls: 26,
    desc: "Circle Bridge Kit — native USDC bridging via CCTP.", note: 'Circle infra' },
  { name: 'ArcLand', cat: 'NFT', contract: '0x976f9c694e15126a94e508cec75a2f5472b488e4', symbol: 'ARCTERR2', calls: 21,
    desc: 'Land-grid NFTs — claim territory cells on Arc.', site: 'https://arcland.app', x: 'ArcLandHQ' },
  { name: 'NeoArc', cat: 'NFT', contract: '0xe61c61a8f0d1d551bb85b81ece73ac6f48ad7a8d', symbol: 'nArc', calls: 20,
    desc: 'Open-edition ERC-721 — surfaced only via "free mint + airdrop" bait. Treat as high-risk.', note: 'Airdrop-bait · risk' },
  { name: 'Alpha Protocol', cat: 'Token', contract: '0x701ba28dfedf1ad5b5e1c36482bd2ff4c6b469d2', symbol: 'ALPHA', calls: 15,
    desc: 'Alpha Protocol Genesis — token / protocol on Arc.' },
  { name: 'SayGM', cat: 'Social', contract: '0x1290b4f2a419a316467b580a088453a233e9adcc', calls: 32,
    desc: 'On-chain gm / social posting app.' },
  { name: 'Arclings', cat: 'NFT', contract: null, calls: 0,
    desc: 'Day-one mainnet PFP mint (6,283 supply). GTD 6 / FCFS 7 / Public 9 USDC.', site: 'https://arclings.art', x: 'ArclingsNFT', note: 'Mainnet Sept 16' },

  // ── Confirmed mainnet DeFi (from Circle pressroom + arc.io/ecosystem). These are what the
  //    screener & swap will route through at launch. Uniswap v4 is the only DEX Circle confirmed
  //    "at launch"; the rest are live on private mainnet and expected day-one.
  { name: 'Uniswap', cat: 'DEX', contract: null, calls: 0,
    desc: 'Uniswap v4 (hooks) — the only DEX Circle confirmed live AT LAUNCH. Deepest USDC-pair liquidity expected day one.', site: 'https://uniswap.org', x: 'Uniswap', note: 'Mainnet · confirmed at launch' },
  { name: 'Aave', cat: 'DEX', contract: null, calls: 0,
    desc: 'Lending / borrowing money-market. Present on Arc private mainnet — likely day-one.', site: 'https://aave.com', x: 'aave', note: 'Mainnet · private mainnet' },
  { name: 'Aerodrome', cat: 'DEX', contract: null, calls: 0,
    desc: 've(3,3) AMM & liquidity hub. Present on Arc private mainnet — likely day-one DEX liquidity.', site: 'https://aerodrome.finance', x: 'aerodromefi', note: 'Mainnet · private mainnet' },
  { name: 'Curve Finance', cat: 'DEX', contract: null, calls: 0,
    desc: 'Stableswap AMM — USDC/EURC/RWA stable pairs. A Circle-named integration.', site: 'https://curve.finance', x: 'CurveFinance', note: 'Mainnet · confirmed partner' },
  { name: 'Morpho', cat: 'DEX', contract: null, calls: 0,
    desc: 'Lending optimizer / credit markets. Circle-named DeFi integration.', site: 'https://morpho.org', x: 'MorphoLabs', note: 'Mainnet · confirmed partner' },
  { name: 'Fluid', cat: 'DEX', contract: null, calls: 0,
    desc: 'Lending + DEX liquidity layer. Circle-named DeFi integration.', site: 'https://fluid.io', x: '0xfluid', note: 'Mainnet · confirmed partner' },
  { name: 'BlackRock BUIDL', cat: 'Token', contract: null, calls: 0,
    desc: 'BlackRock USD Institutional Digital Liquidity Fund — CONFIRMED to deploy on Arc so institutions subscribe/redeem in native USDC. Highest-signal institutional launch.', site: 'https://securitize.io', x: 'BlackRock', note: 'Mainnet · confirmed deploy' },
];

export const WATCH_CATS: WatchCat[] = ['DEX', 'Bridge', 'NFT', 'Token', 'Social', 'Infra'];

// Live on-chain status for a watched contract (verified, tx count, balance) — best-effort.
export interface WatchStatus { verified: boolean; txCount: number | null; live: boolean; }
export async function fetchWatchStatus(contract: string): Promise<WatchStatus | null> {
  try {
    const r = await fetch(`${CHAIN.api}/addresses/${contract}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      verified: !!j.is_verified,
      txCount: j.transactions_count != null ? Number(j.transactions_count) : null,
      live: !!j.is_contract,
    };
  } catch { return null; }
}
