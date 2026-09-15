// Arc ecosystem watchlist. Two tiers:
//   WATCHLIST     — LIVE on Arc testnet now, ranked by real on-chain activity (`calls` = the
//                   contract's share of the last ~3,000 validated txs, from a wide Arcscan scan,
//                   scripts/arc-intel2.mjs). It's a "hot right now" rank, not a lifetime total.
//   MAINNET_WATCH — confirmed mainnet day-one protocols (Circle pressroom + arc.io/ecosystem).
//                   No testnet contract yet; armed to hunt them the moment mainnet opens Sept 16.
import { CHAIN } from './arc';

export type WatchCat = 'DEX' | 'Lending' | 'Bridge' | 'NFT' | 'Token' | 'Social' | 'Infra' | 'Oracle' | 'RWA' | 'Wallet' | 'Payments' | 'Stablecoin' | 'MM' | 'Exchange';

export interface WatchProject {
  name: string;
  cat: WatchCat;
  contract: string | null;
  symbol?: string;
  desc: string;
  calls?: number;            // appearances in our last sampled testnet scan (recent-activity rank)
  site?: string;
  x?: string;                // X/Twitter handle, no @
  note?: string;
  conf?: 'at launch' | 'private mainnet' | 'confirmed partner' | 'validator'; // mainnet confirmation
}

// ── LIVE on Arc testnet — ranked by recent on-chain activity (wide scan, 2026-09-14) ──
export const WATCHLIST: WatchProject[] = [
  { name: 'Stealth Router', cat: 'DEX', contract: '0x4b33146f2bcc75574534374c85662f9e51c38aca', calls: 336,
    desc: 'The single most-called router on Arc testnet — unverified, aggregator-like. Someone is routing serious volume through it.', note: 'Unverified' },
  { name: 'XyloNet', cat: 'DEX', contract: '0x73742278c31a76dbb0d2587d03ef92e6e2141023', symbol: 'XyloRouter', calls: 198,
    desc: 'Stablecoin DEX + cross-chain bridge + yield vaults (USDC/EURC/USYC). Verified router, #2 by activity.', site: 'https://www.xylonet.xyz', x: 'Xylonet_' },
  { name: 'Tower Exchange', cat: 'DEX', contract: '0x2de8906a641d65d490bc60a4179d961d59742bcb', symbol: 'TowerSwap', calls: 126,
    desc: 'Native stablecoin DEX aggregator & smart router (USDC/EURC/cirBTC). Arc-endorsed, verified executor.', site: 'https://www.tower.exchange', x: 'TowerExchange', note: 'Arc-endorsed' },
  { name: 'Bridge Kit (CCTP)', cat: 'Bridge', contract: '0xc5567a5e3370d4dbfb0540025078e283e36a363d', calls: 94,
    desc: "Circle Bridge Kit — native USDC bridging via CCTP. One of the busiest contracts on Arc.", note: 'Circle infra' },
  { name: 'ArcLand', cat: 'NFT', contract: '0x976f9c694e15126a94e508cec75a2f5472b488e4', symbol: 'ARCTERR2', calls: 94,
    desc: 'Land-grid NFTs — claim & battle for territory cells on Arc. Live jackpot contract.', site: 'https://arcland.app', x: 'ArcLandHQ' },
  { name: 'FlowSwap', cat: 'DEX', contract: '0x49f9636fe15883e16d5e356a4ea08c9fe6bc219b', symbol: 'FlowSwapAMM', calls: 95,
    desc: 'Native constant-product AMM — a busy verified DEX (no public site verified yet).', note: 'Verified' },
  { name: 'Universal Router', cat: 'DEX', contract: '0xe72f8175ab0991dbb778f6de62009c5bf97c17f7', calls: 91,
    desc: 'Uniswap-style universal swap router (V3/V4 command interface) — real Uniswap infra on Arc.' },
  { name: 'SayGM', cat: 'Social', contract: '0x1290b4f2a419a316467b580a088453a233e9adcc', calls: 48,
    desc: 'On-chain gm / social posting app — surprisingly high activity for a social primitive.' },
  { name: 'StableSwap Pool', cat: 'DEX', contract: '0x2f4490e7c6f3dac23ffee6e71bfcb5d1ccd7d4ec', calls: 39,
    desc: 'Verified stableswap pool — core USDC/EURC/stable liquidity venue.' },
  { name: 'Curve StableSwap', cat: 'DEX', contract: '0x2d84d79c852f6842abe0304b70bbaa1506add457', symbol: 'USDCEURC', calls: 30,
    desc: 'Curve-style stableswap (USDC/EURC) — Curve is a named Arc mainnet partner.', site: 'https://curve.finance', x: 'CurveFinance' },
  { name: 'cirBTC', cat: 'RWA', contract: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', symbol: 'cirBTC', calls: 19,
    desc: 'Circle Wrapped Bitcoin — BTC on Arc, collateral for lending/DeFi. Circle-native asset.', note: 'Circle asset' },
  { name: 'NeoArc', cat: 'NFT', contract: '0xe61c61a8f0d1d551bb85b81ece73ac6f48ad7a8d', symbol: 'nArc', calls: 18,
    desc: 'Open-edition ERC-721 surfaced via "free mint + airdrop" bait. Treat as high-risk.', note: 'Airdrop-bait · risk' },
  { name: 'StableFX', cat: 'Stablecoin', contract: '0xd68256f4d69c6bbecb873d8588ae0dc6b8e22e10', calls: 16,
    desc: "Circle's on-chain FX escrow — atomic USDC↔EURC swaps at reference rates. A core Arc money primitive.", note: 'Circle infra' },
  { name: 'CCTP TokenMessenger', cat: 'Bridge', contract: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', calls: 13,
    desc: 'Circle CCTP V2 burn/mint messenger — the canonical cross-chain USDC rail. Proven working.', note: 'Circle infra' },
  { name: 'XyloNet Stable Pool', cat: 'DEX', contract: '0x3df3966f5138143dce7a9cfddc2c0310ce083bb1', symbol: 'XYLO-USDC-EURC', calls: 12,
    desc: 'XyloNet USDC/EURC LP pool — live stablecoin liquidity with real reserves.', site: 'https://www.xylonet.xyz', x: 'Xylonet_' },
  { name: 'Minara', cat: 'Token', contract: '0x7eab7184be6743ec46d38eb865e6af204bd9e7da', symbol: 'MinaraRouter', calls: 9,
    desc: 'Arc-native token launchpad ("Pump.fun of Arc") with AI launch-scoring. Watch for the meme-launch wave.', site: 'https://minara.fun', x: 'minarafun' },
  { name: 'Circle Gateway', cat: 'Bridge', contract: '0x0077777d7eba4688bdef3e311b846f25870a19b9', calls: 6,
    desc: 'Circle Gateway — unified cross-chain USDC balance (instant, non-custodial). Complements CCTP.', note: 'Circle infra' },
  { name: 'ERC-4337 EntryPoint', cat: 'Infra', contract: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', calls: 6,
    desc: 'Account-abstraction EntryPoint — smart wallets & gasless UX. Live, canonical address.', note: 'Standard infra' },
  { name: 'ArcSwap Router', cat: 'DEX', contract: '0x8563912331dFFf503F3Ac261c470fed3C2E986a0',
    desc: 'UniV2-style router with 250 live pairs — the deepest testnet liquidity venue. Powers the StateraArc swap.', note: '250 pairs · swap engine' },
  { name: 'Arclings', cat: 'NFT', contract: null,
    desc: 'Day-one mainnet PFP mint (6,283 supply). GTD 6 / FCFS 7 / Public 9 USDC.', site: 'https://arclings.art', x: 'ArclingsNFT', note: 'Mainnet Sept 16' },
];

