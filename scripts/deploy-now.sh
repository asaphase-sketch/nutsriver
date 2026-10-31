#!/usr/bin/env bash
# ============================================================================
# NutsRiver — one-shot production deploy + verify.
#   CLOUDFLARE_API_TOKEN=<token> bash scripts/deploy-now.sh
# Does: build → deploy → live verification → prod E2E (gates only).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?Paste a fresh token: dash.cloudflare.com/profile/api-tokens → Create Token (Custom) → Account: Workers Scripts Edit + D1 Edit}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-52eaa8e8f08d38e99d542c2b309663e8}"
BASE="${BASE:-https://royal-felt.aj-poker-app.workers.dev}"

echo "── [1/4] build + deploy ─────────────────────────────────────────"
bun run build > /tmp/nr-build.log 2>&1
bunx wrangler deploy 2>&1 | rg -v "^$" | tail -6

echo "── [2/4] live verification ──────────────────────────────────────"
sleep 4
verdict() { # label, expected, actual
  if [[ "$2" == *"$3"* || "$3" == "$2" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 (got: $3)"; exit 1; fi
}
HOME_HTML=$(curl -s "$BASE/")
# brand renders lowercase in the UI — match case-insensitively
if rg -qi 'nutsriver' <<< "$HOME_HTML"; then echo "  ✓ homepage serves nutsriver"; else echo "  ✗ homepage does not mention nutsriver"; exit 1; fi
if rg -qi 'royal felt' <<< "$HOME_HTML"; then echo "  ✗ homepage still shows old brand"; exit 1; else echo "  ✓ old brand fully gone from homepage"; fi
CODE_ADMIN=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")
[[ "$CODE_ADMIN" == 200 ]] && echo "  ✓ /admin serves (HTTP $CODE_ADMIN)" || { echo "  ✗ /admin HTTP $CODE_ADMIN"; exit 1; }
CODE_LOBBY=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/lobby")
[[ "$CODE_LOBBY" == 200 ]] && echo "  ✓ /api/lobby healthy" || { echo "  ✗ /api/lobby HTTP $CODE_LOBBY"; exit 1; }
CODE_GATE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/overview")
[[ "$CODE_GATE" == 401 ]] && echo "  ✓ admin API gated (anon → 401)" || { echo "  ✗ admin gate HTTP $CODE_GATE"; exit 1; }

echo "── [3/4] production E2E (no passphrase, claim untouched) ────────"
E2E_BASE="$BASE" bun scripts/e2e-workers.ts 2>&1 | tail -8

echo "── [4/4] done ───────────────────────────────────────────────────"
echo "NutsRiver is LIVE: $BASE"
echo "Admin: log in → /admin  (amin / AminA are admins; passphrase not needed)"
