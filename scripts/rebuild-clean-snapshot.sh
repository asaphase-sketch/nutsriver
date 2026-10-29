#!/usr/bin/env bash
# Rebuild the parentless clean snapshot branch (clean-main) from main,
# excluding sandbox-internal artifacts. Same procedure as Tasks 2-6.
#   clean snapshot = single-commit branch, no history, no secrets, no junk
set -euo pipefail
cd "$(dirname "$0")/.."

TMP_INDEX="$(mktemp /tmp/royal-felt-index.XXXXXX)"
trap 'rm -f "$TMP_INDEX"' EXIT
export GIT_INDEX_FILE="$TMP_INDEX"

# start from main's tree
git read-tree main

# strip sandbox-internal artifacts (never ship these)
TO_UNTRACK="$(git ls-tree -r main --name-only | grep -E '^(\.zscripts/|download/|tests/|examples/|worklog\.md$|Caddyfile$|ci[0-9]*\.txt$|job-logs|run-logs|run[0-9]+-logs)' || true)"
if [ -n "$TO_UNTRACK" ]; then
  echo "$TO_UNTRACK" | while IFS= read -r f; do git rm --cached -q "$f"; done
fi

TREE=$(git write-tree)
COMMIT=$(git commit-tree "$TREE" -m "NutsRiver — play-money poker on Cloudflare Workers

Server-authoritative poker: No-Limit Hold'em + Omaha 4/5 + a full tournament
system (SNG/MTT, turbo levels, knockout bounties, freerolls). Durable Object
per table/tournament with WebSocket hibernation + durable alarms, D1 chip
ledger with atomic guarded updates, PBKDF2 + HMAC session auth, crypto-secure
shuffling, house bots with admin policy control, 2.5D graphics and synthesized
WebAudio sounds. Next.js static export served by the Worker; CI runs lint,
strict typechecks, engine fuzz tests, and a full E2E over raw WebSocket.

Play-money only — chips have no cash value. See README.")
git branch -f clean-main "$COMMIT"
echo "clean-main rebuilt at: $COMMIT"
git ls-tree -r clean-main --name-only | wc -l
