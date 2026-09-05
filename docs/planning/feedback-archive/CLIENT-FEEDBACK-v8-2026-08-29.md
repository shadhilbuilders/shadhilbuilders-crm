# Client Feedback Round 9 - 2026-08-29 (Shadhil CRM)

You asked two questions:
1. "Can we use Prisma with NestJS + REST API?"
2. "How does the database share the same data for all three places?"

Both are real questions, both have real answers, both have one gotcha
that bites teams if you don't see it. Let me lay them out.

---

## Q1: Can we use Prisma with NestJS + REST API?

**Yes, this is the official documented pattern.** The Prisma docs
have a guide for "Prisma + pnpm workspaces + Next.js + NestJS" and
a separate guide for "Prisma + Better Auth + Next.js." Both
patterns work together. real-world teams ship this every day.

The setup:

- Prisma Client (`@prisma/client`) lives in `packages/database`.
- Both `apps/web` (Next.js BFF) and `apps/backend` (NestJS) import
  it from there.
- Migrations are run from `apps/backend` because that's where the
  business logic lives.
- Both apps use the SAME Prisma Client to talk to the SAME database.

**One thing to be aware of:** in pnpm workspaces, Prisma's default
output goes to `node_modules/.prisma/client`. With multiple apps
that have their own `node_modules`, this can cause "two Prisma
clients" issues. The fix is to set a custom output path in
`schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../../node_modules/.prisma/client"
}
```

This forces Prisma to generate the client to a single location that
both apps can import from. Standard pattern in the Prisma docs.

---

## Q2: How does the database share the same data for all three places?

This is the harder question. There are three real models:

### Model A: One schema, three apps, single Prisma client (RECOMMENDED)

**The architecture:**
- ONE Postgres database (single instance in Docker on the VPS)
- ONE `schema.prisma` file (lives in `packages/database`)
- ONE Prisma Client (generated once, imported by both Next.js and NestJS)
- Next.js (BFF) uses Prisma for: auth tables only
  (User, Session, Account, Verification - owned by better-auth)
- NestJS (backend) uses Prisma for: ALL business tables
  (Lead, Message, Activity, SiteVisit, Booking, etc.)
- Mobile does NOT touch Prisma. Mobile calls NestJS REST. Mobile
  never sees the database directly.

**The data ownership:**

| Tables | Owned by | Read by | Written by |
|---|---|---|---|
| `User`, `Session`, `Account`, `Verification` | Next.js BFF (via better-auth) | Both apps | BFF (via better-auth) |
| `Team`, `Project`, `Unit` | NestJS | Both apps | NestJS only |
| `Lead`, `LeadAssignment`, `SiteVisit`, `Booking` | NestJS | Both apps | NestJS only |
| `Activity`, `Message` | NestJS | Both apps | NestJS only (webhook receivers + REST) |
| `AuditLog` | NestJS | Both apps (Admin only via RLS) | NestJS only (writes from middleware) |
| `ManagerAssignmentRule` | NestJS | Both apps | NestJS only |

**The key rule:** Next.js components DO NOT query business tables
directly. They call the NestJS REST API. This avoids two paths to
the same data (which is how bugs and security issues happen).

The ONE exception: Next.js server components MAY read the `User`
table to load the current user's profile in a server-rendered page.
That's read-only, RLS-enforced, and doesn't create a second write
path.

### Model B: Three separate schemas (NOT recommended)

- Each app has its own `schema.prisma` with its own subset of tables.
- Cross-app queries become painful.
- Migration coordination is a nightmare.
- Don't do this.

### Model C: Next.js does all the data work, NestJS is a thin webhook layer (DIFFERENT stack)

- This is the Supabase + Next.js full-stack model.
- We explicitly rejected this when we chose Option B (split backend).
- Listing it here for completeness so you can see why Model A is
  the right answer for the locked stack.

---

## The one gotcha that bites teams: connection pooling

This is the part nobody tells you about until it bites you in
production. With ONE Postgres database and TWO apps:

- Next.js (BFF) has its own Prisma client → 1 connection pool
- NestJS (backend) has its own Prisma client → 1 connection pool
- If you deploy multiple instances of each (e.g., 2 Next.js
  containers + 3 NestJS containers), each container has its own
  pool
- Default Prisma pool size: `num_physical_cpus * 2 + 1` per instance
- With 5 instances: 5 pools = 25-50 connections
- Postgres default `max_connections`: 100

**For 5-15 users this is fine.** For 50+ users it bites.

**The solution: PgBouncer in transaction-pooling mode.**

PgBouncer sits between your apps and Postgres. All apps connect
to PgBouncer. PgBouncer multiplexes many app connections to few
Postgres connections. You can have 50 app containers, PgBouncer
holds 10-20 real Postgres connections.

For Coolify on Hostinger VPS, add PgBouncer to the docker-compose:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=shadhil
      - POSTGRES_PASSWORD=*** # from .env
      - POSTGRES_DB=shadhil_crm
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shadhil"]
      interval: 10s
      timeout: 5s
      retries: 5

  pgbouncer:
    image: bitnami/pgbouncer:latest
    environment:
      - POSTGRESQL_HOST=postgres
      - POSTGRESQL_PORT=5432
      - POSTGRESQL_DATABASE=shadhil_crm
      - POSTGRESQL_USERNAME=shadhil
      - POSTGRESQL_PASSWORD=*** # from .env
      - PGBOUNCER_DATABASE=shadhil_crm
      - PGBOUNCER_AUTH_TYPE=scram-sha-256
      - PGBOUNCER_POOL_MODE=session  # see "RLS gotcha" below
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "6432:6432"

  backend:
    build: ./apps/backend
    environment:
      - DATABASE_URL=postgresql://shadhil:***@pgbouncer:6432/shadhil_crm
    depends_on:
      - pgbouncer

  web:
    build: ./apps/web
    environment:
      - DATABASE_URL=postgresql://shadhil:***@pgbouncer:6432/shadhil_crm
    depends_on:
      - pgbouncer
```

Both apps connect to `pgbouncer:6432` instead of `postgres:5432`.
PgBouncer handles the multiplexing. Done.

---

## The second gotcha: RLS + connection pooling

RLS requires the session var to be set per request:
`SET LOCAL app.current_user_id = '...';`

This works fine with PgBouncer in **session pooling mode** (the
default-ish). But with **transaction pooling mode** (the recommended
mode for high concurrency), the session vars get reset between
transactions, which breaks RLS.

**For v1 (5-15 users), use session pooling mode.** Performance
difference is negligible at this scale. When you hit 100+ concurrent
users, switch to transaction pooling AND change your Prisma code to
set the session vars inside a transaction:

```typescript
// With transaction pooling, you must set session vars inside a transaction
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL app.current_user_id = ${userId}`;
  await tx.$executeRaw`SET LOCAL app.current_user_role = ${role}`;
  // Now the query runs with RLS enforced
  return tx.lead.findMany();
});
```

But for v1, just use session pooling mode and the simpler pattern:

```typescript
// Session pooling mode - set once per request via middleware
// (set in NestJS request-scoped interceptor)
prisma.$executeRaw`SET LOCAL app.current_user_id = ${userId}`;
const leads = await prisma.lead.findMany();
```

Both work. The transaction pattern is "more correct" at high scale.
The request-scoped pattern is simpler at low scale. Start with the
simpler one.

---

## What this changes in DESIGN.md

§7 Tech stack - add a paragraph on Prisma + database architecture:

