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
- 2026-09-28: phase 0 done. Phase 1 in progress.
