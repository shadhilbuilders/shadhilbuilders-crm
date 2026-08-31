# Client Feedback Round 4 — 2026-08-29 (Shadhil CRM)

Decision lock from this round:
- ✅ Option B locked: NestJS + GraphQL + Next.js + Expo + Hostinger VPS via Coolify
- ✅ better-auth BFF in Next.js
- ✅ Prisma for the NestJS backend

Your question: "Can we use better-auth BFF in Next.js or Next.js route
handler for mobile?"

Yes, both. They're the same thing in this case. And the answer has
real depth because better-auth's mobile support is officially
documented, actively maintained, and the integration pattern is
specific. Let me lay it out.

---

## The locked stack

```
Web:        Next.js 16 + TypeScript + Tailwind v4
            + @paalstack/react-ui (only the components the CRM
            needs, not authoring new ones)
Mobile:     Expo (React Native) + Expo Router
BFF:        Next.js Route Handlers (same codebase as web) hosting
            better-auth + any Next.js-specific server logic
Backend:    NestJS 10 + GraphQL (Apollo) + Prisma
Database:   Postgres 16 (Docker on Hostinger VPS, managed by Coolify)
Cache:      Redis 7 (Docker on the same VPS, sessions + chat pub/sub)
Realtime:   graphql-ws subscriptions (in NestJS) over the WebSocket
            gateway, Redis pub/sub for fan-out
Auth:       better-auth (BFF in Next.js, with @better-auth/expo
            plugin for mobile), JWT bridge to NestJS
Storage:    MinIO (S3-compatible, Docker on VPS) — v1.1 only
Messaging:  WhatsApp Cloud API (webhook → NestJS resolver)
Telephony:  Exotel Pro (webhook → NestJS resolver)
Deploy:     Coolify on Hostinger VPS (8GB plan, India region)
            + EAS for Expo mobile builds
```

This is now the locked architecture for DESIGN.md §7.

---

## The BFF question, answered concretely

**The BFF (Backend-For-Frontend) is Next.js itself.** It's not a
separate service. Next.js IS the BFF. Specifically:

- `app/api/auth/[...all]/route.ts` — better-auth's catch-all
  endpoint. Handles login, logout, register, session, OAuth
  callbacks, MFA, password reset. All auth flows land here.
- `app/api/graphql/route.ts` — optional Next.js route handler
  that proxies some calls to NestJS (more on this below).
- `app/api/health/route.ts` — liveness for Coolify's health
  checks.
- Everything else in the CRM UI uses Next.js server components
  or client components that call better-auth for auth state.

