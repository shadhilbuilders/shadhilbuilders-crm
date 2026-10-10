#!/usr/bin/env bash
# Rebuild @shadhil/database, @shadhil/auth, and @shadhil/api-types only when
# their dist entry is missing.
#
# Why skip when present: under `turbo run build`, ^build already emitted these
# packages. Unconditionally `clean && build`-ing them here races with
# @shadhil/backend's `nest build` (web prebuild deletes dist while nest is
# compiling). Docker / bare `pnpm --filter @shadhil/web build` still rebuilds
# because the image starts with no dist/.
set -euo pipefail

# apps/web/scripts → ../.. = apps/web → need ../../.. for repo root
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

missing=0
for rel in \
  packages/database/dist/index.js \
  packages/auth-client/dist/index.js \
  packages/api-types/dist/index.js
do
  if [[ ! -f "$REPO_ROOT/$rel" ]]; then
    echo "[prebuild] missing $rel"
    missing=1
  fi
done

if [[ "$missing" -eq 0 ]]; then
  echo "[prebuild] workspace dists present - skipping package rebuild"
  exit 0
fi

echo "[prebuild] building workspace packages (database → auth + api-types)"
pnpm --filter @shadhil/database build
pnpm --filter @shadhil/auth --filter @shadhil/api-types build
