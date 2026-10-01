# Client Feedback Round 5 - 2026-08-29 (Shadhil CRM)

You asked: "Can we use REST instead of GraphQL? I only said GraphQL
because easy integration for mobile app. Is it true?"

Honest answer: **half-true. And for THIS CRM, REST is the better
choice.** Switching.

---

## The half-truth about GraphQL for mobile

GraphQL's mobile pitch (from ~2019-2021) was: "one endpoint, ask
for exactly the fields you need, avoid over-fetching on slow
networks." Real for some apps, not for yours.

Where GraphQL is genuinely better:
- Multiple clients (iOS, Android, web, third-party) needing
  different data shapes for the "same" entity.
- Aggregating 5+ backend services into one API.
- Public APIs consumed by external developers.
- Server-side batching of N+1 query problems.

Where the pitch FAILS for Shadhil CRM specifically:
- **You have 3 clients, all needing the same data shapes.**
  Web, iOS, Android all want "lead detail." GraphQL's
  client-shape flexibility doesn't help.
- **TanStack Query is what you'd actually use in 2026**, not
  Apollo Client. TanStack Query works with REST and GraphQL
  equally well. The "GraphQL is easier on mobile" claim
  predates the TanStack Query era.
- **REST + TanStack Query can do parallel queries with one
  hook** (`useQueries`). The latency difference vs GraphQL's
  "one query gets everything" is 50-100ms, invisible on
  real-world Chennai 4G.
- **For the chat pane**, you don't need GraphQL subscriptions.
  Server-Sent Events (SSE), plain WebSockets, or even 5-second
  polling all work. SSE is the simplest.
- **GraphQL has real downsides for this stack** (see below).

---

## The seven reasons REST wins for this CRM

### 1. Codegen complexity drops by 80%

With GraphQL, you need:
- A `schema.graphql` file as single source of truth
- `graphql-codegen` configured for both web and mobile
- A `packages/contracts` package
- Apollo Client OR a custom TanStack Query fetcher
- TypeScript types generated from the schema

With REST, you need:
- TypeScript types defined once (or generated from Prisma)
- TanStack Query hooks (you write them, ~20 lines per endpoint)
- `zod` schemas for runtime validation
- A simple `fetch` wrapper with auth header injection

The GraphQL version is "magic" but the magic breaks. The REST
version is explicit and debuggable.

### 2. NestJS REST is the default, well-trodden path

Every NestJS dev knows REST controllers. `@Controller('leads')`
with `@Get()`, `@Post()`, `@Patch()` is the bread and butter.
GraphQL with NestJS requires `@nestjs/graphql` + `@nestjs/apollo`
+ schema-first OR code-first, plus resolvers instead of
controllers. It works, but it's a non-trivial setup with a
learning curve.

For "reusable infra" value, REST NestJS is the most marketable
skill. GraphQL NestJS is narrower.

### 3. HTTP caching is free with REST, broken with GraphQL

REST `GET /leads` returns JSON with proper cache headers →
CDN/browser/SWR cache. Same data, 5 users hit it, the second
through fifth hit cache, not the backend.

GraphQL is a POST. POSTs are not cached by default. You'd need
to implement custom cache logic (Apollo Cache, persisted queries,
or a custom cache layer). For a CRM with the same "list of
leads" screen loaded repeatedly, REST is a free performance win.

### 4. File uploads are trivial with REST, painful with GraphQL

Document Vault is in v1.1. With REST, you `POST /documents`
with `multipart/form-data`. Standard. Every HTTP client supports
it. The NestJS `@UseInterceptors(FileInterceptor(...))` pattern
is well-documented.

With GraphQL, you need the `graphql-multipart-request-spec`
extension. Server-side support exists (`graphql-upload`),
client-side support varies (Apollo Client + `apollo-upload-client`).
Works, but it's an extra dependency and a non-obvious setup.

### 5. Command-line debugging is straightforward

REST: `curl https://api.crm.shadhilbuilders.in/leads/abc -H "Authorization: Bearer ***`. See JSON. Done.

GraphQL: write a query, POST it, parse the response. More steps.
`curl` works but it's awkward.

For 11 PM Saturday debugging, REST is faster.

### 6. Mobile and web use the same REST client

