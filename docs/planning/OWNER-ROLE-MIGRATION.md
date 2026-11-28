<!-- /autoplan restore point: "/home/paalstack/workspace/shadhil-projects/shadhilbuilders-crm/.gstack/tmp/autoplan/main-autoplan-restore-20261128-093353.md" -->

## Implementation plan

# Owner-role migration: making FORCE RLS mean something

Status: EXECUTED ON DEV 2026-11-28 (W1 to W8, W12 partial). Production is untouched and
still needs W10 in a maintenance window. Two items moved after measurement: W7 (the test
harness stays on the bootstrap superuser, see revision 4) and the fresh-install order. Rev 4.
Related: AR-1 (the FORCE audit), migration `20261128091000_force_rls_remaining`,
`packages/database/test/rls-force.test.ts`, the Access control section of TODOS.md.

## Why this exists

Every RLS table is FORCEd as of 2026-11-28, and the app never connects as the owner
(the runtime uses the pooled `shadhil_app`, which owns nothing). So the invariant is
true and nothing depends on it being false. The gap is narrower and more awkward:
the table owner `shadhil` is the cluster's bootstrap superuser with BYPASSRLS, and a
superuser ignores FORCE. Anything holding `DIRECT_DATABASE_URL` reads every tenant's
rows, all 34 tables, no policy involved.

That is not a live leak today. It is a loaded gun in a drawer: the credential sits
in `.env` files, in the test harness, in Coolify, and in whatever script someone
writes next.

**Revision 3 measured the premise and it does not hold.** Every policy keys off
session GUCs (`app.user_org_id`, `app.user_role`, `app.user_id`), and **zero**
policies reference `current_user`. So the tenant boundary is not a property of the
credential at all: any connection that can run SQL can set those GUCs and read any
tenant. Measured on dev as `shadhil_app`, the non-superuser RLS-enforced runtime
role, with no password escalation:

| Caller                                  | Leads visible |
| --------------------------------------- | ------------- |
| `shadhil_app`, no GUCs                  | 0             |
| `shadhil_app`, GUCs forged for Builders | 31            |
| `shadhil_app`, GUCs forged for Test     | 158           |
| `shadhil_app`, GUCs forged for Demo     | 66            |

This plan therefore does **not** deliver tenant isolation, and no arrangement of
roles will. What it delivers is the removal of cluster-level superuser exposure
(`pg_authid`, `CREATE ROLE`, `COPY ... FROM PROGRAM`, DDL, other databases), which is
real and worth having, but it is a smaller claim than the one this document opened
with. The honest objective is now: "stop every request-path container from holding a
credential that can change policy or read `pg_authid`", not "make FORCE RLS mean
something".

Any plan that claims tenant isolation has to make the tenant identity unforgeable:
a per-tenant login, a signed token verified inside a SECURITY DEFINER function, or a
separate database per tenant. All three are larger than this migration and none is
priced here.

## What is true today, measured on dev 2026-11-28

- `shadhil`: OID 10, `rolsuper = true`, `rolbypassrls = true`. It is the initdb
  bootstrap role (`POSTGRES_USER` in the container), so it owns 242 relations
  (tables, sequences, indexes), 19 functions, 28 enum types, and the `plpgsql`
  extension. It does **not** own `pgcrypto` on dev: this cluster has exactly one
  extension and it is `plpgsql`. The container's `00-init.sql` creates `pgcrypto` on
  a fresh volume, so prod has two.
- 34 tables carry RLS; all 34 are FORCEd.
- All 19 SECURITY DEFINER functions are RLS helpers and all are owned by `shadhil`.
  Two of them write: `advance_project_team_cursor` and `unit_recompute_status` are
  both VOLATILE and both issue DML.
- `shadhil_app`: no superuser, no bypass, owns nothing. Grants only.
- `public` is owned by `shadhil` outright. On a stock PG16 database the public schema
  belongs to `pg_database_owner` and grants USAGE (not CREATE) to PUBLIC; this
  cluster is the anomaly because `00-init.sql` sets an explicit ACL.
