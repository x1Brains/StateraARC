# StateraArc v1 — how the site runs today (frozen 2026-09-28)

> The reference for the v2 data upgrade (see `docs/UPGRADE_PLAN.md`). If v2 breaks something, this file says how v1
> did it. Git tag **`v1-baseline-2026-09-28`** = the exact code. VPS copy (code, units, indexer state, live snapshot) =
> `~/bt/statera-baseline-2026-09-28/vps/` on the owner's machine (not in git: it holds indexer state and private config).
> Measured baseline: `docs/v1-baseline/crawl/summary.json` + one `.txt` (visible text) and `.png` per page.

## 1. The pipeline (server side, VPS x1b-prod)

```
Arc chain (RPC: rpc.mainnet.arc.io, drpc, tenderly, blockdaemon, quicknode)
   │
   ├─ arc-indexer.timer (10 min after last run) → arc-indexer.service
   │    /root/statera-repo  (git reset --hard origin/main first!)  node scripts/onchain-discover.mjs
   │    state:  /root/arc-indexer/state.json   (V3 pools, v4reg = every V4 Initialize, v2pairs, gaps)
   │    output: /root/arc-indexer/onchain-tokens.json  (~6,600 rows: price/liq/vol/holders per token)
   │
   ├─ statera-snapshot.timer (*:0/30) → statera-snapshot.service → /root/vps-snapshot-push.sh
   │    reset to origin/main → scripts/refresh.sh → scripts/snapshot-mainnet.mjs
   │      merges indexer rows + RadarDEX (relay) + Warp + deep pools + Animus suite, applies the HARD RULES,
   │      tagLaunchpads() (creator via arc-scan, cache /root/statera-live/creators.json)
   │    → public/tokens-snapshot.json → copied to /root/statera-live/tokens-snapshot.json (only if >= 500 tokens)
   │    → logo-cache.mjs in background → /root/statera-live/logos/<addr>.png
   │    → git commit+push of the static copy at most every 6h (backup; each push = a Vercel deploy)
   │
   ├─ holdings-svc.service  node /root/holdings-svc/holdings.mjs  :8788 (key-gated, Tailscale funnel)
   │    /holdings/snapshot   → the live snapshot file (+ x-snapshot-age header)
   │    /holdings/logo/<a>   → cached PNG logo (miss = 404 + background fetch)
   │    /holdings?addr=<a>   → a wallet's full bag (Transfer-log discovery + Multicall balanceOf + pricing), cached
   │
   ├─ radar-relay.service   node /root/radar-relay/relay.mjs  (clean-IP proxy: RadarDEX blocks Vercel IPs)
   └─ statera-launch.timer  every 2 min — mainnet launch detector. OBSOLETE since 09-16 (still running, harmless).
```

Vercel (project `statera-arc`, static Vite build + functions in `api/`):

| Path | Handler | Upstream |
|---|---|---|
| `/api/snapshot` | `api/snapshot.js` | holdings-svc `/holdings/snapshot`, edge cache s-maxage=60; fallback 307 → static `/tokens-snapshot.json` |
| `/api/holdings` | `api/holdings.js` | holdings-svc `/holdings?addr=` |
| `/api/radar/*` | `api/radar.js` | radar-relay on VPS, then api.radardex.pro direct |
| `/api/logo/:addr` | `api/logo.js` | holdings-svc `/holdings/logo/<a>` |
| `/token/:addr` | `api/token.js` | injects og: meta for share cards (crawler UAs pre-render the image) |
| `/api/og` | `api/og.js` + `lib/livetoken.js` | share-card PNG, reads /api/snapshot then re-prices from the pool |
| `/api/warp/*` | rewrite | warp-arc-production.up.railway.app/api |
| `/api/xdex/*` | rewrite | api.xdex.xyz (XNT price) |

Env on Vercel (private): `HOLDINGS_UPSTREAM`, `HOLDINGS_KEY`, `RADAR_UPSTREAM`, `RADAR_KEY`.

## 2. The browser (what every visitor's tab does)

Every page mounts `App.tsx`, which **always** runs, whatever the page:

