#!/usr/bin/env bash
# Rehearse the production owner cutover and its rollback against a restore of the
# production dump. Touches nothing real: a throwaway container on port 5499.
#
# Proves four things, in order, and fails loudly if any of them is untrue:
#   1. the cutover moves every object and leaves no helper behind
#   2. the app role still reads its own tenant and still sees nothing without a context
#   3. the migration owner is genuinely bound by FORCE RLS while the seed role is not
#   4. the rollback returns the database to its pre-cutover privileges, not to a guess
#
# Usage: scripts/prod/rehearse-owner-cutover.sh [path-to-dump]
# Default dump: ~/.hermes/cache/scratch/prod-rehearsal.dump
set -euo pipefail

DUMP="${1:-$HOME/.hermes/cache/scratch/prod-rehearsal.dump}"
CTR=shadhil-prod-rehearsal
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

say() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -f "$DUMP" ] || fail "no dump at $DUMP; take one with: ssh root@host 'docker exec <pg> pg_dump -U shadhil -d shadhil_crm -Fc' > $DUMP"

say "fresh container from the dump"
docker rm -f "$CTR" >/dev/null 2>&1 || true
# No published port on purpose: every probe below runs inside the container, and a bound
# host port makes a re-run race the previous container's shutdown ("database system is
# shutting down" from a postgres that is already dead but still answering on the port).
sleep 2
docker run -d --name "$CTR" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_USER=shadhil \
  -e POSTGRES_DB=shadhil_crm postgres:16-alpine >/dev/null
ready=0
for _ in $(seq 60); do
  if docker exec "$CTR" psql -U shadhil -d shadhil_crm -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = "1" ] || fail "rehearsal postgres never became ready"
# The dump carries ACLs for roles that live in the cluster, not in the dump.
docker exec "$CTR" psql -U shadhil -d shadhil_crm -q -c "
  create role shadhil_app login password 'app_rehearsal' nosuperuser nobypassrls;
  do \$\$ begin
    if not exists (select 1 from pg_roles where rolname = 'studio_ro') then
      create role studio_ro login password 'ro_rehearsal' nosuperuser nobypassrls;
    end if;
  end \$\$;"
docker cp "$DUMP" "$CTR:/tmp/p.dump" >/dev/null
docker exec "$CTR" pg_restore -U shadhil -d shadhil_crm --no-owner --role=shadhil /tmp/p.dump >/dev/null 2>&1 || true
for f in owner-state.sql owner-cutover.sql owner-rollback.sql; do
  docker cp "$HERE/$f" "$CTR:/tmp/$f" >/dev/null
done

fingerprint() { docker exec "$CTR" psql -U shadhil -d shadhil_crm -q -f /tmp/owner-state.sql; }

fingerprint > "$SCRATCH/before.txt" 2>&1
[ "$(grep -c ERROR "$SCRATCH/before.txt" || true)" = "0" ] || fail "fingerprint had errors"

OWNER_PW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
SEED_PW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"

say "cutover"
# No `| grep ... || true` here: that swallows a failing cutover and lets the rehearsal report
# success on a database it never changed. Capture, show, then check the status.
set +e
docker exec "$CTR" psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 \
  -v owner_password="$OWNER_PW" -v seed_password="$SEED_PW" -v backup_seen=yes \
  -f /tmp/owner-cutover.sql > "$SCRATCH/cutover.log" 2>&1
cutover_rc=$?
set -e
grep -E 'NOTICE|ERROR' "$SCRATCH/cutover.log" || true
[ "$cutover_rc" = "0" ] || fail "cutover exited $cutover_rc" 

fingerprint > "$SCRATCH/after.txt" 2>&1
grep -q '^rel shadhil_owner ' "$SCRATCH/after.txt" || fail "no relation moved to shadhil_owner"
grep -q '^fn shadhil_rls ' "$SCRATCH/after.txt" || fail "no helper moved to shadhil_rls"
if grep -q '^rel shadhil ' "$SCRATCH/after.txt"; then fail "a relation is still owned by shadhil"; fi

say "app role: sees its tenant with a context, nothing without one"
ORG="$(docker exec "$CTR" psql -U shadhil -d shadhil_crm -tAc \
  "select o.id from \"Organization\" o order by (select count(*) from \"Lead\" l where l.\"organizationId\" = o.id) desc limit 1")"