- 50 migration files contain DML backfills. They run today as a superuser.
- `pnpm db:migrate` is `prisma migrate dev`. The shadow database URL is derived in
  `packages/database/prisma.config.ts` (`<name>` becomes `<name>_shadow`), with
  `SHADOW_DATABASE_URL` as the override. Prisma 7 has no `datasource` URL in
  `schema.prisma`.
- `createDirectPrismaClient` appears in 22 files, not 40: several of the 40 grep hits
  were re-exports. It reads `DIRECT_DATABASE_URL` at
  `packages/database/src/test-db-isolation.ts:163`.
- Two places set `row_security = off`: `src/seed.ts:249` and
  `scripts/generate-test-data-sql.ts:451`.
- Production publishes no Postgres port: `docker inspect` shows `5432/tcp` with no
  host binding, so the database is reachable only inside the Coolify network and
  through SSH.

## Why the one-line fix does not exist

`ALTER ROLE shadhil NOSUPERUSER` is refused:

```
ERROR: permission denied to alter role
DETAIL: The bootstrap user must have the SUPERUSER attribute.
```

Postgres 15 and later protect the initdb role. Production runs the same image with
the same `POSTGRES_USER`, so it will answer identically. Verified on dev.

The only way to have a non-superuser owner is a different role that owns the
objects, with `shadhil` demoted in practice rather than in attributes: nobody
connects as it, and it exists for `CREATE EXTENSION` and break-glass recovery.

## The trap that decides the design, measured

A two-table probe (own schema, own roles, dropped afterwards) answered one question:
what happens to a SECURITY DEFINER helper when its owner stops being able to bypass
RLS?

| Setup                                                           | Result                              |
| --------------------------------------------------------------- | ----------------------------------- |
| helper owned by a **non**-bypass role, caller scoped to org `a` | 1 row                               |
| same, after moving the helper to a **BYPASSRLS** role           | 2 rows, for org `a` and for org `b` |
| back to the non-bypass owner                                    | 1 row again                         |

No error. That is the problem. The helper does not fail loudly; it silently starts
answering with the caller's own visibility applied to its inner query. For
`project_unit_ids` that is fatal in a way nobody would notice: the function exists
because an engineer "can no longer read the Unit row", so a helper that inherits the
engineer's Unit policy returns exactly the rows it was written to bypass. The
notification inbox would quietly lose its unit names.

Moving the helper to a BYPASSRLS role restores visibility-independence, and needs
grants that are easy to miss: `USAGE` on `public`, and whatever each body touches.

## Target roles

Three new roles, two existing. `shadhil_app` already exists and does not change.

| Role            | Attributes                                | Owns                            | Used by                     |
| --------------- | ----------------------------------------- | ------------------------------- | --------------------------- |
| `shadhil`       | bootstrap superuser, stays as is          | `plpgsql`, `pgcrypto`           | bootstrap, break-glass only |
| `shadhil_owner` | NOSUPERUSER, NOBYPASSRLS, LOGIN, CREATEDB | 242 relations, 28 enums         | migrations, test fixtures   |
| `shadhil_rls`   | NOSUPERUSER, **BYPASSRLS**, NOLOGIN       | the 19 SECURITY DEFINER helpers | definer only, no login      |
| `shadhil_seed`  | NOSUPERUSER, **BYPASSRLS**, LOGIN         | nothing                         | `pnpm seed`, test fixtures  |
| `shadhil_app`   | unchanged                                 | nothing                         | the running apps            |

Four roles can still reach every tenant afterwards: `shadhil` (superuser,
break-glass), `shadhil_owner` (owns the tables, so it can drop a policy or run
`ALTER TABLE ... NO FORCE`), `shadhil_rls` (definer only, no login) and
`shadhil_seed` (login). That is the honest count, and the owner belongs in it:
ownership is policy control, not a lesser privilege than BYPASSRLS. The gain is
that each one now has a name, a purpose and a test, where today a single credential
does every job and nothing enumerates them.

## Revision 4 measured: what executing it on dev changed

Ran W1 to W8 against `shadhil_crm` and `shadhil_crm_test` on 2026-11-28. The scripts are
`scripts/owner-role-bootstrap.sql` (W1 to W3) and `scripts/rls-post-migrate.sql` (W4b).
Result on both databases: zero objects in `public` owned by `shadhil`, 19 of 19 helpers
owned by `shadhil_rls`, `public` owned by `shadhil_owner`.

