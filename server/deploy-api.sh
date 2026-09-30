#!/usr/bin/env bash
# Update + restart the v2 API on the VPS from origin/main (run ON the VPS). First run: sets up the clone + unit + funnel.
# v1 is untouched: separate clone, separate unit, separate port (8790), separate funnel path (/v2).
set -euo pipefail
DIR=/root/statera-api-repo
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o ControlPath=none"
if [ ! -d "$DIR/.git" ]; then git clone -q "$(git -C /root/statera-repo remote get-url origin)" "$DIR"; fi
git -C "$DIR" fetch -q origin main && git -C "$DIR" reset -q --hard origin/main
cd "$DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
# Gate (09-30): parse every server file the way the service will run it BEFORE restarting — a syntax error used to take
# the API down (crash loop); now the deploy stops here and the running version keeps serving.
if ! node --no-warnings scripts/tscheck.mjs server/*.ts; then echo "[deploy-api] ABORTED: server code does not parse - the running API was NOT restarted"; exit 1; fi
cp server/statera-api.service /etc/systemd/system/statera-api.service
systemctl daemon-reload && systemctl enable -q statera-api && systemctl restart statera-api
# Funnel path /v2 -> :8790 (adds this one path; / /ns /holdings are left as they are).
tailscale funnel status 2>/dev/null | grep -q '/v2 ' || tailscale funnel --bg --set-path /v2 http://127.0.0.1:8790 >/dev/null
sleep 10
curl -s -m 10 -H "x-relay-key: $(cat /root/holdings-svc/key)" http://127.0.0.1:8790/v2/health; echo
echo "[deploy-api] $(git -C "$DIR" log --oneline -1)"