```
**Database architecture (the multi-app Prisma pattern):**

The single Postgres database is shared by both the Next.js BFF and
the NestJS backend via the SAME Prisma Client. The pattern:

- `packages/database/` contains the `schema.prisma` file (single
  source of truth for all 12 models + better-auth's auth tables).
- Prisma Client is generated to `node_modules/.prisma/client` (a
  single shared location, set in the schema's `output` field).
- Both `apps/web` and `apps/backend` import the same Prisma Client
  from `packages/database`.
- **Data ownership split:**
  - Next.js BFF writes to auth tables only (User, Session, Account,
    Verification) via better-auth's Prisma adapter. May READ from
    these tables in server components.
  - NestJS backend writes to ALL business tables via REST
    controllers and webhook receivers.
  - Next.js server components DO NOT query business tables directly.
    They call the NestJS REST API. (One exception: server components
    may read User to load the current user's profile.)
  - Mobile calls NestJS REST. Never touches Prisma directly.

**Connection pooling via PgBouncer:**

Both apps connect to a PgBouncer container in session-pooling mode,
not directly to Postgres. PgBouncer multiplexes app connections to
a small pool of real Postgres connections. Set
`PGBOUNCER_POOL_MODE=session` in the Coolify environment for v1 to
keep RLS session-var behavior simple. Switch to `transaction`
pooling in v2 when concurrent users exceed ~50, AND update Prisma
code to set session vars inside `$transaction` blocks.

**Migrations:**

Run from `apps/backend`: `pnpm prisma migrate dev --name <change>`.
Migrations create SQL files in `apps/backend/prisma/migrations/`
that are applied to Postgres via PgBouncer. After migrating, run
`pnpm prisma generate` from `packages/database` to regenerate the
Prisma Client.
```

§7 Monorepo structure - update the `packages/` list:

```
├── packages/
│   ├── database/         # Prisma schema + generated client
│   ├── api-types/        # Re-exports Prisma types + manual request/response types
│   ├── auth-client/      # Shared auth helpers (web + mobile)
│   └── ui-tokens/        # Brand tokens
```

(`api-types` becomes a thin re-export of `database` types.)

---

## Why this matters for the CRM

A few real-world implications worth flagging:

**1. The "second write path" trap is the #1 source of bugs in
multi-app architectures.** If Next.js and NestJS both write to
the Lead table, you have two sources of truth for state changes.
State machine bugs, audit log gaps, RLS bypasses - all common
when this happens. The "Next.js only writes auth tables, NestJS
writes everything else" rule prevents this entirely.

**2. The auth tables need a specific schema.** better-auth's
Prisma adapter requires certain tables (`user`, `session`,
`account`, `verification`) and certain fields on the `user`
table (`id`, `email`, `name`, `emailVerified`, `image`,
`createdAt`, `updatedAt`). The Prisma docs for better-auth
list the exact requirements. I'll need to add these to the
schema in DESIGN.md §5 before the build starts.

**3. The connection pooling decision affects the RLS code pattern.**
Session pooling = simple middleware. Transaction pooling = code
in every Prisma query. Get this right in week 2 (when RLS is
written) so you don't have to refactor at v2.

---

## What this does NOT change

- The roles, modules, lifecycle state machine, RBAC+ABAC matrix
  all stay the same.
- The locked stack (Next.js + NestJS + Prisma + Postgres + Redis
  + Coolify) stays the same.
- The 10-week timeline stays the same.
- The Q0–Q16 open questions to the client stay the same.

This is a "how do we wire it up" detail, not a "what do we build"
decision.

---

## What I'd push back on, one more time

**Do NOT have Next.js server components query business tables
directly**, even for "just a quick list of leads for the dashboard."
This creates the second write path. Always go through the NestJS
REST API, even if it adds 50-100ms latency. The latency is invisible;
the bugs from bypassing the API are not.

The one acceptable exception: server components reading the
`User` table to load the current user's profile. This is
read-only, RLS-enforced, and doesn't create a second write path.
better-auth needs this for the session to work, so it's already
in place.

---

## Next step

If you're happy with the Prisma + multi-app + PgBouncer pattern,
just say "apply" and I'll update DESIGN.md §7 (and §5 with the
better-auth schema additions) in the next consolidation.

The two additions to the schema that need to land before any
build:

1. better-auth's required tables: `Account`, `Verification`
   (the v2 brief already has `User` and `Session`, but Account
   and Verification are missing).
2. `Account` model needs specific fields for OAuth provider
   data (provider, providerAccountId, etc.) if you ever want
   "Sign in with Google" - even if you don't, better-auth
   expects the table to exist.

These are 30 lines of schema additions. I'll include them when
I apply this delta.
