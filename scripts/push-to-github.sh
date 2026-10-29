#!/usr/bin/env bash
# ============================================================================
# NutsRiver — one-command GitHub publisher
#
# Pushes the clean NutsRiver source to GitHub and prints the 2 secrets
# needed to switch on CI auto-deploy.
#
# USAGE (from inside the project root — i.e. where this file lives after
#        unzipping nutsriver-source.zip, or inside the bundle clone):
#
#   GITHUB_TOKEN=github_pat_xxxx bash scripts/push-to-github.sh
#
#   Optional overrides:
#     REPO=nutsriver            (default: nutsriver)
#     OWNER=someuser             (default: derived from the token)
#     DRY_RUN=1                  (show plan, do nothing)
#
# SECURITY: the token is kept in memory only — it is never written to disk,
# never stored in git remotes, and never added to any credential helper.
# Delete it from your shell history afterwards if you typed it inline.
# ============================================================================
set -euo pipefail
export GIT_TERMINAL_PROMPT=0

: "${GITHUB_TOKEN:?Set GITHUB_TOKEN (fine-grained PAT with 'Contents: read/write' on your account)}"
REPO="${REPO:-nutsriver}"
DRY_RUN="${DRY_RUN:-0}"

api() { curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

[[ "$DRY_RUN" == "1" ]] && {
  OWNER="${OWNER:-<derived-from-token>}" REPO="$REPO"
  echo "→ DRY RUN — would publish to https://github.com/$OWNER/$REPO"
  echo "  then push clean snapshot branch 'clean-main' (or fresh init) as 'main'."
  exit 0
}

# --- 1. resolve owner -------------------------------------------------------
OWNER="${OWNER:-}"
if [[ -z "$OWNER" ]]; then
  OWNER=$(api https://api.github.com/user | sed -n 's/.*"login" *: *"\([^"]*\)".*/\1/p' | head -1) || true
  [[ -n "$OWNER" ]] || { echo "✗ Could not resolve account login from token — is the token valid and unexpired?"; exit 1; }
fi
echo "→ Publishing to https://github.com/$OWNER/$REPO"

# --- 2. create the repo if it does not exist --------------------------------
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$OWNER/$REPO")
if [[ "$STATUS" == "404" ]]; then
  echo "→ Repo not found — creating private repo..."
  api -X POST https://api.github.com/user/repos \
    -d "{\"name\":\"$REPO\",\"private\":true,\"has_wiki\":false,\"description\":\"NutsRiver — play-money poker (Hold'em, Omaha 4/5, tournaments) on Cloudflare Workers\"}" \
    > /dev/null && echo "  created."
elif [[ "$STATUS" == "200" ]]; then
  echo "→ Repo exists — will push into it."
else
  echo "✗ Unexpected API status $STATUS checking repo (token expired? wrong scope?)"; exit 1
fi

# --- 3. prepare the tree to push --------------------------------------------
# Case A: we are inside the original workspace and the clean-main branch exists
# Case B: we are in an extracted zip — materialise a fresh git repo
if git rev-parse --verify --quiet refs/heads/clean-main; then
  echo "→ Pushing existing clean snapshot branch 'clean-main' as 'main'..."
  BRANCH="clean-main"
else
  echo "→ Initialising fresh git repo from current directory..."
  [[ -f package.json && -f wrangler.jsonc ]] || { echo "✗ Run this from the project root (package.json + wrangler.jsonc not found)"; exit 1; }
  git init -b main . > /dev/null
  git add -A
  git -c user.email="player@nutsriver.local" -c user.name="NutsRiver" \
    commit -m "NutsRiver — play-money poker on Cloudflare Workers" > /dev/null
  BRANCH="main"
fi

# --- 4. push (token inline = in-memory only, nothing stored) -----------------
git push "https://x-access-token:$GITHUB_TOKEN@github.com/$OWNER/$REPO.git" "+$BRANCH:main"

echo ""
echo "✔ DONE — source is at https://github.com/$OWNER/$REPO"
echo ""
echo "────────────────────────────────────────────────────────────────────────"
echo "LAST STEP — turn on auto-deploy (every green CI run deploys to prod):"
echo "  GitHub → repo → Settings → Secrets and variables → Actions → New secret"
echo ""
echo "  CLOUDFLARE_API_TOKEN  = Cloudflare API token with permissions:"
echo "        Account · Workers Scripts · Edit"
echo "        Account · D1          · Edit"
echo "  CLOUDFLARE_ACCOUNT_ID = your Cloudflare account id"
echo ""
echo "Or set both secrets from the CLI in one go:"
echo "  curl -X PUT -H \"Authorization: Bearer $GITHUB_TOKEN\" \\"
echo "    -d '{\"encrypted_value\":\"...base64+libsodium...\"}'" # (or use `gh secret set`)
echo "────────────────────────────────────────────────────────────────────────"
echo "Live site: https://royal-felt.aj-poker-app.workers.dev"
