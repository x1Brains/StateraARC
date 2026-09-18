#!/usr/bin/env bash
# Fully regenerate the StateraArc token snapshot: list -> holders + launchpad -> prices.
# One command, safe to run on a cron. Only needs node (the scripts use fetch + fs, no deps).
set -e
cd "$(dirname "$0")/.."

echo "[refresh] $(date -u +%FT%TZ) — rebuilding RICH mainnet snapshot"
# RICH mainnet builder: RadarDEX (server-side, unblocked) + Warp + on-chain deep pools →
# price/liq/mcap/holders/change/volume/sparkline for every token in ONE file.
node scripts/snapshot-mainnet.mjs "${MAX:-500}"
echo "[refresh] done $(date -u +%FT%TZ) — $(node -e "const j=require('./public/tokens-snapshot.json');console.log(j.count+' tokens, '+j.tokens.filter(t=>t.price!=null).length+' priced, '+j.tokens.filter(t=>t.spark).length+' with sparkline')")"
