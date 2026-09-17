#!/usr/bin/env bash
# T-TEST-DB-ISOLATION (2026-09-16): create + migrate + seed `shadhil_crm_test`.
#
# WHY: every DB-backed suite previously connected to the DEVELOPMENT database
# (the URLs in the repo-root `.env`). Nothing isolated them, so test fixtures wrote
# real rows there - 141 project-less `Lead` rows accumulated in three days, and dev
# data drifted away from the canonical seed.
#
# This script builds a disposable database with the FULL schema, including the RLS
# policies (they are applied by the Prisma migrations, so `migrate deploy` is
# enough - there is no separate policies step), plus the baseline seed the suites
# expect (a single OWNER row, teams, projects).
#
# Run it whenever the schema or seed changes, and after any failed test run:
#   pnpm db:test:reset
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found - cannot resolve the postgres connection." >&2
  exit 1
fi

# Read the two URLs without echoing them (they contain the DB password).
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${DIRECT_DATABASE_URL:?DIRECT_DATABASE_URL must be set in .env}"

strip_query() { printf '%s' "${1%%\?*}"; }

DEV_URL="$(strip_query "$DIRECT_DATABASE_URL")"
DEV_DB="${DEV_URL##*/}"
TEST_DB="${DEV_DB}_test"
ADMIN_URL="${DEV_URL%/*}/postgres"
TEST_URL="${DEV_URL%/*}/${TEST_DB}"

# Refuse to operate on anything that already looks like a test database: this
# script DROPS the target. Cheap safety, and it keeps the guard honest.
if [[ "$DEV_DB" == *_test ]]; then
  echo "error: .env already points at a test database (${DEV_DB}); refusing to drop it." >&2
  exit 1
fi

echo "== test database: ${TEST_DB} (derived from ${DEV_DB})"

PSQL_ADMIN="psql ${ADMIN_URL} -v ON_ERROR_STOP=1 -q"
# A connection URL passed to `-d` is treated as a DATABASE NAME, not a conninfo
# string - use the separate `-d <url>` form instead.
psql_test() { psql "$TEST_URL" -v ON_ERROR_STOP=1 -q "$@"; }

# --- 1. (Re)create. Dropping first guarantees a clean slate: a fixture database
#        that accumulates state stops reproducing bugs, which is the failure mode
#        that would make this whole exercise pointless.
echo "-- recreating"
# Terminate other sessions so DROP cannot hang on a stale connection.
$PSQL_ADMIN -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid();" >/dev/null
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS \"${TEST_DB}\";"
# Created by the OWNER role (the migration GRANTs to the non-owner app role).
$PSQL_ADMIN -c "CREATE DATABASE \"${TEST_DB}\";"

# --- 2. Migrate. The migrations carry the RLS policies, so this produces the same
#        schema the dev database has, FORCE ROW LEVEL SECURITY included.
echo "-- applying migrations"
cd "$REPO_ROOT/packages/database"
DIRECT_DATABASE_URL="$TEST_URL" DATABASE_URL="$TEST_URL" \
  pnpm exec prisma migrate deploy

# --- 3. Seed. Idempotent upserts; needed because a couple of suites resolve the
#        single seeded OWNER row rather than creating their own.
echo "-- seeding"
DIRECT_DATABASE_URL="$TEST_URL" DATABASE_URL="$TEST_URL" \
  pnpm exec tsx src/seed.ts >/dev/null

# --- 4. Verify: the guard in src/test-db-isolation.ts refuses to run without a
#        `_test` name, and the suites need RLS actually enabled.
echo "-- verifying"
psql_test -c "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relforcerowsecurity;" -t | sed 's/^ */   FORCE RLS tables: /'
psql_test -c "SELECT count(*) FROM \"User\" WHERE role = 'OWNER';" -t | sed 's/^ */   seeded OWNER rows: /'

echo "== ${TEST_DB} ready. Tests connect here automatically (see src/test-db-isolation.ts)."