**Mobile is NOT a separate BFF.** Mobile uses better-auth's
official Expo plugin to talk to the same Next.js auth endpoints.
The mobile app calls the same `/api/auth/*` URLs as the web app,
gets back a session token (stored in Expo's secure store), and
then uses that session to obtain a JWT for NestJS.

So the BFF serves BOTH web and mobile from one codebase. This is
the documented better-auth pattern.

---

## The three-package monorepo structure

To make this work, you need a monorepo with three packages
(plus a shared types package):

```
shadhil-crm/
├── apps/
│   ├── web/                  # Next.js 16 (BFF + web UI)
│   ├── mobile/               # Expo (React Native)
│   └── backend/              # NestJS 10 (GraphQL API)
├── packages/
│   ├── contracts/            # GraphQL schema + generated TS types
│   ├── auth-client/          # Shared auth helpers (web + mobile)
│   └── ui-tokens/            # Brand tokens (navy #001a4c etc.)
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── .env.example
```

### Why pnpm workspaces

- pnpm 11 is on this machine already.
- pnpm workspaces handle cross-package deps and hoisting cleanly.
- Turborepo/Nx are nice-to-haves for build caching, but not
  required for v1. Add Turborepo in v1.1 if build times hurt.

### packages/contracts

- The GraphQL schema lives here as `schema.graphql`.
- Codegen runs `graphql-codegen` on this schema, produces:
  - TypeScript types for all queries/mutations
  - React hooks (for web) — `useGetLeadQuery`, `useSendMessageMutation`
  - React Native hooks (for mobile) — same hooks, different runtime
  - Apollo Client typed documents
- Web and mobile import the generated hooks. They never hand-write
  GraphQL query strings.
- **This is the single source of truth for the API contract.**
  If you change the schema, codegen regenerates types, both apps
  get a TypeScript error if they don't update.

### packages/auth-client

- Exports `getAuthClient(platform: 'web' | 'mobile')` factory.
- Web: returns the Next.js plugin's auth client.
- Mobile: returns the `@better-auth/expo` client.
- Both share the same TypeScript interface for login/logout/
  session/JWT.
- **This is where you abstract the platform differences.** One
  import in your app code, the platform-specific wiring is
  hidden.

### packages/ui-tokens

- Exports the brand tokens as TS constants.
- Replaces the `app/globals.css` `@theme` block in the landing
  site with a typed TS API.
- Web uses via Tailwind v4's CSS variables; mobile uses via
  StyleSheet.
- **Single source of truth for #001a4c, #62b132, #f8f5ef.**

---

## The auth flow, end-to-end

### Web (Next.js) login

1. User visits `/login`.
2. Form POSTs to `app/api/auth/sign-in/email/route.ts`
   (better-auth's catch-all handles it).
3. better-auth validates credentials, creates a session row in
   the `session` table in Postgres.
4. better-auth sets an httpOnly secure cookie on the response.
5. Browser stores the cookie. Every subsequent request to
   Next.js includes it automatically.
6. Next.js middleware (`middleware.ts`) checks the cookie via
   `getSessionCookie()` from better-auth/next. If invalid,
   redirect to `/login`.
7. Server components use `auth.api.getSession({ headers })` to
   load the full session (user, role, teamId).
8. RSC pages render with the session. UI shows role-appropriate
   actions.

### Web (Next.js) calling NestJS

1. Client component needs to fetch leads. Calls the generated
   `useGetLeadsQuery()` hook.
2. The hook is backed by Apollo Client pointed at
   `NEXT_PUBLIC_NESTJS_URL/graphql` (e.g.,
   `https://crm-api.shadhilbuilders.in/graphql`).
3. Apollo's auth link adds `Authorization: Bearer ***` header.
4. The JWT was obtained from better-auth via the
   `auth.api.getJWT()` call earlier. The token is cached in
   memory (web) or secure store (mobile) with a refresh
   strategy.
5. NestJS receives the GraphQL request, the JWT auth
   middleware verifies the signature, extracts claims
   (`userId`, `role`, `teamId`).
6. NestJS sets Postgres session vars:
   `SET LOCAL app.current_user_id = '...';`
   `SET LOCAL app.current_user_role = 'manager';`
   `SET LOCAL app.current_team_id = '...';`
7. Prisma queries hit Postgres, RLS policies filter rows.
8. Response goes back to the client.

### Mobile (Expo) login

1. User opens the Expo app, lands on the login screen.
2. Form calls `authClient.signIn.email({ email, password })`
   (from `@better-auth/expo`).
3. better-auth validates credentials, creates a session.
4. **Critical Expo-specific bit:** `@better-auth/expo` uses
   `expo-secure-store` to persist the session token on the
   device (Keychain on iOS, EncryptedSharedPreferences on
   Android). The session cookie from better-auth is stored
   there.
5. The mobile app reads the session, calls
   `authClient.getJWT()` to get a JWT.
6. JWT is stored in memory (or secure store with TTL).
7. Apollo Client is configured with the same auth link, adds
   `Authorization: Bearer ***` to every GraphQL request.
8. NestJS receives the request, same flow as web.

### Why this works for both

- The JWT is the contract between BFF (Next.js) and backend
  (NestJS). Once issued, the backend doesn't care which
  client got it.
- better-auth signs JWTs with a secret or RSA key. NestJS
  verifies with the same secret/public key. The
  `better-auth/jwt` plugin handles issuance; NestJS uses
  `jose` or `jsonwebtoken` to verify.
- For self-hosted (VPS), symmetric secret (HS256) is fine.
  For production-grade, switch to RS256 with a key pair —
  NestJS only needs the public key to verify.
- The JWT payload includes the claims NestJS needs:
  `sub` (userId), `role`, `teamId`, `iat`, `exp`.

### CORS — the one thing that will bite you

- Next.js BFF: `https://crm.shadhilbuilders.in` (or
  `https://bff.shadhilbuilders.in` if you split subdomains)
- NestJS backend: `https://crm-api.shadhilbuilders.in`
- Mobile: `exp://192.168.x.x:8081` in dev, no domain in prod
  (native app, no CORS)
- Expo in dev: needs CORS allowlist on BOTH Next.js AND NestJS
  to include `http://localhost:8081` and the LAN IP.
- better-auth config has `trustedOrigins: [...]` listing
  web + dev URLs.
- NestJS GraphQL has CORS middleware with the same allowlist
  (minus mobile, since mobile is native and doesn't trigger
  CORS).
- **Spend half a day on this before writing any feature code.**
  CORS issues derail timelines.

---

## The chat realtime — building it on NestJS

The chat pane is a real engineering piece. With NestJS+GraphQL
(no Supabase Realtime), here's the architecture:

### Server side (NestJS)

- WebSocket gateway at `/graphql` (graphql-ws transport).
- On client connect: client sends `{ authToken: '...' }` in
  `connectionParams`. NestJS verifies the JWT, stores the
  `userId` on the connection context.
- On client subscribe to `messageAdded(leadId: ID!)`:
  NestJS adds the connection to a Redis pub/sub channel
  scoped to that leadId. Auth check: does this user have
  access to this lead? (Reuse the RLS predicate or a
  simplified version.)
- On `sendMessage` mutation: NestJS inserts the message row
  in Postgres, publishes to the lead's Redis channel.
- All subscribers receive the message in real time.

### Client side (web + mobile)

- Apollo Client configured with `graphql-ws` link for
  subscriptions, HTTP link for queries/mutations.
- `useMessageAddedSubscription({ variables: { leadId } })`
  hook fires whenever a new message is published to the
  lead's channel.
- Chat pane renders messages as they arrive.

### Why this is hard

- Auth on WebSocket connect is fiddly. The JWT comes in
  `connectionParams`; you must verify before accepting the
  subscription. One bug = unauthenticated user can
  subscribe to any lead's chat.
- Reconnection logic: when a mobile agent loses signal
  (field agent, spotty 4G), the WS drops. On reconnect, you
  need to:
  - Re-authenticate (re-send JWT in `connectionParams`)
  - Re-subscribe to all the leads the user is viewing
  - Backfill any messages sent while disconnected
- Backfill = `messages` query by `leadId` with `createdAt
  > lastSeenTimestamp`. Cheap, but you must do it.
- Presence ("is the sales exec online right now?") is a
  separate concern. Skip in v1; add in v1.1 if the team
  asks.
- **Time budget: 1.5-2 weeks of work for an engineer who
  hasn't built a subscription server before.** Less for
  someone who has.

---

## Push notifications (separate from chat realtime)

When a sales exec is NOT in the app and a new lead is
assigned, they need a push notification. This is independent
of the chat realtime.

- Web: Web Push API + VAPID keys. ~200 lines of code in a
  Next.js route handler.
- iOS: Apple Push Notification service (APNs) via Expo's
  `expo-notifications`.
- Android: Firebase Cloud Messaging (FCM) via
  `expo-notifications`.
- Expo handles the iOS/Android side with one API. Web is
  separate.
- NestJS triggers the push: when a lead is assigned, the
  mutation handler calls a `notify(userId, payload)`
  service. The service:
  - For mobile users, sends via Expo Push API (single API
    for both platforms).
  - For web users, sends via Web Push with their stored
    VAPID subscription.
- **Time budget: 1 week. Easy to defer to v1.1 if needed.**

---

## The Prisma schema sketch (NestJS backend)

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  phone     String?
  role      Role
  teamId    String?
  team      Team?    @relation(fields: [teamId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  assignedLeads       Lead[]              @relation("AssignedAgent")
  createdLeads        Lead[]              @relation("CreatedBy")
  activities          Activity[]
  sentMessages        Message[]
  leadAssignments     LeadAssignment[]
  managedTeams        Team[]              @relation("TeamManager")
  sessions            Session[]

  @@index([teamId])
  @@index([role])
}

enum Role {
  ADMIN
  MANAGER
  TELECALLER
  SALES_EXECUTIVE
}

model Team {
  id        String   @id @default(cuid())
  name      String
  managerId String
  manager   User     @relation("TeamManager", fields: [managerId], references: [id])
  members   User[]
  leads     Lead[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Project {
  id        String   @id @default(cuid())
  slug      String   @unique
  name      String
  location  String
  units     Unit[]
  leads     Lead[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Lead {
  id           String   @id @default(cuid())
  projectId    String
  project      Project  @relation(fields: [projectId], references: [id])
  teamId       String?  // manager's team
  team         Team?    @relation(fields: [teamId], references: [id])
  
  // Contact
  fullName     String
  phone        String
  email        String?
  source       String   // landing_site, walk_in, magicbricks, etc.
  
  // Status
  status       LeadStatus @default(NEW)
  currentOwnerId String?  // who currently owns this lead
  currentOwner   User?  @relation("AssignedAgent", fields: [currentOwnerId], references: [id])
  createdById    String
  createdBy      User   @relation("CreatedBy", fields: [createdById], references: [id])
  
  // Handoff tracking
  handoffAt       DateTime?
  handoffFromId   String?  // telecaller who handed off
  handoffToUserId String?  // manager who received
  
  // Relations
  assignments   LeadAssignment[]
  siteVisits    SiteVisit[]
  activities    Activity[]
  messages      Message[]
  booking       Booking?
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@index([projectId, status])
  @@index([teamId])
  @@index([currentOwnerId])
}

enum LeadStatus {
  NEW
  CONTACTED
  VISIT_REQUESTED       // customer agreed in principle
  HANDED_OFF_TO_MANAGER // telecaller handed to manager
  ASSIGNED_TO_EXEC      // manager assigned to sales exec
  VISIT_SCHEDULED
  VISITED
  RESCHEDULED
  NO_SHOW
  NEGOTIATION
  BOOKING_INITIATED
  WON
  LOST
  COLD                  // 2+ no-shows, manager review
}

model LeadAssignment {
  id        String   @id @default(cuid())
  leadId    String
  lead      Lead     @relation(fields: [leadId], references: [id])
  fromUserId String? // null = system / lead creation
  toUserId   String
  toUser     User    @relation(fields: [toUserId], references: [id])
  reason     String? // "telecaller_handoff", "manager_assign", "exec_accept"
  notes      String?
  createdAt  DateTime @default(now())
  
  @@index([leadId, createdAt])
}

model SiteVisit {
  id              String   @id @default(cuid())
  leadId          String
  lead            Lead     @relation(fields: [leadId], references: [id])
  salesExecId     String
  scheduledAt     DateTime
  actualVisitAt   DateTime?
  outcome         VisitOutcome @default(SCHEDULED)
  outcomeNotes    String?
  rescheduledFromId String? @unique
  rescheduledFrom   SiteVisit? @relation("Reschedule", fields: [rescheduledFromId], references: [id])
  rescheduledTo     SiteVisit? @relation("Reschedule")
  remindersSent   Json?    // [{sentAt, channel, templateId}]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@index([leadId, scheduledAt])
  @@index([salesExecId, scheduledAt])
}

enum VisitOutcome {
  SCHEDULED
  VISITED
  NO_SHOW
  CANCELLED
  RESCHEDULED
}

model Unit {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  unitNumber  String
  phase       String?
  bhk         String   // "3BHK", "4BHK", "5BHK"
  facing      String?
  sqft        Int
  basePrice   Decimal  @db.Decimal(12, 2)
  status      UnitStatus @default(AVAILABLE)
  booking     Booking?
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@unique([projectId, unitNumber])
  @@index([projectId, status])
}

enum UnitStatus {
  AVAILABLE
  HOLD
  BOOKED
  SOLD
}

model Booking {
  id          String   @id @default(cuid())
  leadId      String   @unique
  lead        Lead     @relation(fields: [leadId], references: [id])
  unitId      String   @unique
  unit        Unit     @relation(fields: [unitId], references: [id])
  tokenAmount Decimal  @db.Decimal(12, 2)
  tokenPaidAt DateTime?
  agreementSignedAt DateTime?
  approvedById String?  // manager who approved
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Activity {
  id        String   @id @default(cuid())
  leadId    String
  lead      Lead     @relation(fields: [leadId], references: [id])
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  type      ActivityType
  payload   Json     // type-specific data
  createdAt DateTime @default(now())
  
  @@index([leadId, createdAt])
}

enum ActivityType {
  NOTE
  CALL
  WHATSAPP
  EMAIL
  STATUS_CHANGE
  ASSIGNMENT
  VISIT_OUTCOME
}

model Message {
  id          String   @id @default(cuid())
  leadId      String
  lead        Lead     @relation(fields: [leadId], references: [id])
  senderId    String   // user (internal) or external customer
  sender      User     @relation(fields: [senderId], references: [id])
  direction   MessageDirection
  channel     MessageChannel
  body        String
  externalId  String?  // WhatsApp message ID for dedup
  createdAt   DateTime @default(now())
  
  @@unique([externalId, channel])  // dedup webhook deliveries
  @@index([leadId, createdAt])
}

enum MessageDirection {
  INBOUND   // from customer
  OUTBOUND  // to customer
}

enum MessageChannel {
  WHATSAPP
  IN_APP
  SMS
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())
  
  @@index([userId])
  @@index([expiresAt])
}

model AuditLog {
  id        String   @id @default(cuid())
  userId    String?
  action    String   // "lead.view", "lead.update", "auth.login", etc.
  resource  String?  // "Lead:abc123"
  metadata  Json?
  ipAddress String?
  userAgent String?
  createdAt DateTime @default(now())
  
  @@index([userId, createdAt])
  @@index([resource, createdAt])
  @@index([createdAt])  // for retention purges
}

model ManagerAssignmentRule {
  id         String   @id @default(cuid())
  managerId  String
  projectId  String
  territory  String?  // e.g., "Tambaram West"
  priority   Int      @default(0)
  active     Boolean  @default(true)
  createdAt  DateTime @default(now())
  
  @@index([projectId, territory, active])
}
```

The RLS policies go in a separate migration file. They're
applied via `prisma migrate dev` and run as raw SQL.

---

## What I'll do next (when you say go)

1. Rewrite DESIGN.md §7 with this locked stack.
2. Add §8.5 "Monorepo layout" with the structure above.
3. Add §12 "Auth flow" with the BFF + JWT bridge.
4. Add §13 "Realtime chat" with the graphql-ws + Redis
   architecture.
5. Add §14 "Push notifications" with the Expo + Web Push
   plan.
6. Update §11 timeline to 10 weeks for v1.
7. Update CLIENT-QUESTIONS.md with the 4 new open questions.

---

## What I need from you to apply this

Just say "apply" (or "go") and I'll rewrite DESIGN.md against
this delta. If you want changes, name them.

The one open question I have for you: **which subdomain
structure do you want for the BFF vs backend?**

Option 1 (split subdomains — clean, my recommendation):
- BFF (Next.js): `crm.shadhilbuilders.in`
- Backend (NestJS): `crm-api.shadhilbuilders.in`
- Mobile: native, no domain
- Pro: clean separation, easy to scale independently
- Con: 2 DNS records, 2 SSL certs (Coolify handles both
  automatically)

Option 2 (same domain, path-based — simpler):
- BFF: `crm.shadhilbuilders.in` (Next.js)
- Backend: `crm.shadhilbuilders.in/api/graphql` (NestJS
  reverse-proxied through Next.js or via a Coolify reverse
  proxy)
- Pro: 1 domain, 1 SSL
- Con: tighter coupling, harder to scale backend independently

Option 3 (same domain, different paths via Coolify):
- BFF: `crm.shadhilbuilders.in` (Next.js)
- Backend: `crm.shadhilbuilders.in/backend/graphql` (Coolify
  reverse proxy)
- Same as option 2 but more explicit

My pick: Option 1 (split subdomains). It's the cleanest pattern
and Coolify handles the SSL/DNS for free. Tell me if you want
something different.
