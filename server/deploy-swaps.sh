#!/usr/bin/env bash
# Install / update the swap indexer on the VPS (run ON the VPS, after server/deploy-api.sh has updated /root/statera-api-repo).
# Additive: own dir, own unit, own DB. Stopping it leaves the site exactly as before (the API falls back to its old scan).
set -euo pipefail
SRC=/root/statera-api-repo APP=/root/statera-swaps/app
mkdir -p "$APP/server" "$APP/scripts/lib"
cp "$SRC/server/swap-db.ts" "$SRC/server/swap-indexer.ts" "$APP/server/"
cp "$SRC/scripts/lib/multicall.mjs" "$APP/scripts/lib/"
[ -f "$APP/package.json" ] || echo '{"type":"module"}' > "$APP/package.json"
if ! node --no-warnings "$SRC/scripts/tscheck.mjs" "$APP/server/swap-indexer.ts" "$APP/server/swap-db.ts"; then echo "[deploy-swaps] ABORTED: does not parse"; exit 1; fi
cp "$SRC/server/statera-swaps.service" /etc/systemd/system/statera-swaps.service
systemctl daemon-reload && systemctl enable -q statera-swaps && systemctl restart statera-swaps
sleep 5; systemctl is-active statera-swaps; journalctl -u statera-swaps -n 5 --no-pager
