#!/bin/sh
# Rebuild @shadhil/database, @shadhil/auth, and @shadhil/api-types only when
# their dist entry - or the generated Prisma client - is missing.
#
# Why skip when present: under `turbo run build`, ^build already emitted these
# packages. Unconditionally `clean && build`-ing them here races with
# @shadhil/backend's `nest build` (web prebuild deletes dist while nest is
# compiling). Docker / bare `pnpm --filter @shadhil/web build` still rebuilds
# because the image starts with no dist/.
#
# Why the generated client is in this list: `prisma generate` used to run
# UNCONDITIONALLY from web's prebuild, which rewrote packages/database/
# src/generated/prisma/ while @shadhil/backend's tsc was compiling against it -
# the backend then reported "Property X does not exist on type 'never'" and
# implicit-any errors across untouched modules (audit, bookings, chat, teams).
# Generation is now owned by @shadhil/database's own `build` (it runs
# `prisma generate` BEFORE its tsc, because src/index.ts imports the client and
# tsconfig.build.json includes src/generated/**). This script calls that build,
# so the client is produced whenever it is missing - including in the web
# image, which is why checking for it here is what keeps `next build` from
# failing with TS2307 on './generated/prisma/client'.
#
# POSIX sh only: apps/web/Dockerfile builder is node:*-alpine (no bash).
set -eu

# apps/web/scripts → ../.. = apps/web → need ../../.. for repo root
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

missing=0
for rel in \
  packages/database/dist/index.js \
  packages/database/src/generated/prisma/client.ts \
  packages/auth-client/dist/index.js \
  packages/api-types/dist/index.js
do
  if [ ! -f "$REPO_ROOT/$rel" ]; then
    echo "[prebuild] missing $rel"
    missing=1
  fi
done

if [ "$missing" -eq 0 ]; then
  echo "[prebuild] workspace dists present - skipping package rebuild"
  exit 0
fi

echo "[prebuild] building workspace packages (database → auth + api-types)"
pnpm --filter @shadhil/database build
pnpm --filter @shadhil/auth --filter @shadhil/api-types build
