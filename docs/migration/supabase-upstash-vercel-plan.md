# Migration plan — Supabase (DB) + Upstash (Redis) + Vercel (web); VPS keeps API + SSE

Status: DRAFT — awaiting approval. Not applied.
Author: Hermes, 2026-10-06.

## Verdict

Feasible, with **three gating changes** that must be handled or the stack breaks
silently. Everything else is config + comments.

- ✅ Upstash for Redis — no BullMQ anywhere; Redis is used only for `SET NX EX`
  locks and Lua EVAL (release/renew lease). Both work on Upstash. (SSE does NOT
  use Redis pub/sub; it polls Postgres every 1.5s — verified in
  `apps/realtime-sse/src/config.ts` + `realtime.service.ts`.)
- ✅ Web on Vercel — app already has a Vercel project (`prj_xZlhyl…`, team
  `OiXy2PhG…`) and 4 Vercel envs. `output: 'standalone'` + Serwist work there.
- ⚠️ Supabase for Postgres — **the RLS model is the risk** (see Gate 1).

## Gates (must solve before cutover)

### Gate 1 — Supabase pooler vs RLS session mode  (HIGH)
- The app REQUIRES session-mode pooling. `apps/backend/src/main.ts` calls
  `verifyPoolMode()` and refuses to boot unless `POOL_MODE=session`
  (`packages/database/src/boot-check.ts`). RLS uses `SET LOCAL app.user_id/role/org_id`
  which only survive across a session-mode pool (transaction mode loses them).
- Supabase Supavisor: **session mode = port 5432**, transaction = 6543.
  → API + SSE must use the :5432 (session) pooled connection string.
- **Danger:** the Supabase connection string's user is `postgres.<ref>` — the
  `postgres` role is the **table owner and BYPASSES RLS**. If app traffic uses
  it, every tenant policy silently stops enforcing. Migrations must run as owner;
  the app must NOT.
  → Create a non-owner role `shadhil_app` in Supabase with the same shape as
    `docker/postgres-init/00-init.sql` (NOSUPERUSER NOBYPASSRLS, no table
    ownership, schema USAGE + the GRANTs from `prisma/rls/policies.sql`), and use
    Supavisor's role-scoped username `shadhil_app.<ref>` on :5432.
  → **Acceptance test:** as `shadhil_app` with `app.user_org_id = OrgA`, a raw
    `SELECT * FROM "Lead"` must return 0 rows of OrgB. If it returns any, RLS is
    bypassed — stop.

### Gate 2 — Web on Vercel connects to Postgres DIRECTLY  (HIGH)
- `apps/web/src/lib/server/tenant.ts` and `apps/web/src/app/api/bff/[...path]/route.ts`
  both `import { prisma } from '@shadhil/database'` and query `session`. So Vercel
  needs a DB connection — it is not purely a BFF proxy.
- Those queries hit `Session`/`User` (better-auth tables; granted to `shadhil_app`,
  no RLS policies) so they do NOT need session mode.
- But Vercel is serverless: many short-lived instances → connection exhaustion.
  → Web's `DATABASE_URL` must be the **transaction pooler (:6543)** with a per-
    instance cap. With the Prisma 7 `@prisma/adapter-pg` driver adapter the cap is
    `DB_POOL_MAX` (not `connection_limit=1`); set `DB_POOL_MAX=1` for web.
  → Web also requires `DIRECT_DATABASE_URL` to pass `env.ts` validation
    (`z.url()`), even though it never connects with it at build. Point it at the
    Supabase session string.

### Gate 3 — Postgres version + dump restore  (MEDIUM)
- Local prod is PG 16 (`postgres:16-alpine`; dump header `PostgreSQL database
  format 16.15`). Confirm the Supabase project is Postgres **>= 16** before
  restoring, or the restore/migrate can fail on version-specific SQL.
- Restore path: `prisma migrate deploy` (creates schema) OR restore the
  age-encrypted `pg_dump` (data). For a live cutover, dump-then-restore preserves
  data; migrations alone do not.
- Supabase has `pgcrypto`; policies use the `current_setting('app.x', true)`
  two-arg form — both compatible.

## Redis / Upstash details

- `apps/backend/src/redis/redis.module.ts` uses: `SET key val EX ttl NX`,
  `EVAL <lua>` (release + renew lease). Both supported by Upstash.
- Connection string must use **`rediss://` (TLS)** and add `?family=0`
  (ioredis otherwise races IPv6/IPv4 and throws `ENOTFOUND`/timeouts on
  serverless-friendly providers).
- `maxRetriesPerRequest: 3` is already set — keep it.
- Costs: Upstash is per-command. The reminder/overdue crons hold a 50s lock and
  renew every 25s → low volume. Fine.
- If Redis pub/sub is ever introduced (currently it is NOT), re-evaluate: Upstash
  charges per message and has pub/sub quirks.

## Target architecture

```
Vercel            → web (Next.js standalone) → Supabase (transaction pooler 6543)
VPS (unchanged)   → api    (NestJS)          → Supabase (session pooler 5432, shadhil_app)
                  → sse    (bare node)       → Supabase (session pooler 5432, shadhil_app)
api + sse         → Upstash Redis (rediss://)
VPS: postgres, pgbouncer, redis, web  → STOPPED (commented out, not deleted)
```
Traefik still fronts api.crm + sse.crm on the VPS (unchanged). Vercel serves
crm.shadhilbuilders.in and BFFs to https://api.crm.shadhilbuilders.in.

## Reversibility mechanism (the "comment out, easy switchback" requirement)