// ── MAINNET DAY-ONE — confirmed protocols to hunt at launch (Circle pressroom + arc.io/ecosystem).
//    Handles verified 2026-09-14 (lookalike traps checked: Morpho=@Morpho post-rebrand, Kraken=@krakenfx,
//    LayerZero=@LayerZero_Core, Galaxy=@galaxyhq, FalconX=@FalconXGlobal, Privy=@privy_io). ──
export const MAINNET_WATCH: WatchProject[] = [
  // DeFi — DEX / Lending (highest priority for the screener + swap)
  { name: 'Uniswap', cat: 'DEX', contract: null, conf: 'at launch',
    desc: 'Uniswap v4 (hooks) — the ONLY app Circle names live AT LAUNCH. Deepest USDC-pair liquidity day one. Top priority.', site: 'https://uniswap.org', x: 'Uniswap' },
  { name: 'Aave', cat: 'Lending', contract: null, conf: 'confirmed partner',
    desc: 'Non-custodial lending / borrowing markets. Circle-named day-one integration.', site: 'https://aave.com', x: 'aave' },
  { name: 'Aerodrome', cat: 'DEX', contract: null, conf: 'confirmed partner',
    desc: 've(3,3) AMM & liquidity hub. Circle-named — a core DEX liquidity venue.', site: 'https://aerodrome.finance', x: 'AerodromeFi' },
  { name: 'Morpho', cat: 'Lending', contract: null, conf: 'confirmed partner',
    desc: 'Onchain credit network matching lenders and borrowers. Circle-named DeFi integration.', site: 'https://morpho.org', x: 'Morpho' },
  { name: 'Curve', cat: 'DEX', contract: null, conf: 'private mainnet',
    desc: 'Stableswap DEX for like-priced assets — USDC/EURC/RWA stable pairs.', site: 'https://curve.finance', x: 'CurveFinance' },
  { name: 'Fluid', cat: 'Lending', contract: null, conf: 'private mainnet',
    desc: 'Lending/borrowing + DEX liquidity layer (Instadapp).', site: 'https://fluid.io', x: '0xfluid' },
  { name: 'Maple', cat: 'Lending', contract: null, conf: 'private mainnet',
    desc: 'Onchain asset manager / institutional credit markets.', site: 'https://maple.finance', x: 'maplefinance' },
  // Oracles & bridges — the plumbing DeFi reads/moves through
  { name: 'Chainlink', cat: 'Oracle', contract: null, conf: 'confirmed partner',
    desc: 'Price feeds & CCIP — the oracle layer most Arc DeFi will read. Circle-named.', site: 'https://chain.link', x: 'chainlink' },
  { name: 'Chronicle', cat: 'Oracle', contract: null, conf: 'private mainnet',
    desc: 'Low-cost decentralized oracles (from the MakerDAO lineage).', site: 'https://chroniclelabs.org', x: 'ChronicleLabs' },
  { name: 'LayerZero', cat: 'Bridge', contract: null, conf: 'private mainnet',
    desc: 'Omnichain messaging — inbound liquidity & cross-chain apps.', site: 'https://layerzero.network', x: 'LayerZero_Core' },
  { name: 'Axelar', cat: 'Bridge', contract: null, conf: 'private mainnet',
    desc: 'Cross-chain interoperability / general message passing.', site: 'https://axelar.network', x: 'axelar' },
  { name: 'Across', cat: 'Bridge', contract: null, conf: 'private mainnet',
    desc: 'Intent-based fast bridge — a likely inbound USDC route.', site: 'https://across.to', x: 'AcrossProtocol' },
  { name: 'Stargate', cat: 'Bridge', contract: null, conf: 'private mainnet',
    desc: 'Cross-chain liquidity transport (LayerZero-based).', site: 'https://stargate.finance', x: 'StargateFinance' },
  // RWA — institutional assets landing on Arc
  { name: 'BlackRock BUIDL', cat: 'RWA', contract: null, conf: 'validator',
    desc: "BlackRock's USD Institutional Digital Liquidity Fund — CONFIRMED to deploy; subscribe/redeem in native USDC. Highest-signal institutional launch. Founding validator.", site: 'https://blackrock.com', x: 'BlackRock' },
  { name: 'Securitize', cat: 'RWA', contract: null, conf: 'private mainnet',
    desc: 'Tokenization platform that operates BUIDL — watch for the fund token contract.', site: 'https://securitize.io', x: 'Securitize' },
  { name: 'Dinari', cat: 'RWA', contract: null, conf: 'private mainnet',
    desc: 'Tokenized US securities / equities (dShares) — tradeable stocks on-chain.', site: 'https://dinari.com', x: 'DinariGlobal' },
  { name: 'Centrifuge', cat: 'RWA', contract: null, conf: 'private mainnet',
    desc: 'Tokenized real-world assets & onchain private credit.', site: 'https://centrifuge.io', x: 'centrifuge' },
  // Wallets — how users reach Arc
  { name: 'MetaMask', cat: 'Wallet', contract: null, conf: 'confirmed partner',
    desc: 'Retail wallet access to Arc (add-chain / native USDC gas).', site: 'https://metamask.io', x: 'MetaMask' },
  { name: 'Ledger', cat: 'Wallet', contract: null, conf: 'confirmed partner',
    desc: 'Hardware wallet / self-custody support for Arc.', site: 'https://ledger.com', x: 'Ledger' },
  { name: 'Privy', cat: 'Wallet', contract: null, conf: 'private mainnet',
    desc: 'Embedded wallet stack — one-click onboarding for Arc apps.', site: 'https://privy.io', x: 'privy_io' },
  // Institutions — the validators / rails behind Arc
  { name: 'Circle', cat: 'Stablecoin', contract: null, conf: 'validator',
    desc: 'USDC issuer & Arc network operator. Everything settles in Circle stablecoins.', site: 'https://circle.com', x: 'circle' },
  { name: 'Kraken', cat: 'Exchange', contract: null, conf: 'confirmed partner',
    desc: 'Day-one exchange access — likely USDC on/off-ramp for Arc.', site: 'https://kraken.com', x: 'krakenfx' },
  { name: 'Visa', cat: 'Payments', contract: null, conf: 'validator',
    desc: 'Founding validator — card-network settlement rails on Arc.', site: 'https://visa.com', x: 'Visa' },
  { name: 'Mastercard', cat: 'Payments', contract: null, conf: 'validator',
    desc: 'Founding validator — payments settlement on Arc.', site: 'https://mastercard.com', x: 'Mastercard' },
];

export const WATCH_CATS: WatchCat[] = ['DEX', 'Lending', 'Bridge', 'Oracle', 'RWA', 'NFT', 'Token', 'Wallet', 'Payments', 'Exchange', 'Social', 'Infra', 'Stablecoin'];

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
