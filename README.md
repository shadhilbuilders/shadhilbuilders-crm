# Shadhil Builders CRM

CRM for Shadhil Builders (Indian real-estate, Chennai). Monorepo: Next.js 16 web
(BFF + UI), NestJS 12 REST API, Expo mobile (Week 10+), Prisma + Postgres 16
with row-level security, deployed via Coolify on Hostinger.

## Quick start (target: < 5 min)

```bash
pnpm install
cp .env.example .env          # edit secrets (BETTER_AUTH_SECRET, JWT_SECRET)
pnpm docker:up                # postgres + pgbouncer (session pool) + redis
pnpm --filter @shadhil/database migrate   # schema + RLS policies + grants
pnpm --filter @shadhil/database seed      # placeholder users (rotate!)
pnpm dev                      # turbo dev — web :3000, api :8080
```

Login with the seeded placeholder users (roles in caps):
`admin@` / `manager@` / `telecaller@` / `sales_exec@shadhilbuilders.in`,
password `<role>_placeholder_pw`. Rotate on first login.

## Layout

```
apps/
  web/       Next.js 16 (better-auth catch-all, UI, notification inbox)
  backend/   NestJS 12 REST (JWT bridge, SSE, crons, webhooks)
  mobile/    Expo (Weeks 8-10 of the plan)
packages/
  database/  Prisma schema + RLS policies + migrations (single source of truth)
  auth/      @shadhil/auth — shared better-auth instance + JWT helpers
  api-types/ Zod schemas + inferred types shared across apps
  ui-tokens/ Brand tokens (#001a4c / #62b132 / #f8f5ef)
docs/planning/   Plan of record — START HERE: docs/planning/IMPLEMENTATION-PLAN-v1.md
PLANNING-MASTER.md  Index to every planning document
```

## Commands

| Command | What it does |
|---|---|
| `pnpm docker:up` | Start postgres/pgbouncer/redis |
| `pnpm --filter @shadhil/database migrate` | Apply schema + RLS (prisma migrate dev) |
| `pnpm --filter @shadhil/database seed` | Bootstrap 4 users + team (placeholders unless SEED_* set) |
| `pnpm db:policies` | Re-apply policies.sql directly (idempotent) |
| `pnpm test` | All package tests (integration needs a live DB; CI runs them) |
| `pnpm type-check` / `pnpm lint` | Gates that must stay green |

## Security model (read before touching data access)

- Business tables are **FORCE ROW LEVEL SECURITY**. The API connects as
  `shadhil_app` (non-owner) — owner role `shadhil` is migrations/seed only.
- Every request-scoped query MUST run inside
  `withRlsContext(prisma, { userId, role, teamId }, tx => ...)` from
  `@shadhil/database`. Bare-prisma access bypasses RLS and is reserved for
  migrations, seed, better-auth session tables, webhook ingest, and system
  crons.
- Roles are the Prisma `Role` enum (UPPERCASE): `ADMIN | MANAGER |
  SALES_EXEC | TELECALLER`. JWT claims are normalized/validated in
  `packages/auth-client/src/jwt.ts` — a token without a valid role claim is
  rejected.
- `@Public()` is for health, auth, and signature-verified webhooks only.
  Nowhere else.

## Conventions (AGENTS.md content merged here)

- Modules live in `apps/backend/src/<module>/` as NestJS `*.module.ts` +
  controllers/services; tests co-locate as `*.test.ts` next to the unit or in
  the package `test/` dir.
- Every new feature ships with tests in the same PR (plan §19.7). Backend
  tests: Vitest + supertest; web E2E: Playwright (`apps/web/src/test/e2e`).
- Turbo caches builds — test inputs include all `*.test.ts` files (see
  `turbo.json`). Never exclude tests from cache inputs.
- PR CI (`.github/workflows/ci.yml`): type-check, lint, unit tests, RLS matrix
  (with a real Postgres service), build.

## Migration policy

Schema changes flow ONLY through Prisma migrations
(`packages/database/prisma/migrations/`). RLS policy changes belong in the
same migration as the table change — keep `prisma/rls/policies.sql` as the
canonical source and copy into the migration.