Rule: **never delete a service block, never delete an env value.** Comment with
an explicit banner; keep the old values adjacent.

1. Snapshot the current compose verbatim:
   `docker/coolify-compose.full.yml`  ← the "everything on VPS" version.
2. Active compose = `docker/coolify-compose.yml` with the four blocks wrapped:
   ```
   # ==========================================================================
   # DISABLED 2026-10-06 - moved to Supabase / Upstash / Vercel.
   # TO REVERT: uncomment this whole block, restore the env values marked
   # [REVERT] below, and PATCH this file back to the Coolify service.
   # ==========================================================================
   # shadhil-postgres:
   #   image: postgres:16-alpine
   #   ...
   ```
   Blocks to disable: `shadhil-postgres`, `shadhil-pgbouncer`, `shadhil-redis`,
   `shadhil-web`. Keep `shadhil-api` and `shadhil-realtime-sse` live.
3. Coolify does NOT read the repo file on deploy — it stores its own
   `docker_compose_raw` (verified: "it never uploaded docker/coolify-compose.yml").
   So the same commented compose must be PATCHed to the service
   (`PATCH /api/v1/services/0bjahklz8gtdtr4do4r7ae6m`, base64-encoded
   `docker_compose_raw`) — the mechanism already used for the container limits.
4. Env values that change (Coolify service env): keep the KEY, change the VALUE,
   and record the old value in `docs/migration/cutover.md` under
   `[REVERT] DATABASE_URL=...`. Env keys are never deleted.
5. Volumes `postgres_data` / `redis_data` are NOT removed. They hold the last
   local copy of the data, so reverting restores the old DB as it was at cutover.

Switchback = 3 steps, ~2 min:
```
cp docker/coolify-compose.full.yml docker/coolify-compose.yml
PATCH that compose to the Coolify service + restore [REVERT] env values
restart the service
```

## Change list (when approved)

Repo:
- `docker/coolify-compose.full.yml` (new, snapshot)
- `docker/coolify-compose.yml` (comment out 4 blocks + `[REVERT]` banners)
- `docs/migration/cutover.md` (new: old/new env values, runbook, revert steps)
- `apps/web`: add `apps/web/vercel.json` only if Vercel build needs overrides
  (monorepo root dir + `pnpm --filter @shadhil/web build`).

Coolify (VPS), via API PATCH:
- PATCH service compose (commented version)
- Set api + sse env: `DATABASE_URL` → Supabase shadhil_app session :5432,
  `DIRECT_DATABASE_URL` → Supabase owner session :5432, `REDIS_URL` → Upstash.
  Keep `POOL_MODE=session`, keep all else.
- Restart service; api+sse come back pointed at Supabase/Upstash.

Vercel (web project `prj_xZlhyl…`):
- Root Directory = `apps/web` (it's currently at repo root — this is the main
  build change). Install: `pnpm install` (root); Build: `pnpm --filter @shadhil/web build`.
- Env: `DATABASE_URL` (transaction pooler :6543, `DB_POOL_MAX=1`),
  `DIRECT_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `JWT_SECRET`, `JWT_ISSUER`, `BACKEND_API_URL` (→ https://api.crm...),
  `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`,
  `NEXT_PUBLIC_APP_NAME`, plus the RERA/MODEL_C/ORG_SIGNUP flags.
- Point `crm.shadhilbuilders.in` at Vercel; remove the Traefik `crm` router
  (comment it, per the same rule).

Migrations:
- Run once against Supabase: `prisma migrate deploy` (+ `00-init.sql` role/policies
  if not restoring a dump), then load data if restoring.
- Deploy workflow still runs `migrate deploy` in the api container — keep
  `DIRECT_DATABASE_URL` as the Supabase owner session URL so it keeps working.

## Cutover sequence (zero-downtime-ish, staged)

1. Create Supabase project (>= PG16), create `shadhil_app`, run migrations,
   **load a fresh pg_dump** of prod. Verify RLS acceptance test (Gate 1).
2. Create Upstash Redis (TLS). Verify locks by running the reminder cron path.
3. Deploy web to Vercel on a preview URL; point its env at Supabase + the live
   VPS api. Smoke-test login + a BFF call + SSE.
4. PATCH Coolify: api/sse → Supabase + Upstash. Restart. Verify health, cron
   locks, SSE stream.
5. Flip `crm.shadhilbuilders.in` to Vercel; comment the Traefik `crm` router.
6. Comment out postgres/pgbouncer/redis/web in the compose; PATCH; restart.
   Volumes kept.
7. Keep the VPS postgres running (stopped, not deleted) for N days as a rollback
   target; then decide.

## Risks / notes

- **Host steal is not fixed by this.** Moving web off the VPS reduces what runs
  there, but api+sse still share the oversubscribed host. The Hostinger ticket /
  resize remains the real fix for the steal. (api+sse are light — 0.06 of 2 cores —
  so they tolerate modest steal better than web did.)
- SSE polls Postgres every 1.5s **per connected client**. On a shared Supabase
  instance this is the main cost to watch; if concurrent SSE clients grow, revisit
  (raise `SSE_DB_TICK_MS` or move to a realtime channel).
- Supabase free tier pauses idle projects and caps connections — use Pro for prod.
- Cloudflare TLS: `api.crm`/`sse.crm` second-level wildcard cert issue from
  `references/prod-vps-disk-maintenance.md` still applies; Vercel adds its own
  cert for `crm`.
- Backups: the VPS `shadhil-backup.timer` dumps the LOCAL postgres. After cutover
  it must target Supabase (or rely on Supabase backups + PITR). Flag before step 6.