- Web: TanStack Query + native `fetch` (or `axios`).
- Mobile: TanStack Query + native `fetch` (works in React Native).
- Same hooks, same caching, same error handling.
- 12M+ weekly TanStack Query downloads. Standard in 2026.

With GraphQL, mobile and web would both need Apollo Client, OR
both need a custom TanStack Query fetcher that adds GraphQL
complexity to a library that's REST-native. The latter is what
the 2026 consensus recommends (Re:Earth's engineering blog
argues this), but it's more code than REST.

### 7. The "complex screen needs many entities" case is overstated

For Lead Detail (lead + activities + site visits + messages +
booking + unit + project), the GraphQL version is:

```graphql
query GetLeadDetail($id: ID!) {
  lead(id: $id) {
    id fullName phone status
    activities { id type createdAt }
    siteVisits { id scheduledAt outcome }
    messages { id body createdAt direction }
    booking { tokenAmount unit { unitNumber } }
  }
}
```

The REST version is:

```typescript
const { data: lead } = useLead(id)
const { data: activities } = useActivities(id)
const { data: visits } = useSiteVisits(id)
const { data: messages } = useMessages(id)
const { data: booking } = useBooking(id)
// All 5 fire in parallel. Total latency: max(slowest), not sum.
```

TanStack Query fires all 5 in parallel. Total time = slowest
single request, not the sum. On a real connection, the
difference vs the GraphQL version is 50-100ms. The user can't
tell.

If you want the GraphQL "one query" behavior, TanStack Query
has `useQueries` with dependencies - fire 5 queries, return a
joined object. Same code shape, REST underneath.

---

## What REST loses

For full honesty, here's what you give up:

1. **Auto-generated documentation.** GraphQL's schema IS the
   docs. REST needs OpenAPI (separate file, easy to drift).
   Mitigation: use `@nestjs/swagger` which generates OpenAPI
   from your NestJS controllers automatically. You get
   `/api/docs` Swagger UI for free.

2. **Single source of truth for the data shape.** GraphQL's
   schema is the contract. REST's contracts are in
   TypeScript types, which you write or generate. If the
   backend changes a response shape and forgets to update
   the type, you get a runtime error. Mitigation: generate
   the types from Prisma. Prisma schema → TypeScript types
   automatically. Single source of truth lives in `schema.prisma`.

3. **Field-level evolution.** GraphQL lets you deprecate
   fields gracefully. REST needs versioning (`/v1/leads`,
   `/v2/leads`) or breaking changes. For a 5-50 user
   internal tool, this is a non-issue. You control both
   ends. Just bump the version when you need to.

4. **Aggregate-from-many-services case.** If you ever need
   to combine data from 3+ microservices, GraphQL shines.
   You have ONE backend service. Not relevant.

The losses are real but small. The wins are real and big.

---

## The locked stack (v5)

```
Web:        Next.js 16 + TypeScript + Tailwind v4
            + @paalstack/react-ui
Mobile:     Expo (React Native) + Expo Router
BFF:        Next.js Route Handlers hosting better-auth
Backend:    NestJS 10 + REST controllers + Prisma
Database:   Postgres 16 (Docker on Hostinger VPS, Coolify)
Cache:      Redis 7 (Docker, sessions + SSE fan-out for chat)
Auth:       better-auth (BFF in Next.js + @better-auth/expo
            for mobile) + JWT bridge to NestJS
Realtime:   Server-Sent Events (SSE) from NestJS for the
            chat pane + Redis pub/sub for fan-out across
            multiple NestJS instances
API docs:   @nestjs/swagger (auto-generated OpenAPI)
State:      TanStack Query (web + mobile, 12M+ weekly
            downloads, the 2026 standard)
Push:       Expo Notifications (iOS + Android) + Web Push
Messaging:  WhatsApp Cloud API (webhook → NestJS controller)
Telephony:  Exotel Pro (webhook → NestJS controller)
Deploy:     Coolify on Hostinger VPS (8GB plan, India)
            + EAS for Expo mobile builds
```

Same as v4 except:
- GraphQL → REST
- Apollo Client → TanStack Query
- graphql-ws subscriptions → SSE
- `packages/contracts` simplified (just shared types, no
  codegen from schema)
- `@nestjs/swagger` added for OpenAPI docs

---

## What changes in the monorepo