Five things the plan got wrong or left implicit, each found by running it:

1. **Revoking PUBLIC EXECUTE on the helpers breaks every policy.** A role that queries a
   FORCEd table evaluates its policies, and a policy calls those helpers AS THE CALLER. With
   `REVOKE ALL ... FROM PUBLIC` and a grant only to `shadhil_app`, the backend suite failed
   with `42501 permission denied for function customer_self_phone` on a test that queries as
   the harness role. The grant goes to `shadhil_app`, `shadhil_owner` and `shadhil_seed`.
2. **BYPASSRLS is not privileges.** `shadhil_seed` could not run the seed at all until it
   had `USAGE` on `public` and CRUD on the tables: `42501 permission denied for schema
public` on the first upsert. Same for `shadhil_rls`, which needs table privileges for the
   helper bodies.
3. **A non-bypass owner cannot INSERT into a FORCEd table at all.** Measured with a
   throwaway table: ENABLE, FORCE, a `FOR SELECT USING (false)` policy, then INSERT gives
   `new row violates row-level security policy`. UPDATE on the same table succeeds and
   touches zero rows, which is the silent case W8 predicted. Nine historical migrations
   contain INSERT and seventeen contain UPDATE, and applied migrations cannot be edited
   while production exists.
4. **Therefore the fresh-install order is: migrate as the bootstrap superuser, then hand
   over.** Otherwise migration one cannot replay. Ongoing migrations run as `shadhil_owner`,
   and one that must touch rows borrows the bypass with `SET LOCAL ROLE shadhil_seed;`
   (`GRANT shadhil_seed TO shadhil_owner` is what makes the line legal).
5. **W7 does not work as written.** The harness needs BOTH bypass (cross-tenant purges) and
   ownership (`ALTER TABLE ... DISABLE TRIGGER` in the consent repair test). No non-superuser
   role has both, so `TEST_DIRECT_DATABASE_URL` points at `shadhil` for now, which is exactly
   what the harness used before this change. Closing W7 needs a fourth role that is
   `BYPASSRLS` and a member of `shadhil_owner`, and a decision that a fourth cross-tenant
   credential is acceptable. W14(c) would then expect four names, not three.

Two tests now guard the invariants: `packages/database/test/owner-roles.test.ts` (attributes,
helper ownership, the cross-tenant role set) and `migration-dml-guard.test.ts` (a
post-cutover migration that touches rows must borrow the bypass; proved red with a probe
migration, then green once `SET LOCAL ROLE shadhil_seed;` was added).

## Work items

W1. Create the three new roles in each target database, with `GRANT USAGE, CREATE ON
    SCHEMA public` to `shadhil_owner`. Passwords come from named variables
(`SHADHIL_OWNER_PASSWORD`, `SHADHIL_SEED_PASSWORD`) the way `00-init.sql` already
takes `POSTGRES_PASSWORD`, with a dev default and nothing inlined in code.
On the grant: PG16 gives a new database's public schema USAGE through PUBLIC but
not CREATE, so USAGE alone is enough to read and not enough to migrate.
Verify: `has_schema_privilege('shadhil_owner','public','CREATE')` is true and the
attributes match the table above.

W2. Move the 19 helpers to `shadhil_rls`: `ALTER FUNCTION ... OWNER TO shadhil_rls`
for each, `GRANT EXECUTE ... TO shadhil_app` re-asserted, `REVOKE ALL ... FROM
    PUBLIC` (the hardening H1 recommends, which nothing currently performs), and the
grants each body needs: `SELECT` on the tables they read, plus write grants for
`advance_project_team_cursor` and `unit_recompute_status`. A SELECT-only grant
fails those two at runtime with 42501, not at migration time. Derive the list
from the bodies, not the names.
Verify: the probe's third row, reproduced by
`packages/database/test/rls-isolation.test.ts` and the customer portal suites,
which exercise the helpers through the app role.

W3. Move relations, enums and the schema. `REASSIGN OWNED BY shadhil TO
    shadhil_owner` does **not** work here: it aborts with `cannot reassign
    ownership of objects owned by role shadhil because they are required by the
    database system`, because `shadhil` owns the `plpgsql` extension. The statement
