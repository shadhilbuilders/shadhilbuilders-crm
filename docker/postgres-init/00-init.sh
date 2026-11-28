#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# Shadhil Builders CRM - first-boot roles (postgres:16-alpine entrypoint).
# ────────────────────────────────────────────────────────────────────────────
# WHY A SHELL SCRIPT: the previous file was 00-init.sql, which cannot read
# environment variables, so it carried the app role's password as a literal. That
# literal was the same string as POSTGRES_PASSWORD in every deployment we have, so
# a container holding DATABASE_URL could log in as the bootstrap superuser. Role
# separation with one shared secret separates nothing.
#
# FAIL CLOSED: no default password. A missing or empty SHADHIL_APP_PASSWORD stops
# the container at init rather than creating a role nobody can rotate safely. For a
# throwaway local stack docker-compose.yml supplies a dev default; production must
# supply a real one from Coolify.
set -euo pipefail

: "${SHADHIL_APP_PASSWORD:?SHADHIL_APP_PASSWORD must be set: it is the app role password, and it must not be the bootstrap superuser password. Set it in docker-compose.yml (local) or in Coolify (production).}"
: "${SHADHIL_OWNER_PASSWORD:?SHADHIL_OWNER_PASSWORD must be set: it is the migration owner's password (docs/planning/OWNER-ROLE-MIGRATION.md).}"
: "${SHADHIL_SEED_PASSWORD:?SHADHIL_SEED_PASSWORD must be set: it is the seed role's password.}"

# Every role gets its own secret. A split that shares one password moves labels, not
# risk, which is what the previous version of this file did.
for pair in "SHADHIL_APP_PASSWORD:${SHADHIL_APP_PASSWORD}" \
            "SHADHIL_OWNER_PASSWORD:${SHADHIL_OWNER_PASSWORD}" \
            "SHADHIL_SEED_PASSWORD:${SHADHIL_SEED_PASSWORD}"; do
  name=${pair%%:*}
  value=${pair#*:}
  if [ "$value" = "${POSTGRES_PASSWORD:-}" ]; then
    echo "refusing to initialise: $name equals POSTGRES_PASSWORD, which is the hole this change closes." >&2
    exit 1
  fi
done

if [ "${SHADHIL_OWNER_PASSWORD}" = "${SHADHIL_APP_PASSWORD}" ] \
  || [ "${SHADHIL_OWNER_PASSWORD}" = "${SHADHIL_SEED_PASSWORD}" ] \
  || [ "${SHADHIL_APP_PASSWORD}" = "${SHADHIL_SEED_PASSWORD}" ]; then
  echo "refusing to initialise: the three role passwords must be distinct." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_password="$SHADHIL_APP_PASSWORD" \
  -v owner_password="$SHADHIL_OWNER_PASSWORD" \
  -v seed_password="$SHADHIL_SEED_PASSWORD" \
  -f "$(dirname "$0")/sql/00-roles.sql"
