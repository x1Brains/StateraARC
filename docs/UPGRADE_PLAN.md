# StateraArc v2 — the data upgrade plan (started 2026-09-28)

Goal: the browser stops doing the indexer's work. One server process reads the chain once and every visitor reads
small, precomputed answers — faster pages, no RPC 429 storms, and room to show MORE of Arc (all DEXes, lending,
network stats) without making the page heavier. Built to last: one implementation of every rule, typed API, raw data
kept so logic changes are recomputed, not re-scraped. v1 is frozen and mapped in `docs/v1-baseline/BASELINE_V1.md`.

## Rules for the upgrade
1. **Additive only.** v2 = new files, new VPS units, new port, new funnel path. v1 units/files are not edited, so
   stopping v2 = v1 exactly as it was.
2. **The site never depends on v2 alone.** Every v2 call in the browser falls back to the v1 path on error/timeout.
3. **Prove identical data before switching** (`scripts/regress/board-ab.mjs`): same snapshot in → same board, same
   stats, same dashboard tabs out, row for row. Then `scripts/regress/crawl.py` + `compare.py` vs the v1 baseline:
   no missing section, fewer requests/RPC/bytes.
4. **Hard rules in ONE place** once v2 serves the numbers (today they're copied 3×).
5. On-chain is primary. RadarDEX / Warp only fill gaps.

## Target shape

```
Arc chain ──(ws newHeads + getLogs; HyperSync for backfill)──► indexer (v2: Ponder + Postgres, phase 3)
                                                                   │  raw events kept: swaps, transfers, pools,
                                                                   │  liquidity, CCTP/Gateway, lending
                                                                   ▼
                                                   statera-api (VPS, :8790, funnel /v2)
                                                   /v2/home /v2/board /v2/search /v2/token/:a
                                                   /v2/token/:a/{trades,candles,holders,stats}  /v2/chain  /v2/swap-tokens
                                                                   │  edge-cached by Vercel /api/v2/*
                                                                   ▼
                                                   browser: renders; talks to the chain only to sign / quote swaps
```

## Phases

**Phase 0 — baseline (done 2026-09-28).** Tag `v1-baseline-2026-09-28`, VPS copy, map, measured crawl, harness.

**Phase 1 — the API in front of today's data.**
- `src/lib/board.ts`: the screener/dashboard/stats logic moved out of `App.tsx` as pure functions (no behaviour
  change; A/B-proven identical). The same file runs in the browser and on the server (Node 22 strip-types).
- `server/statera-api.mjs` (VPS unit `statera-api.service`, :8790, funnel `/v2`): watches the live snapshot, does
  the live re-price ONCE server-side (top on-chain pools every 20 s, RadarDEX as gap-filler), precomputes the board.
- `api/v2.js` (Vercel): proxy + edge cache (10–15 s).
- Browser: home + screener read `/api/v2/home` and `/api/v2/board` pages (KBs instead of 1.14 MB/min); search via
  `/api/v2/search`; the 40 s / 60 s polling loops read v2 deltas. Falls back to v1 on any failure.

**Phase 2 — token page server-side.** 24h stats, makers, trades, candles, holders computed on the VPS and cached per
token (one scan serves every visitor) → the token page drops from ~600 RPC calls / 15 MB to a handful of API calls.
Holders from chain/arc-scan first, RadarDEX last.

**Phase 3 — the real indexer.** Ponder + Postgres (TypeScript, self-hosted, no vendor lock). Stores raw events;
candles/24h/holders/pools are derived tables. Runs next to v1's indexer until its numbers match token by token, then
v1's indexer and snapshot timers are retired. ⛔ The current VPS has 3 GB RAM and runs the real-money Arc grid bot —
Postgres + Ponder should get their own small VPS (owner decision: ~€5–8/month) rather than squeeze that box.

**Phase 4 — more of Arc.**
- Venues: Aerodrome Slipstream (V3 fork) + Aero Lite (V2 fork), Archery V3, Synthra, Curve, Sushi — config entries.
- Lending: Morpho Blue + Aave V4 markets (supply/borrow/TVL) — the $469M of Arc TVL we don't show today.
- Market line: "Arc DEX volume (all pools) $X · real (quality-filtered) $Y" — both, labelled.
- Network page: block time, TPS, txs, active wallets, fees in USDC, USDC/EURC supply on Arc, CCTP + Gateway in/out
  flows, the validator set (Circle + 11 institutions; per-validator block stats only if the chain exposes the
  proposer — to be checked).

## Status log
- 2026-09-28 — **phase 0 done**: tag `v1-baseline-2026-09-28`, VPS copy, map, crawl, harness.
- 2026-09-28 — **4 v1 bugs fixed**: live EURC ticker, fractional amounts, holder shares from on-chain supply (arc-scan
  first), ipfs:// logos.
- 2026-09-28 — **phase 1 done + live**: `src/lib/rules.ts` / `live.ts` / `board.ts` shared by browser and server
  (A/B: 735 checks, 0 differences; render A/B identical); `server/statera-api.ts` on the VPS (`statera-api.service`,
  :8790, funnel `/v2`, own clone `/root/statera-api-repo`, deploy = `ssh x1b-prod 'bash -s' < server/deploy-api.sh`);
  `api/v2.js` proxy; App reads v2 with automatic v1 fallback (`?data=v1` forces v1).
- 2026-09-28 — **phase 2 done + live**: token page chain data (`/v2/token/:a/detail`) and chart candles
  (`/v2/token/:a/candles`) computed once on the VPS with the page's own arc.ts functions; the page re-reads every 10 s.

- 2026-09-29 — **first-visit speed + logos**: a token page nobody had opened (server cache cold) took 5–20 s — one quiet
  token's trade scan walked 900k blocks for 16 s and found nothing. The scan now stops after ~3.5 s while a visitor waits
  and finishes in the background (page picks it up on its 10 s re-read); makers24 runs in parallel. Cold: 5.4–19.7 s →
  2.8–7.3 s (A/B on 5 cold tokens: same data). Logos: 355 cached logos as static WebP in `public/l` (+ `index.json` baked
  into the bundle), regenerated by the VPS with its 6h snapshot commit — screener logo median 1.18 s → 0.19 s.
  What's left of a cold visit is the public RPC's burst limit (~30 calls) on the ~8 parallel lookups → phase 3.
- 2026-09-29 — **wallet picker** (EIP-6963): our own list of installed Arc-capable wallets, deduped, Solana-first
  wallets (Backpack/Phantom/…) hidden; swaps/sends go to the picked wallet (`activeEth()`), not whoever owns
  `window.ethereum` (Rabby was showing its own picker with Backpack twice).

Measured on the live site (desktop, headless), v1 baseline → v2:

| Page | RPC calls | Data | Rate-limit errors |
|---|---|---|---|
| Home | 124 → **0** | 1.28 MB → **20 KB** | 22 → 0 |
| Screener | 270 → **52** (logos not yet in the VPS cache) | 0.11 → 0.07 MB | 67 → 0 |
| Token cirBTC | ~400–600 → **1–2** | 15–17 MB → **0.6–1.3 MB** | ~90 → 0 |
| Token ARGUS | ~455–655 → **1** | 4–6 MB → **1.1 MB** | ~80 → 0 |
| $STR / Swap / Portfolio | ~117–139 → **0** | — | → 0 |

Known trade-offs / next:
- Token page trades are ~10–40 s behind (server recompute every 10 s, stale copy ≤ 2 min on first paint); v1 was live
  at open but frozen after. Real-time needs phase 3 (websocket-fed swaps).
- Portfolio page downloads the full live list (1.15 MB) to price holdings — switch to `/v2/tokens?addrs=` from the bag.
- ⛔ Lesson: the local test proxy bypassed `api/v2.js`, so its allow-list 404'd `/detail` + `/candles` on the live site
  and the page silently fell back to v1. Always verify a new endpoint THROUGH the Vercel proxy on the live site.