ADMIN="$(docker exec "$CTR" psql -U shadhil -d shadhil_crm -tAc \
  "select id from \"User\" where \"organizationId\" = '$ORG' and role = 'ADMIN' limit 1")"
EXPECTED="$(docker exec "$CTR" psql -U shadhil -d shadhil_crm -tAc \
  "select count(*) from \"Lead\" where \"organizationId\" = '$ORG'")"
BLIND="$(docker exec -e PGPASSWORD=app_rehearsal "$CTR" psql -h 127.0.0.1 -U shadhil_app -d shadhil_crm -tAc 'select count(*) from "Lead"')"
[ "$BLIND" = "0" ] || fail "app role saw $BLIND leads with no RLS context"
SEEN="$(docker exec -e PGPASSWORD=app_rehearsal "$CTR" psql -h 127.0.0.1 -U shadhil_app -d shadhil_crm -tAc "
  begin;
  select set_config('app.user_id','$ADMIN',false), set_config('app.user_org_id','$ORG',false), set_config('app.user_role','ADMIN',false);
  select count(*) from \"Lead\";
  rollback;" | grep -E '^[0-9]+$' | tail -1)"
[ "$SEEN" = "$EXPECTED" ] || fail "app role saw $SEEN leads with a context, expected $EXPECTED"
printf 'app role: 0 without context, %s with context\n' "$SEEN"

say "FORCE binds the migration owner, and only the seed escapes it"
docker exec -i "$CTR" psql -U shadhil_owner -d shadhil_crm -q -v ON_ERROR_STOP=1 <<'SQL' || fail "could not create the probe table as the owner"
CREATE TABLE "_rehearsal_probe" (id text primary key, org text);
ALTER TABLE "_rehearsal_probe" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_rehearsal_probe" FORCE ROW LEVEL SECURITY;
CREATE POLICY "_rehearsal_probe_sel" ON "_rehearsal_probe" FOR SELECT
  USING (org = current_setting('app.user_org_id', true));
SQL
# Assert on the exit status, not on the error text: grepping for "row-level security"
# reports a missing table as a passing FORCE test, which is how this check lied once.
if docker exec "$CTR" psql -U shadhil_owner -d shadhil_crm -tAc \
     "insert into \"_rehearsal_probe\" values ('a','x')" >/dev/null 2>&1; then
  fail "the migration owner wrote through a FORCEd policy"
else
  printf 'owner: refused by FORCE, as designed\n'
fi
docker exec "$CTR" psql -U shadhil_seed -d shadhil_crm -tAc \
  "insert into \"_rehearsal_probe\" values ('b','y')" >/dev/null 2>&1 || fail "seed could not write"
docker exec "$CTR" psql -U shadhil_owner -d shadhil_crm -q -c 'DROP TABLE "_rehearsal_probe";'

say "rollback"
set +e
docker exec "$CTR" psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 \
  -f /tmp/owner-rollback.sql > "$SCRATCH/rollback.log" 2>&1
rollback_rc=$?
set -e
grep -E 'NOTICE|ERROR' "$SCRATCH/rollback.log" || true
[ "$rollback_rc" = "0" ] || fail "rollback exited $rollback_rc" 

fingerprint > "$SCRATCH/rolledback.txt" 2>&1
if grep -qE '^rel (shadhil_owner|shadhil_rls|shadhil_seed) ' "$SCRATCH/rolledback.txt"; then
  fail "a relation is still owned by a split role after rollback"
fi

say "privileges after rollback versus before the cutover"
# Function ACLs are expected to differ in one direction: PUBLIC no longer reaches a DEFINER
# helper, and the app now holds an explicit grant instead. Everything table-shaped must match.
diff <(grep '^tbl ' "$SCRATCH/before.txt") <(grep '^tbl ' "$SCRATCH/rolledback.txt") \
  && printf 'table privileges: identical\n' \
  || fail "table privileges differ after rollback (see diff above)"

say "rehearsal passed"
echo "dump:        $DUMP"
echo "fingerprints: kept in $SCRATCH until exit (re-run with KEEP=1 to inspect)"
if [ "${KEEP:-0}" = "1" ]; then
  mkdir -p "$HOME/.hermes/cache/scratch/rehearsal"
  cp "$SCRATCH"/*.txt "$HOME/.hermes/cache/scratch/rehearsal/"
  echo "copied to ~/.hermes/cache/scratch/rehearsal"
fi
