# Shadhil Builders CRM

CRM for Shadhil Builders (Indian real-estate, Chennai). Monorepo: Next.js 16 web
(BFF + UI), NestJS 12 REST API, Expo mobile (Week 10+), Prisma 7 + Postgres 16
with row-level security, deployed via Coolify on Hostinger.

Current stack pins: pnpm 11 · Node 26 runtime (CI on 22) · Next 16.3 · Nest 12 ·
Prisma 7.10 (+ `@prisma/adapter-pg`) · better-auth 1.7 · Tailwind 4 ·
edoburu/pgbouncer 1.25 · Postgres 16 · Redis 7.

## Quick start (target: < 5 min)

```bash
pnpm install
cp .env.example .env          # edit secrets (BETTER_AUTH_SECRET, JWT_SECRET)
pnpm docker:up                # postgres + pgbouncer (session pool) + redis
pnpm --filter @shadhil/database generate  # prisma client (gitignored)
pnpm --filter @shadhil/database migrate   # schema + RLS policies + grants
pnpm --filter @shadhil/database seed      # super admin + manager + 2 staff
pnpm dev                      # turbo dev — web :3000, api :8080
```

Then open http://localhost:3000/login and sign in with a seeded placeholder
account (rotate these before any real use):

| Email | Role | Password |
|---|---|---|
| admin@shadhilbuilders.in | SUPER_ADMIN (exactly one, ever) | `admin_placeholder_pw` |
| manager@shadhilbuilders.in | MANAGER | `manager_placeholder_pw` |
| telecaller@shadhilbuilders.in | TELECALLER | `telecaller_placeholder_pw` |
| sales_exec@shadhilbuilders.in | SALES_EXEC | `sales_exec_placeholder_pw` |

Role model: SUPER_ADMIN ⊃ ADMIN ⊃ MANAGER ⊃ TELECALLER / SALES_EXEC. The
super admin creates admins; admins create managers + staff; managers create
staff in their own team. Role changes follow the same hierarchy and are
written to the audit log (see `docs/planning/DECISION-CHANGELOG.md` Rounds
17–20). Users are created/changed via the API (`POST /api/users`,
`PATCH /api/users/:id/role`) until the admin UI lands.

## Layout

```
apps/
  web/       Next.js 16 (login, better-auth catch-all, UI, notification inbox)
  backend/   NestJS 12 REST (users, JWT bridge, SSE, crons, webhooks)
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
| `pnpm docker:up` | Start postgres/pgbouncer/redis (edoburu pgbouncer; ini is authoritative) |
| `pnpm --filter @shadhil/database generate` | Generate the Prisma client (gitignored — required after install) |
| `pnpm --filter @shadhil/database migrate` | Apply schema + RLS (prisma migrate) |
| `pnpm --filter @shadhil/database seed` | Super admin + manager + team + staff (placeholders unless SEED_* set) |
| `pnpm db:policies` | Re-apply policies.sql directly (idempotent) |
| `pnpm test` | All package tests (unit runs anywhere; DB suite needs live Postgres) |
| `pnpm type-check` / `pnpm lint` | Gates that must stay green |

## Security model (read before touching data access)

- Business tables are **FORCE ROW LEVEL SECURITY**. The API connects as
  `shadhil_app` (non-owner) — owner role `shadhil` is migrations/seed only.
- Every request-scoped query MUST run inside
  `withRlsContext(prisma, { userId, role, teamId }, tx => ...)` from
  `@shadhil/database`. Bare-prisma access bypasses RLS and is reserved for
  migrations, seed, auth tables (User/Session/Account), Team writes
  (RLS-forced with zero policies), and system crons. The Prisma 7 pg-adapter
  client reads `DATABASE_URL` (pooled); SQLite-free CI note: keep the
  adapter constructor connection-free.
- Roles are the Prisma `Role` enum (UPPERCASE): `SUPER_ADMIN | ADMIN |
  MANAGER | SALES_EXEC | TELECALLER`. JWT claims are normalized/validated in
  `packages/auth-client/src/jwt.ts` — a token without a valid role claim is
  rejected. Exactly one SUPER_ADMIN exists (partial unique index
  `one_super_admin`); it cannot be created or assigned through the API.
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
- CI (`.github/workflows/ci.yml`): type-check, lint, unit tests, RLS matrix
  (fresh Postgres service + `prisma generate` per job), build. All jobs green
  as of 2026-08-31.

## Migration policy

Schema changes flow ONLY through Prisma migrations
(`packages/database/prisma/migrations/`). RLS policy changes belong in the
same migration as the table change — keep `prisma/rls/policies.sql` as the
canonical source and copy into the migration. Postgres-level constraints that
Prisma can't express (e.g. the partial unique index `one_super_admin`) live
in their own native-SQL migrations.