| When | What | Cost |
|---|---|---|
| on load | `fetchMarket` — Coinbase spot ×9 + XNT via /api/xdex; USDC=1.00 and EURC=1.08 **hardcoded** (`arc.ts` ~641) | 10 req |
| on load | `fetchScreenerTokens` → `/api/snapshot` (**all ~6,650 tokens**) | 1.14 MB gzip |
| on load | `fetchCuratedV4Tokens` (RPC) | RPC |
| on load | `fetchOnchainScreenerPrices` — top 60 V3/V4 rows re-priced (slot0 / V4 extsload) | ~60+ eth_call |
| every 40 s | `refreshLive` = `fetchRadarTokens(500)` (/api/radar) + `fetchDeepPoolPrices` (RPC) | RPC + radar |
| every 60 s | `load(true)` — the whole list again (1.14 MB) + the top-60 re-price | 1.14 MB + RPC |

Derived client-side in `App.tsx` (the logic that must be reproduced EXACTLY by anything replacing it):
- `canonical` per ticker: score = (ecosystem or PINNED ? 1e18 : 0) + holders·1e9 + liq; `isDup` = `bad` or
  non-canonical duplicate ticker. `MIN_HOLDERS` = 50. `active(t)` = 24h vol ≥ $50 or pinned/core.
- `quality(t)` = not dup + (ecosystem or holders ≥ 50) + active.
- Screener `rows`: filter (all/new=launchpad/eco) → search (every match incl. dups, rank exact>prefix>name>contains,
  then liq) or default (drop dead rows, hide dups, holders ≥ 50 or eco, active unless "show inactive") → sort
  (nulls last), paginate 100/250/500.
- `dashStats`: tracked = all rows; count = quality; vol24 = Σ vol over quality; tvl = Σ liq over not-dup & (eco or
  ≥50 holders); newToday = created < 24h & not dup & active. `launchpadCount`, `launchpadLegend`.
- Home dashboard tabs: trending (quality, by liq, 8), launches (launchpad, not dup, active, newest 8), movers
  (quality, by 24h change, 8). Hero typeahead (7 matches). `swapTokens` (not dup, holders ≥ 50 or eco; pinned →
  active by vol → liq).
- HARD RULES (no junk number): `sanitizeToken` in `src/lib/arc.ts`, the same block in `scripts/snapshot-mainnet.mjs`,
  `sane()` in `lib/livetoken.js`. Display guard `ok()` in the formatters.

## 3. Pages → sections → code → data

| Page (route) | Sections, in order | Component | Data (beyond the App-wide calls above) |
|---|---|---|---|
| Home `/` | ticker · nav · hero (random lava 1–4, search+typeahead, trust strip) · Arc market stats (tracked, DEX liq, 24h vol, active) · dashboard (Top Liquidity / New / Movers, 8 rows) · Full Board CTA · X1 City promo · footer | `App.tsx` (+`Disclaimer`, `VisitCounter` → abacus.jasoncameron.dev) | derived only |
| Screener `/screener` | head + Refresh · 8 stat tiles · filter tabs (All/Launchpad/Ecosystem/Trending/Gainers/Losers) · search · sort · Show inactive · Show N duplicates · table (price, 1h, 24h, vol+txns, mcap, liq, holders, age, spark, score, tags) · pager · tag legend | `App.tsx` | derived only |
| Token `/token/:addr` | back · header (Copy link, Post on X, Trade) · 6 tiles + 5m/1h/6h/24h · chart · info card · 24h activity (buys/sells, txns, makers, burned, top 10) · Liquidity & Pool, Pools dropdown, Pool Health, Supply, Calculator · Transactions / Holders tabs | `PremainDetail.tsx`, `PriceChart.tsx` | `fetchOnchainPoolStats`, `fetchAllOnchainPools`, `fetchOnchainDayStats` (24h getLogs scan), `fetchOnchainMakers24`, `fetchPoolTrades` (+ getTransactionByHash per trade), `fetchTokenBurn`, `fetchTokenDecimals`, holders = `fetchRadarHolders` → `fetchTokenHolders` (arc-scan) fallback, `fetchRadarTokenDetail`/`fetchRadarSwaps`, `fetchWarpToken`; chart `fetchPoolCandles` (getLogs) → `fetchWarpCandles` placeholder |
| $STR `/str` | not-launched warning · token facts · roadmap · X1 City video | `TokenPage.tsx` | none of its own |
| Portfolio `/portfolio` | address box + Track / Connect · holdings table · P&L · NFTs · Send | `Portfolio.tsx`, `SendModal.tsx` | `/api/holdings` (`fetchHoldingsOnchain`), `fetchWalletPnl`, `fetchNftHoldings`, radar/warp backups |
| Swap `/swap` | pay/receive card, slippage, Connect · Your Holdings · Recent Transactions · How routing works | `Swap.tsx`, `TokenPicker.tsx`, `src/lib/swap.ts` | quotes: WarpV2 · Warp curve · Uni V3 (SwapRouter02) · Uni V4 (Universal Router), all in parallel, best wins; `/api/holdings`; `fetchAddressTxs` |