is atomic, so nothing moves and the message names the wrong object. Walk the
catalogue per class instead and skip extension members
(`NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = ... AND d.deptype = 'e')`):
relations and sequences, then functions, then enum types. Then `ALTER SCHEMA
    public OWNER TO shadhil_owner`, then `ALTER DATABASE ... OWNER TO shadhil_owner`.
Without the schema step every later `CREATE TABLE` fails `permission denied for
    schema public`, which reads like a missing table.
Verify: `pg_class` and `pg_proc` report zero objects owned by `shadhil` in
`public`; `pg_namespace` reports `shadhil_owner` for `public`; the `plpgsql`
functions still belong to `shadhil`.

W4. Split the bootstrap into two artifacts, because one cannot do both jobs.
(a) `scripts/owner-role-bootstrap.sql`, run as the bootstrap superuser through
`ssh → docker exec -i shadhil-postgres psql -U shadhil`: creates the roles and
moves ownership (W1 to W3). It cannot be a Prisma migration, because after the
cutover `prisma migrate deploy` connects as `shadhil_owner`, and a non-superuser
owner cannot `ALTER FUNCTION ... OWNER` (`ERROR: must be owner of function`) or
reassign at all. Both verified.
(b) `scripts/rls-post-migrate.sql`, run **after** `prisma migrate deploy` by the
bootstrap superuser on every install, including a fresh one: re-asserts helper
ownership, `REVOKE ALL FROM PUBLIC`, and the helper grants. This step exists
because `policies.sql` creates the helpers inside migration 1, so on a fresh
database they are owned by whoever ran the migration, which after W5 is
`shadhil_owner`, not `shadhil_rls`. Without (b) a fresh install fails W14(b) and
the helpers run caller-scoped, which is the exact silent failure this plan is
about.
Preflight in both: if `current_user <> 'shadhil'`, raise and stop, so nobody runs
them from the wrong URL and half-applies them.
Verify: (a) leaves the state W1 to W3 describe and a second run changes nothing;
(b) run against an empty volume after `migrate deploy` leaves every `prosecdef`
function owned by `shadhil_rls`.

