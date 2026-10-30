#!/usr/bin/env bash
# Build the Cloudflare Worker deployment:
#   1. stash server-only dirs the static export cannot include
#   2. next build (static export → ./out)
#   3. restore stashed dirs
# The Worker (workers/) serves the API + realtime layer instead.
set -euo pipefail
cd "$(dirname "$0")/.."

STASH=.workers-stash
rm -rf "$STASH"
mkdir -p "$STASH"

for path in src/app/api src/pages src/instrumentation.ts src/lib/session.ts src/lib/db.ts; do
  if [ -e "$path" ]; then
    mkdir -p "$STASH/$(dirname "$path")"
    mv "$path" "$STASH/$path"
  fi
done

restore() {
  for path in src/app/api src/pages src/instrumentation.ts src/lib/session.ts src/lib/db.ts; do
    if [ -e "$STASH/$path" ]; then
      mv "$STASH/$path" "$path"
    fi
  done
  rm -rf "$STASH"
}
trap restore EXIT

WORKERS_EXPORT=1 bun run next build

echo "Static export ready in ./out"

