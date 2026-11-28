# Production cutover: the owner split

Runbook for taking `shadhil` (the cluster's bootstrap superuser) out of the runtime path on
the Shadhil Builders CRM production database. Companion to
`docs/planning/OWNER-ROLE-MIGRATION.md`, which records why the split exists and why the
first version of the plan was wrong.

Status: **rehearsed against a restore of the production dump on 2026-11-28, not run on
production.** The scripts are `scripts/prod/owner-cutover.sql`,
`scripts/prod/owner-rollback.sql`, `scripts/prod/owner-state.sql`, and the rehearsal driver
`scripts/prod/rehearse-owner-cutover.sh`.

## What production looks like today, measured

    41 relations, 55 functions (19 SECURITY DEFINER), 28 enum types, 158 policies
    124 migrations applied, 81 MB database, 74 GB free on the VPS
    roles: shadhil (superuser, bypass, login), shadhil_app (no super, no bypass, login),
           studio_ro (no super, no bypass, login)

`studio_ro` was not in the plan. It exists because something reads this database for
reporting. It holds SELECT on all 41 tables, granted by `shadhil`. The cutover preserves it
because `ALTER ... OWNER` keeps grantees, and the rollback restores it explicitly because
`DROP OWNED BY` would otherwise take it away.

## What changes

    before                                  after
    shadhil  owns all 41 tables, 55 fns     shadhil_owner owns tables, sequences, views, types
                                            shadhil_rls   owns the 19 DEFINER helpers
                                            shadhil_seed  owns nothing, logs in, bypasses RLS
    public schema owned by pg_database_owner  owned by shadhil_owner
    database owned by shadhil               owned by shadhil_owner
    DIRECT_DATABASE_URL -> shadhil          -> shadhil_owner
    (no seed URL)                           SEED_DATABASE_URL -> shadhil_seed
    PUBLIC can call every helper            PUBLIC can call none of them; app, owner and seed
                                            hold explicit EXECUTE

The app role, its password, PgBouncer, and every policy stay exactly as they are. Nothing in
the request path moves. What moves is which credential owns the schema.

## Preconditions

1. A fresh dump, taken with `pg_dump -Fc`, stored off the VPS, and restorable.
2. `scripts/prod/rehearse-owner-cutover.sh` passing against that dump.
3. A maintenance window of about ten minutes. The SQL takes under a second; the container
   recreate and the smoke checks are what take the time.
4. The two new passwords generated on the VPS, written with `umask 077`, never printed.

## Sequence

Every step names its checkpoint. Do not continue past a failed checkpoint.

### 1. Dump

    ssh root@187.126.115.174 \
      'docker exec shadhil-postgres-0bjahklz8gtdtr4do4r7ae6m \
         pg_dump -U shadhil -d shadhil_crm -Fc' > /root/shadhil-pre-cutover.dump
    ls -l /root/shadhil-pre-cutover.dump     # checkpoint: nonzero, close to 3.5 MB compressed

Restore it into a throwaway container and run the rehearsal against it before touching
production. A dump nobody restored is not a backup.

### 2. Passwords

    umask 077
    openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 > /root/.shadhil-owner-pw
    openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 > /root/.shadhil-seed-pw
    wc -c /root/.shadhil-owner-pw /root/.shadhil-seed-pw   # checkpoint: 25 each (trailing newline)

### 3. Cutover SQL

    docker cp scripts/prod/owner-cutover.sql shadhil-postgres-0bjahklz8gtdtr4do4r7ae6m:/tmp/
    docker exec shadhil-postgres-0bjahklz8gtdtr4do4r7ae6m \
      psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 \
           -v owner_password="$(cat /root/.shadhil-owner-pw)" \
           -v seed_password="$(cat /root/.shadhil-seed-pw)" \
           -v backup_seen=yes -f /tmp/owner-cutover.sql

Checkpoint, printed by the script itself:

    NOTICE:  cutover proven: 0 relations on shadhil, 19 of 19 helpers on shadhil_rls

If the NOTICE does not appear, the script raised and nothing after section 7 ran. The
database is then in a partially moved state and the rollback script is the way back.

### 4. Prove the owner credential over TCP before anything restarts

`docker exec ... psql` is authenticated by `trust` on localhost and proves nothing about a
password. Test from another container on the same network:

    docker run --rm --network 0bjahklz8gtdtr4do4r7ae6m \
      -e PGPASSWORD="$(cat /root/.shadhil-owner-pw)" postgres:16-alpine \
      psql -h shadhil-postgres -p 5432 -U shadhil_owner -d shadhil_crm -tAc 'select current_user'

Checkpoint: prints `shadhil_owner`. If it fails, fix the password before going further;
every step after this depends on the api container authenticating as this role.

### 5. Coolify env

Add two variables to the service, then change the direct URL. Order matters: the new URL
must be valid when the container starts.

    SHADHIL_OWNER_PASSWORD   <contents of /root/.shadhil-owner-pw>
    SHADHIL_SEED_PASSWORD    <contents of /root/.shadhil-seed-pw>
    DIRECT_DATABASE_URL      postgresql://shadhil_owner:${SHADHIL_OWNER_PASSWORD}@shadhil-postgres:5432/shadhil_crm?schema=public
    SEED_DATABASE_URL        postgresql://shadhil_seed:${SHADHIL_SEED_PASSWORD}@shadhil-postgres:5432/shadhil_crm?schema=public

The compose file is patched through `docker_compose_raw`, and that field is **base64**:
send `{"docker_compose_raw": base64.b64encode(raw)}`. A plain-text body is silently ignored,
which was measured on 2026-11-28 and cost an hour.

### 6. Recreate the api container, and only that

    docker compose -p 0bjahklz8gtdtr4do4r7ae6m up -d --force-recreate shadhil-api

`POST /api/v1/deploy` can answer `200 Service service-crm started` without recreating
anything. Use the compose command and check the container's start time.

Checkpoints, in order:

    docker inspect shadhil-api-0bjahklz8gtdtr4do4r7ae6m --format '{{.State.StartedAt}}'
    curl -s -o /dev/null -w '%{http_code}\n' https://api.crm.shadhilbuilders.in/api/health
    docker logs --since 5m shadhil-api-0bjahklz8gtdtr4do4r7ae6m 2>&1 | grep -ci 'prisma\|P1000\|permission denied'

Expected: a start time in the last minute, `200`, and `0`.

### 7. Confirm and record

    docker cp scripts/prod/owner-state.sql shadhil-postgres-0bjahklz8gtdtr4do4r7ae6m:/tmp/
    docker exec shadhil-postgres-0bjahklz8gtdtr4do4r7ae6m \
      psql -U shadhil -d shadhil_crm -q -f /tmp/owner-state.sql > /root/state-post-cutover.txt

Compare against the pre-cutover copy taken in step 1. Expected differences: the three
`role` lines, `rel`/`type` moving to `shadhil_owner`, `fn` splitting 36/19, schema and
database owner, and every `tbl` line's grantee. Nothing else.

## Rollback

Triggers, in order of severity: the api does not come back after step 6; a smoke check shows
the app reading the wrong rows or none; any `permission denied` in the api log that is not
explained by a policy.

    docker exec shadhil-postgres-0bjahklz8gtdtr4do4r7ae6m \
      psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 -f /tmp/owner-rollback.sql

Checkpoint:

    NOTICE:  rollback proven: 41 tables back on shadhil, app holds SELECT on 40 of them

Then point `DIRECT_DATABASE_URL` back at `shadhil` with `PG_PASSWORD` and recreate the api
container again, and re-run `owner-state.sql` for the diff.

Measured on the rehearsal: cutover 208 ms, rollback 206 ms, table privileges byte-identical
to the pre-cutover fingerprint.

### What the rollback does not restore

- **PUBLIC EXECUTE on the SECURITY DEFINER helpers.** The cutover revoked it and the
  rollback does not put it back. The app keeps an explicit grant, so access is unchanged for
  the only role that matters, and every role with schema access loses reach into a helper
  that reads across tenants. That is a tightening worth keeping even when everything else
  is being undone.
- **Explicit ACL entries for functions that previously had none.** A function with a null
  `proacl` has an implicit "owner plus PUBLIC" ACL; after the round trip it has an explicit
  one listing the same grantees. Same access, different representation, which shows up in the
  fingerprint diff and is not a regression.

### Why the rollback needs the cutover's ACL record

`ALTER ... OWNER TO` rewrites the **grantor** of every ACL entry to the new owner. So once
ownership moves, `shadhil_app`'s table privileges belong to `shadhil_owner`, and a plain
`DROP OWNED BY shadhil_owner` takes them away with it. The first version of this rollback
compensated with a blanket `GRANT ... ON ALL TABLES`, which was worse than the problem: it
gave the app DELETE on three tables that never had it and full CRUD on `_prisma_migrations`.
Measured in the rehearsal, then fixed by recording `(object, grantee, privileges)` in
`public._owner_split_acl` before the walk and replaying that record on the way back.

## Hard calls

1. **Migrations run as the owner, and a migration that touches rows must borrow the seed.**
   A non-bypass owner cannot INSERT into a FORCEd table at all, and its UPDATE silently
   touches zero rows. Nine historical migrations contain INSERT, and applied migrations
   cannot be edited while production exists, so a fresh install migrates as the bootstrap
   superuser and hands over afterwards. `migration-dml-guard.test.ts` fails a post-cutover
   migration that touches rows without `SET LOCAL ROLE shadhil_seed;`.
2. **The test harness stays on `shadhil`.** It needs bypass and ownership at the same time
   (`ALTER TABLE ... DISABLE TRIGGER` in the consent repair test), and no non-superuser role
   has both. Closing that needs a fourth cross-tenant credential, which is a decision, not a
   refactor.
3. **One more cross-tenant role than the plan counted.** `shadhil_seed` bypasses RLS and logs
   in. It exists because the seed writes across every tenant and a bypass role is the
   supported way to do that. `owner-roles.test.ts` names all three so a fourth is a test
   failure rather than a discovery.
4. **`shadhil` stays a superuser.** It cannot be demoted: initdb requires the bootstrap role
   to keep SUPERUSER. The point of the split is that nothing in the request path connects as
   it, not that it stops existing.
