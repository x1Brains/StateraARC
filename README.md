# Statera — the onchain-finance hub for Arc

**Live:** [www.stateraarc.com](https://www.stateraarc.com) · **Network:** Arc mainnet (chain 5042) · **X:** [@StateraArc](https://x.com/StateraArc)

Statera is a production DeFi application on Arc mainnet that gives Arc users one place to **discover, analyze, and trade** every token on the network. USDC-native throughout (USDC is Arc's gas token).

## Features

- **Screener / data layer** — aggregates every Arc launchpad and DEX (Argus, Tolly, Long, Warp, and 20+ more — 1000+ tokens) with live price, sparklines, 1h/24h change, 24h volume, market cap, liquidity, and holders. Token logos are read on-chain / via the aggregate.
- **In-app swap** — routes each trade across the deepest live liquidity on Arc: **WarpV2, Uniswap V3 (Argus factory), Uniswap V4 (hooked pools via Permit2 + Universal Router), and Warp bonding curves.** Min-out enforced on-chain; the swap is dry-run simulated before you sign. Every route is proven with real mainnet trades.
- **Portfolio + real P&L** — one-call holdings valuation plus **cost basis reconstructed from on-chain swaps** (average-cost realized + unrealized P&L, market cap at your entry vs now), an expandable per-token breakdown, and in-app token sends.
- **DEX-style token pages** — TradingView charts, top holders with concentration, live buy/sell pressure, and a transaction feed per token.
- **Clean, mobile-first UI** with clean URLs, live 60s refresh, and multi-RPC failover (PublicNode + rpc.mainnet.arc.io).

## Stack

React 18 · Vite 5 · TypeScript · lightweight-charts. Reads Arc mainnet directly over JSON-RPC; aggregates ecosystem data via the RadarDEX API. Deployed on Vercel.

## Notes

Unofficial community tooling — not affiliated with Circle. Data is aggregated from independent indexers and read on-chain; unverified, for informational purposes. Not financial advice — DYOR.
