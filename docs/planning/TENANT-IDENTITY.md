# Tenant identity: what RLS actually stops, and the one design worth building

Measured 2026-11-28. This page exists so the decision can be made once, in one read,
instead of being rediscovered every time someone reads `policies.sql` and assumes the
policies are a tenancy boundary against a hostile caller.

## What is true today

Every one of the 128 policies in `packages/database/prisma/rls/policies.sql` keys off a
session setting:

```sql
"organizationId" = current_setting('app.user_org_id', true)
```

Zero policies reference `current_user`. So the identity the database enforces is whatever
the caller wrote into the session, and Postgres has no way to tell an honest application
from a hostile one holding the same credential. Measured as `shadhil_app`, the
non-superuser role the API actually uses:

| Caller                                  | Leads visible |
| --------------------------------------- | ------------- |
| `shadhil_app`, no GUCs                  | 0             |
| `shadhil_app`, GUCs forged for Builders | 31            |
| `shadhil_app`, GUCs forged for Test     | 158           |
| `shadhil_app`, GUCs forged for Demo     | 66            |

That is not a hole in the policies. It is what a GUC-based design is: RLS here stops
application bugs, a forgotten `where`, a bad JOIN, a cross-tenant id in a request body.
It does not stop a leaked `DATABASE_URL`, and it never did. `packages/database/test/
tenant-forgery.test.ts` pins today's answer, so any fix has a red test waiting for it.

The owner-role work in `OWNER-ROLE-MIGRATION.md` is a different problem: it removes a
superuser that bypasses RLS on all 34 tables. It does not make a forged GUC fail.

## What the database would need to know

For a policy to refuse a forged identity, the database must derive the tenant from
something the credential holder cannot fabricate. There are only three shapes:

**A. A login per tenant.** `shadhil_org_<id>` owns nothing, policies read `current_user`
or the role carries the tenant. Unforgeable, because you cannot become a role you have no
password for.

- Buys: the strongest guarantee with the least policy change, and it composes with the
  owner-role plan.
- Costs: one credential per tenant to provision, rotate and revoke; `POOL_MODE=session`
  means each tenant login holds its own server-side pool, so connections multiply by
  tenant count; PgBouncer's `userlist.txt` grows per tenant; the API must select a
  connection per request instead of using one pool.
- Verdict: correct shape, wrong time at two organisations. Revisit when the connection
  arithmetic stops being free, or when a tenant's contract demands it.

**B. A per-tenant secret the app must present, verified inside the database.** One
`TenantKey` row per organisation holding a random token, in a table with RLS forced and
no policy at all, so the app role reads zero rows from it. A `SECURITY DEFINER` function
`app_tenant_ok(org)` compares the caller's `app.tenant_token` with the row and returns
boolean; every policy gains `AND app_tenant_ok(current_setting('app.user_org_id', true))`.

- Buys: a leaked `DATABASE_URL` alone is no longer enough. The forgery above stops
  working, which is exactly what `tenant-forgery.test.ts` asserts.
- Costs: 128 mechanical policy edits (regenerate the file, do not hand-edit), one
  function and one table, `withRlsContext` sets one more setting, and the API has to hold
  the tenant tokens somewhere. A `STABLE` function is evaluated per row, not per query,
  so there is a per-row cost; at this volume it is a primary-key lookup, and it becomes
  visible only on the largest scans.
- The honest limit: it moves the secret from the database credential to the application
  configuration. The attack changes from "leak the connection string" to "leak the app
  environment", not to "impossible". Two secrets are needed instead of one.
- Verdict: the design to build when tenancy has to be real.

**C. A database per tenant.** Strongest boundary; migrations, backups, connection
routing and monitoring all multiply by tenant. Unreasonable at this size.

## Recommendation

Build B, and not yet.

The trigger is the first second paying client, not a date. Today production holds two
organisations, both belonging to the same client family; a leaked connection string today
exposes one client's data to that client. The moment a second paying client shares this
database, the same leak becomes somebody else's data, and that is when B earns its cost.

Until the trigger, the operating rule stands: `DIRECT_DATABASE_URL` is a privileged
secret, never in a BI tool, an ad hoc script or a laptop session that is not a migration,
and the app role's own credential is rotated on the same schedule as any other secret. The
password split on 2026-11-28 and the FORCE RLS migration are already in place, and
`tenant-forgery.test.ts` stays as the red test so the gap cannot be forgotten.

## If B is built, the order

1. `TenantKey` table, RLS forced, no policy, `REVOKE ALL` from `shadhil_app`.
2. `app_tenant_ok(text)` `SECURITY DEFINER` with a pinned `search_path`, owned by a role
   the app is not.
3. Regenerate `policies.sql` with the extra predicate, then copy the delta into a
   migration like every other policy change.
4. `withRlsContext` sets `app.tenant_token` beside the three GUCs it already sets, and
   the test helper follows.
5. `tenant-forgery.test.ts` flips from pinning the forgery to pinning the refusal. That
   flip is the definition of done.
6. Token rotation runbook: rotate the row, redeploy the app with the new token, no
   downtime if the function accepts the previous token for one release.

Estimated at roughly a day, most of it the policy regeneration and proving the flip,
because 128 policies change mechanically and the function itself is small.

## What this page does not decide

- The owner superuser. Covered by `OWNER-ROLE-MIGRATION.md`; independent of this.
- `User` has no RLS at all, so every read of a user by id is a hand-written org check.
  That class of bug was worked once in Round 61 and is not fixed by any option here.