W5. Repoint `DIRECT_DATABASE_URL` (dev `.env`, then `docker/coolify-compose.yml` at
`:87` and `:140`, and Coolify's own copy) at `shadhil_owner`, and set
`SHADOW_DATABASE_URL` if the derived shadow cannot be created. Prisma 7 has no
`datasource` URL in `schema.prisma`, so a `shadowDatabaseUrl` edit there does
nothing.
Verify: `prisma migrate status` clean, `prisma migrate dev` with no pending
changes, and a fresh `migrate deploy` against a restored copy.

W6. Seed: point it at `shadhil_seed` through its own variable, delete the
`SET LOCAL row_security = off` block at `src/seed.ts:249` and the session-level
fallback under it, and delete the same line the generator emits at
`scripts/generate-test-data-sql.ts:451`.
Verify: `pnpm seed` on a restored copy, twice, to prove idempotence.

W7. Test harness: add `TEST_DIRECT_DATABASE_URL`, read by `createDirectPrismaClient`
(`packages/database/src/test-db-isolation.ts:163`), pointing at `shadhil_seed`.
Do not simply repoint `DIRECT_DATABASE_URL` for the harness: a non-bypass owner
turns every cross-tenant fixture purge into a zero-row no-op, quietly, across
about 19 suites. That is the failure this item exists to avoid.
Verify: `pnpm run test` with no new failures against the pre-change baseline. Do
not gate on exact counts; they legitimately shift.

W8. Backfills. 50 migration files contain DML, and after W5 they run as a non-bypass
owner. Measured: with `row_security` at its default the statement succeeds and
touches **zero** rows; with `row_security = off` it errors. Every future backfill
is therefore a silent no-op. Two rules, both needed: migrations that must see
every tenant run their DML as the seed role, and a guard fails a **new**
migration that contains DML when `current_user` is the owner. The guard must not
apply to replaying the 50 existing files, or a fresh install cannot get past
migration one; scope it by a marker (files after a cutover date, or a header
comment) rather than by scanning every file.
Verify: a test migration updating every tenant's row is applied and the count
changes; removing the guard makes it a silent no-op and the test fails.

W9. Full sweep: test, lint, type-check, build. Then the RLS matrix and customer
portal suites specifically, because a helper that lost its bypass fails there
first and quietly.

W10. Production cutover, in a maintenance window: restore point, then W4's script,
then the Coolify env change and a redeploy. Rollback is the reverse catalogue
walk plus the env restore point, and it is not symmetric: objects created after
the cutover belong to `shadhil_owner` and need moving back too, and grants to
`shadhil_rls` and `shadhil_seed` do not revert by themselves. Write both
directions before starting.

W11. Update `TODOS.md`, `rls.ts`'s header and the RLS docs to describe the five
roles, which three can cross tenants, and the backfill rule from W8.

W12. Create the roles where roles are created today, not by hand on two machines.
`docker/postgres-init/00-init.sql` creates `shadhil_app` and is what a fresh
install runs; `.github/workflows/ci.yml` mirrors it in **three** blocks (`:171`,
`:294`, `:499`). All four sites need the three new roles, idempotently, plus
`GRANT USAGE, CREATE ON SCHEMA public` and the schema and database ownership in
the init script, or a fresh install has no owner to migrate as.
Verify: a fresh volume with `docker compose up`, then `prisma migrate deploy`
with no manual SQL.

W13. Point CI's `DIRECT_DATABASE_URL` at `shadhil_owner` in every job that migrates
or tests: `:183`, `:186`, `:245`, the rls-matrix job at `:312` and `:322`, and
the e2e job around `:499-510`. Missing the rls-matrix job would leave the one job
whose purpose is proving RLS running as the old superuser.
Verify: each job connects as `shadhil_owner` and the FORCE test passes.

W14. Three tests, same shape as `rls-force.test.ts`, which already earns its keep:
(a) role attributes, where `shadhil_owner` is NOSUPERUSER and NOBYPASSRLS,
`shadhil_rls` has BYPASSRLS and no LOGIN, and `shadhil_seed` has BYPASSRLS;
(b) ownership, where every `prosecdef` function in `public` is owned by
`shadhil_rls`, because one `CREATE OR REPLACE FUNCTION` in a later migration
otherwise re-owns a helper and the helper silently becomes caller-scoped;
(c) a schema-wide count of roles with `rolsuper OR rolbypassrls`, so a fourth
cross-tenant credential cannot appear unnoticed.
Verify: each fails when the attribute, the ownership or the role set is changed
by hand, then passes once restored.

## Premise challenges from review

These are direction questions, not corrections, so they are not applied
unilaterally. Each one is a finding with evidence.

P1. **The role split is undone by a shared password.** `00-init.sql:30` creates
`shadhil_app` with the literal password `shadhil`, and `POSTGRES_PASSWORD` is
`${PG_PASSWORD}`, which CI also sets to `shadhil`
(`.github/workflows/ci.yml:148-150` and `:171`). `docker/userlist.txt` maps both
roles. So a container that reads `DATABASE_URL` can authenticate as the bootstrap
superuser, and the new roles inherit the same secret. Separating roles while sharing
one password moves labels, not risk.

P2. **The owner credential ships into the request path.** `DIRECT_DATABASE_URL` is
in the api and web containers (`docker/coolify-compose.yml:87`, `:140`) and both
apps require it at boot (`apps/backend/src/boot-env.ts:93`,
`apps/web/src/lib/env/env.ts:13`). It is used for validation, not queries. Repointing
it at `shadhil_owner` still hands every request-path container a credential that can
drop a policy or read all 34 tables, so a web RCE defeats the plan's purpose without
touching the roles at all.

P3. **`User` carries no RLS.** Measured: `User` has `relrowsecurity = false`.
`rls-force.test.ts` only inspects tables where RLS is already enabled, so it can
never see this. The "all 34 tables" figure is an inventory of RLS tables, not of
tenant data, and the highest-impact tenant path is the auth table that is not in it.

P4. **The safety net the plan gates on is not cross-tenant.** `rls-isolation.test.ts`
uses a single organization id for every fixture row (12 occurrences of the same
`ceid01lpfe1esm8jwsxid41k28`). It proves role and team separation inside one tenant.
W9's gate therefore cannot detect a helper that starts leaking across tenants.

## Work items for the premise challenges

W15. Separate secrets before separating roles: distinct passwords per role, no
literal in `00-init.sql`, `userlist.txt` regenerated, and the bootstrap password
rotated. Doing this after the role split means the split protects nothing in the
meantime.
Verify: no two roles share a password; a container holding `DATABASE_URL` cannot
authenticate as `shadhil`.

W16. Remove `DIRECT_DATABASE_URL` from the api, web and SSE runtime containers and
from their boot validators; run migrations from a deploy step that has it. Check
what the boot check still needs to prove before deleting the requirement.
Verify: `docker inspect` shows no owner credential in a request-path container,
and the deploy still migrates.

W17. Decide `User`: either give it RLS, or write down why an auth table is exempt
and where its tenant filter lives. Also extend the FORCE test to fail on a
tenant-bearing table with no RLS at all, which is the class of the bug it cannot
currently see.
Verify: the new test fails on today's schema and passes only when `User` is
either protected or explicitly exempted with a reason.

W18. Make `rls-isolation.test.ts` seed two genuine organizations and assert that
each cannot see the other's rows, before W9 relies on it as a gate.
Verify: a helper that leaks across tenants fails the suite.

W19. Commit the falsification above as a test, whatever else is decided. It is the
only check that tells the truth about what this repo's tenancy actually enforces,
and it must fail today so that whoever fixes it later has a red test to drive.
Verify: the test asserts that forging `app.user_org_id` as `shadhil_app` returns
zero rows for another tenant; it fails on today's schema.

## Hard calls

H1. **Helpers keep a bypass.** The alternative is rewriting all 19 to carry their own
org predicates. Most already do, but `project_unit_ids` and
`progress_photo_creator_labels` exist precisely because the caller cannot see the
rows, so rewriting them means reintroducing the visibility they were built to
avoid. Recommendation: bypass role, audited by name, `REVOKE ALL FROM PUBLIC`
(W2).

H2. **The seed gets a bypass role** rather than per-write GUCs. The seed writes across
every table, including tables whose policies are role-shaped; adding GUCs to each
write is more code than value for a bootstrap script that only runs on a fresh
install.

H3. **The test harness keeps a bypass role.** Tests that purge a tenant need to delete
rows the app role cannot see. Do not spend this migration making the harness
realistic; that is a separate, larger change and it would make every RLS test
prove less.

H4. **`shadhil` keeps LOGIN.** Revoking it sounds tidier, but there is no other
superuser on either cluster, so losing it means no `CREATE EXTENSION`, no
`ALTER ROLE`, no recovery. Its password rotation and its removal from `.env` are
separate work with their own rollback, deferred to TODOS.md rather than bundled
into a change that must be reversible in one step.

## Effort and gate

Roughly 8 to 10 hours on dev plus a 30 minute prod window for the role split alone.
The four premise items (W15 to W18) are larger than the split: secret separation is
a Coolify and `.env` change with a rotation, and the two-organization matrix is a
new fixture. W3's catalogue walk, W8's backfill rule and W12's four role-creation
sites are each a surprise waiting for whoever assumes the obvious statement works.

The gate before touching prod: W1 to W9 green on dev, plus a restored copy of prod
carrying the same roles with the full suite passing against it.

## Out of scope

- Rewriting the 19 helpers.
- Removing BYPASSRLS from anything.
- Connection pooling, pgbouncer auth or TLS changes.
- Rotating the bootstrap superuser password, and removing it from `.env`.

## Review record

Reviewed by /autoplan on 2026-11-28: CEO phase only (no UI, no DX). Three voices.
The outside reviewer and the native reviewer independently reached the same
conclusion, which is the one that matters: the plan removes cluster-level superuser
exposure and does not deliver tenant isolation, because the tenant is a session GUC
any credential can set. Both also flagged the shared `shadhil` password and the
direct database URL in the runtime containers, neither of which the plan addressed.

Outcome: resequenced. Credential hygiene done (this commit: the web container loses
the owner credential, W19's test lands). Role split parked until the tenancy model is
decided, because no role arrangement fixes a forgeable tenant.
