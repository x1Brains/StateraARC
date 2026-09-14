#!/usr/bin/env bash
# Fully regenerate the StateraArc token snapshot: list -> holders + launchpad -> prices.
# One command, safe to run on a cron. Only needs node (the scripts use fetch + fs, no deps).
set -e
cd "$(dirname "$0")/.."

echo "[refresh] $(date -u +%FT%TZ) — rebuilding snapshot"
ENRICH=1 ENRICH_MAX="${ENRICH_MAX:-300}" node scripts/snapshot.js "${MAX:-500}"
PRICE_MAX="${PRICE_MAX:-200}" node scripts/prices.js
echo "[refresh] done $(date -u +%FT%TZ) — $(node -e "const j=require('./public/tokens-snapshot.json');console.log(j.count+' tokens, '+j.tokens.filter(t=>t.price!=null).length+' priced')")"