```
shadhil-crm/
├── apps/
│   ├── web/              # Next.js 16 (BFF + web UI)
│   ├── mobile/           # Expo (React Native)
│   └── backend/          # NestJS 10 (REST API)
├── packages/
│   ├── api-types/        # Generated from Prisma + manual types
│   ├── auth-client/      # Shared auth helpers (web + mobile)
│   └── ui-tokens/        # Brand tokens
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`packages/api-types` is simpler now:
- Run `prisma generate` in the backend, copy the generated
  types to `packages/api-types/src/db.ts`.
- Manually write request/response types for the few that
  diverge from the Prisma model.
- Web and mobile import from `packages/api-types`.

No codegen, no schema files, no magic. Just TypeScript.

---

## The chat realtime - SSE is the right pick

SSE is one-way (server → client), which is exactly what a
chat needs (the client sends messages via a normal POST, the
server pushes new incoming messages via SSE).

### Why SSE over WebSockets for this case

- SSE is plain HTTP. No upgrade dance, no separate server
  process, works through every proxy and CDN.
- SSE auto-reconnects on disconnect. Browsers handle this
  for free.
- SSE works in React Native via the `react-native-sse`
  package.
- WebSockets are two-way, which you don't need (you POST
  messages, you receive via SSE).
- WebSockets are a separate server in NestJS (different
  transport, different auth flow, different error handling).
- SSE is just an HTTP endpoint in NestJS. Same controllers,
  same auth, same validation.

### Architecture

```
Client (web/mobile)
  ↓ POST /leads/:id/messages  (send a message)
  ↓ GET  /leads/:id/stream     (open SSE connection)
  ↑ SSE event: { type: "new_message", data: {...} }
```

NestJS:
- `POST /leads/:id/messages` - saves the message, publishes
  to Redis channel `lead:{id}:messages`.
- `GET /leads/:id/stream` - NestJS SSE handler. Subscribes
  to Redis channel, forwards each event to the client.
- Auth: JWT in `Authorization` header for POST, JWT in
  query param for SSE (because `EventSource` doesn't support
  custom headers). Same JWT verification.
- RLS still applies: the GET stream query checks the user
  can see this lead before subscribing.

### The cost

- 1 SSE endpoint in NestJS (~30 lines).
- 1 Redis pub/sub publish on message save (~5 lines).
- 1 client-side SSE hook (TanStack Query has a pattern
  for this via `useInfiniteQuery` or a small custom hook,
  ~40 lines).
- **Total: 2-3 days of work** vs 1.5-2 weeks for GraphQL
  subscriptions.

---

## What stays the same

Everything else from v4 carries over:
- Roles (Admin / Manager / Telecaller / Sales Executive)
- Modules (Lead Inbox, Lead Detail, Site Visit Scheduler,
  Inventory, In-app Chat, Audit Log, thin Booking)
- Lifecycle states
- RBAC + ABAC via Postgres RLS
- better-auth BFF in Next.js
- @better-auth/expo for mobile
- JWT bridge to NestJS
- Prisma schema (12 models)
- Monorepo structure (simplified)
- VPS sizing (8GB Hostinger)
- Subdomain structure (crm + api.crm, or pick option B/C)
- 10-week timeline to v1 (now slightly faster - REST saves
  1-2 weeks of GraphQL setup, SSE saves another 1-2 weeks
  of subscription server work)

---

## What I'd push back on, one more time

The one thing I want to flag clearly: **this conversation
has gone through 5 rounds of feedback in one session.** That's
normal for an early brief, but it also means we have:
- DESIGN.md v1 (PM agent's first cut)
- 4 delta files (v1.1 through v1.4 → now v1.5)

When you say "apply," I'll consolidate everything into a
single DESIGN.md v2, with the original 10 sections plus
additions for monorepo, auth flow, realtime chat, push, and
the locked stack. The delta files then become the change
log.

OR, if you want, I can re-delegate through the Product
Manager specialist with the locked brief as context and
have it produce a clean v2 in one shot. That path loses
the trace but is faster.

Tell me:
1. **REST** confirmed (my recommendation)?
2. **Subdomain structure** (Option 1, 2, or 3 from v4)?
3. **Apply now** = rewrite DESIGN.md v2 in one pass, OR
   **re-delegate** = have PM specialist produce v2 fresh?

If you don't answer #3, I'll assume "apply now" - that's
the path that preserves the reasoning trail from these 5
rounds.