## 4. Measured baseline (2026-09-28, desktop 1440, headless, from the owner's machine)

| Page | Content visible | Requests | RPC calls | HTTP 429 | Data downloaded | Console errors |
|---|---|---|---|---|---|---|
| Home | 2.8–4.9 s | ~140 | ~125 | 22–27 | 1.28 MB | 26–30 |
| Screener | 0.4 s (warm) | ~290 | ~275 | 62–67 | 0.11 MB (cached list) | ~130 |
| Token cirBTC | 0.4–1.4 s shell | ~450 | ~600 | 78–98 | **~15 MB** (1 MB getLogs pages) | ~100 |
| Token ARGUS | 0.3–1.0 s shell | ~505 | ~655 | ~79 | ~4 MB | ~100 |
| $STR | 0.3 s | ~130 | ~117 | ~17 | 0.06 MB | 18 |
| Portfolio (no wallet) | — | ~150 | ~138 | ~38 | 0.14 MB | ~40 |
| Swap (no wallet) | — | ~145 | ~130 | ~31 | 0.06 MB | ~32 |
| Home (mobile 390) | 4.2–5.4 s | ~140 | ~125 | ~25 | 1.28 MB | ~27 |

An open tab keeps downloading the 1.14 MB list every 60 s (~68 MB/hour) and re-pricing ~60 pools per minute.

## 5. Known v1 defects on this date (so v2 isn't blamed for them, and so v2 fixes them)

1. Ticker EURC $1.08 hardcoded vs live $1.14 on the board (`arc.ts` ~641).
2. Token page top-10 holders: RadarDEX first; its bad % is clamped to 100 (`PremainDetail.tsx` ~212) — cirBTC showed
   "top 10 hold 100%", Pool Health 41.
3. `compact()` (`arc.ts` ~657) rounds < 1000 to an integer → fractional coin amounts (cirBTC trades) show "0".
4. `normIcon` doesn't rewrite `ipfs://` → ~52 broken logos on the screener.
5. LEADS (unverified): 4,455 rows with liq == mcap exactly (one-sided launch pools valued as depth?); cirBTC mcap >
   FDV; cirBTC pool age 132d vs created 9/15.
6. Hero "24h volume" ($9.9M) vs the raw indexer sum over every row ($76M ≈ DefiLlama's $74M Arc DEX volume) — the gap
   is our quality filter (fake tickers with 7–18 holders "doing" $5–16M). Not a bug; v2 shows both, labelled.
7. Not indexed at all: Aerodrome (Slipstream + Lite), Archery V3, Synthra, Curve, lending (Morpho, Aave).

## 6. Rolling back

- Site: `git revert` the v2 commits, or redeploy the tag in Vercel (Deployments → the tag's deploy → Promote).
- VPS: every v2 service is NEW (new unit names, new dirs, new port); v1 units are not edited. Stopping the v2 units
  leaves v1 exactly as it was. If a v1 file ever does get touched: restore from `~/bt/statera-baseline-2026-09-28/vps/`
  (same paths under `root/` and `etc/systemd/system/`), `systemctl daemon-reload`, restart the unit.
