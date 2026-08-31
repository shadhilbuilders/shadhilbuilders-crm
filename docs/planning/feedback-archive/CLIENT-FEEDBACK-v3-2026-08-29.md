# Client Feedback Round 3 — 2026-08-29 (Shadhil CRM)

This is a delta on top of `DESIGN.md` (v1) and the two previous delta files
(`CLIENT-FEEDBACK-2026-08-29.md` and `CLIENT-FEEDBACK-v2-2026-08-29.md`).
You told me to drop the PaalStack pattern matching and evaluate the stack
on real-world merit for a CRM. Doing that now.

---

## Headline take

Your three decisions are defensible, but they have a real cost you should
see clearly before locking them in. Summary, then details:

1. **"Easy and best stack for CRM"** — depends on whether you mean
   *fastest to ship* or *most scalable long-term*. They pull in opposite
   directions. I've laid out the real tradeoffs below. For a 5-50 user
   internal CRM, the conventional full-stack (Next.js OR a single
   backend) ships faster than a split NestJS+GraphQL+separate-frontend
   stack. The split stack is genuinely better at 50K+ users or 5+
   engineers. Below that, it's over-engineering you pay for in
   time-to-MVP and ongoing ops.

2. **NestJS + GraphQL backend on Hostinger VPS via Coolify** — works,
   real pattern, lots of teams do it. Three real costs: (a) splits
   the codebase into 3 instead of 2, (b) makes auth + RLS noticeably
   harder than the Next.js full-stack case, (c) puts you on call for
   VPS/network/DB backup failures. If you've already proven you can
   run OmniRoute stable on a self-hosted setup (you have, on this
   machine), the operational risk is real but manageable.

3. **"Best and easy"** — for THIS scope, the honest answer is "easy"
   wins. You can refactor to a more complex stack at 10K users. You
   can't un-spend 8 weeks of dev time on architecture that didn't
   need to exist yet. But if the *learning* is part of the value
   (NestJS + GraphQL is a marketable skill), the cost is worth
   paying for that reason.

I'll lay out three concrete stack options below, with honest pros/cons
and a recommendation. The recommendation is not "what I usually pick"
— it's "what fits this specific project, your stated constraints, and
the cost of getting it wrong."

---

## The real-world options, evaluated cold

### Option A: Next.js full-stack + Supabase (the "ship in 6 weeks" path)

```
Web:        Next.js 16 (App Router) + TypeScript + Tailwind v4
            + @paalstack/react-ui
Mobile:     Expo (React Native) + Expo Router, monorepo with web
Backend:    Next.js Route Handlers (same codebase as web)
            + Supabase client-side for CRUD
Database:   Supabase (Postgres + RLS, Mumbai region)
Auth:       Supabase Auth (built-in, RLS-integrated, free up to 50K MAU)
            OR better-auth (more flexible, more setup)
Realtime:   Supabase Realtime (websocket, built into the chat pane)
Storage:    Supabase Storage (for the document vault in v1.1)
Messaging:  WhatsApp Cloud API (webhook → Next.js route handler → DB)
Telephony:  Exotel Pro (webhook → Next.js route handler → DB)
Deploy:     Vercel for web ($0-20/mo), EAS for mobile (free-$99/mo),
            Supabase free or Pro ($0-25/mo)
Total ops:  $0-45/month
Dev time:  4-6 weeks to MVP
```

**Pros (real-world, not PaalStack-flavored):**
- One frontend codebase (Next.js), one mobile codebase (Expo), zero
  separate backend. Shared `lib/` between web and mobile.
- Supabase Realtime gives you a working chat pane in 50 lines of
  React (websocket subscribe to `messages` table). No socket server
  to build, no Redis pub/sub, no auth-on-reconnect dance.
- Supabase Auth + RLS = the auth/ABAC layer is mostly config, not
  code. Postgres policies express "manager can see their team's
  leads" in 3 lines of SQL.
- Vercel cold starts are non-issues for a 5-50 user tool. Builds
  are 60s. Deploys are `git push`.
- Migrations are `supabase db push` from CI. Backups are daily +
  point-in-time recovery on the Pro plan.
- Scaling ceiling: 100K+ users on this stack. Real companies
  (Cal.com, Supabase itself) run production on Next.js + Supabase.

**Cons (honest):**
- Vendor lock-in. If Supabase dies or you outgrow the free tier,
  you migrate. Mitigation: Supabase is Postgres, the schema is
  yours, you can `pg_dump` and move.
- Vercel bills can surprise you. Mitigation: set billing alerts
  at $20, $50, $100.
- Real-time subscriptions cost connections. Mitigation: cap at
  500 concurrent for free tier, 10K on Pro.

**Time-to-MVP for THIS CRM: 4-6 weeks.**

---

### Option B: NestJS + GraphQL + Next.js + Expo + Hostinger VPS (your proposed path)

```
Web:        Next.js 16 + TypeScript + Tailwind v4
Mobile:     Expo (React Native) + Expo Router
Backend:    NestJS 10 + GraphQL (Apollo) + TypeORM/Prisma
Database:   Postgres 16 (self-hosted in Docker, on the VPS)
Cache:      Redis 7 (self-hosted in Docker, sessions + BullMQ)
Auth:       Passport.js + JWT (in NestJS) OR better-auth
            (as a separate service) OR Keycloak (heavy)
Realtime:   graphql-ws subscriptions over the NestJS WebSocket gateway
            OR a separate Socket.IO server
Storage:    MinIO (S3-compatible, self-hosted) OR Hostinger S3
Messaging:  WhatsApp webhook → NestJS resolver
Telephony:  Exotel webhook → NestJS resolver
Deploy:     Coolify (self-hosted PaaS on Hostinger VPS, Docker
            Compose under the hood), EAS for mobile
Total ops:  $12-30/month (VPS only)
Dev time:  8-12 weeks to MVP
```

**Pros (real-world):**
- Full control. No vendor. You own every byte. You can read the
  source. You can patch things at 2 AM.
- NestJS is genuinely a pleasure to develop in if you like
  TypeScript with decorators. Strong typing everywhere, good
  module system, battle-tested in production at Adidas, Decathlon,
  etc.
- GraphQL is the right choice for a CRM with complex relational
  data (lead → activities → site visits → bookings → units →
  projects → users → teams). One query gets the full lead
  detail. REST would need 5-7 round-trips.
- Hostinger VPS India region = low latency to WhatsApp Cloud
  API, low latency to Exotel. Good for chat real-time feel.
- Coolify is a real product, not a toy. Self-hosters use it.
  Built-in: SSL, DB, Redis, backups, monitoring, deploys from
  Git. Free. Self-hosted.
- You already self-host OmniRoute successfully. The operational
  muscle is there.
- Stack is highly marketable. NestJS + GraphQL is what a lot of
  mid-size companies want to hire for.

**Cons (honest, the things you should know):**

1. **Three codebases, three repos (or one monorepo with three
   packages).** Web, mobile, backend. Shared types via codegen
   from the GraphQL schema. The codegen setup is where teams
   spend their first week being frustrated.
2. **Auth is harder.** better-auth is a Next.js library. If your
   backend is NestJS, you have three options:
   - (a) Run better-auth in Next.js as a BFF, proxy GraphQL
     calls to NestJS through Next.js. Adds a hop, ~50ms
     latency, but keeps auth clean.
   - (b) Implement auth in NestJS with Passport.js + JWT.
     Duplicates user state. RLS session vars must be set per
     GraphQL request, easy to forget.
   - (c) Run Keycloak in Docker on the VPS. Real solution,
     adds 1GB RAM to the VPS, another service to maintain.
3. **RLS is harder.** Supabase has a Next.js-shaped RLS pattern.
   With NestJS + GraphQL, you have to wire the session var
   setting into either every resolver (slow), or a request-
   scoped interceptor (works, but you must remember to add it
   to every new resolver). Forget once → security bug.
4. **Real-time chat is more code.** graphql-ws subscriptions
   work, but you need: ws server, auth-on-subscribe, room
   management, message persistence, presence tracking, offline
   queue. Supabase Realtime gives you this in 50 lines of
   client code. With NestJS, it's a 1-2 week mini-project.
5. **Backup / restore is your job.** Supabase Pro has daily
   backups + point-in-time recovery. With self-hosted
   Postgres, you write the `pg_dump` cron, you store the
   dumps somewhere off-VPS (Backblaze B2 is ~$5/TB-month),
   you test the restore quarterly. If you skip the test,
   you'll find out the backup was corrupt the day you need it.
6. **Coolify has its own upgrade cycle.** When Coolify ships
   a new version, you upgrade Coolify. When Coolify ships a
   breaking change, your apps break. This is the same
   risk as any self-hosted platform.
7. **Hostinger VPS has constraints.** Their cheapest plans
   (~$8/month) have 1-2GB RAM. NestJS + Postgres + Redis +
   Coolify + Next.js = at least 4GB RAM, ideally 8GB. Budget
   $20-30/month for a 4-8GB plan.
8. **You are the on-call.** Supabase's status page doesn't
   matter to you. Hostinger's status page does. When the
   VPS goes down at 11 PM Saturday, that's your phone.
9. **Time-to-MVP doubles.** Realistically 8-12 weeks for the
   same scope vs 4-6 weeks for Option A. The architecture
   decisions, the monorepo setup, the codegen config, the
   RLS-with-GraphQL pattern, the auth shim, the chat
   subscription server — each one is a week.

**Scaling ceiling: 1M+ users on this stack.**

---

### Option C: Hybrid (Supabase DB+auth+realtime, NestJS for API+webhooks)

This is what I'd actually build if forced to use NestJS for the
learning. Best of both, but you pay in operational complexity.

```
Web:        Next.js OR React (your call, can be simpler)
Mobile:     Expo
Backend:    NestJS (only for: WhatsApp webhook receiver,
            Exotel webhook receiver, complex business logic
            that doesn't fit RLS, the audit log writer)
Database:   Supabase (Postgres + RLS + auth + realtime)
Auth:       Supabase Auth (with NestJS verifying JWTs)
Realtime:   Supabase Realtime (chat pane uses this directly,
            no NestJS involvement)
```

**Pros:** Supabase does the hard parts (DB, auth, realtime, RLS).
NestJS does the things that are legitimately complex business
logic. You get the NestJS learning without paying the full
operational cost.

**Cons:** Two backends (Supabase + NestJS) to reason about. Not
actually simpler than Option A; just shifts complexity around.

**Time-to-MVP: 6-8 weeks.**

---

## My honest recommendation, real-world, for this specific project

**For Shadhil CRM specifically, I'd ship Option A.** Here's why,
without the PaalStack flavor:

- It's a 5-50 user internal tool, not a public SaaS. The
  scaling concerns that justify NestJS+GraphQL+self-host don't
  apply for 2+ years.
- The chat pane is the hardest engineering piece. Supabase
  Realtime gives you 80% of it for free. Building it on
  graphql-ws + Redis pub/sub + presence tracking is 2 weeks
  of work for the same result.
- RLS for ABAC is the second-hardest piece. Postgres RLS is
  the right tool, but the Next.js-shaped Supabase pattern
  is much better documented than the NestJS-shaped one.
- The cost savings of self-hosting are $30-50/month. The
  opportunity cost of the extra 4-6 weeks of dev time is
  $3,000-6,000 at your loaded rate. The math doesn't favor
  Option B at this scale.

**But —** if your real goal is "I want NestJS + GraphQL in my
portfolio for the next 5 client projects," then Option B is the
right call. The 4-6 extra weeks are an investment, not waste.
And the architecture genuinely IS more scalable for when
Shadhil grows from 5 users to 50.

The decision rule: **are you optimizing for "ship this CRM
fast" or "build infrastructure for the next 5 CRMs"?**

If fast: Option A.
If reusable infra: Option B.

---

## What changes in DESIGN.md if you take Option B (your path)

§7 Tech stack — full rewrite:

```
Web:        Next.js 16 + TypeScript + Tailwind v4
Mobile:     Expo (React Native) + Expo Router — v1.1, PWA first in v1
Backend:    NestJS 10 + GraphQL (Apollo) + TypeORM (or Prisma)
Database:   Postgres 16 (Docker container on Hostinger VPS via Coolify)
Cache:      Redis 7 (Docker container, sessions + pub/sub for chat)
Auth:       Passport.js + JWT in NestJS
            (OR better-auth as a BFF in Next.js — TBD)
Realtime:   graphql-ws subscriptions + Redis pub/sub
Storage:    MinIO (S3-compatible, self-hosted in Docker)
Messaging:  WhatsApp Cloud API (webhook → NestJS resolver)
Telephony:  Exotel Pro (webhook → NestJS resolver)
Deploy:     Coolify on Hostinger VPS (4-8GB plan, Mumbai/India region)
```

Auth is the main TBD. Two viable options:

1. **better-auth as a BFF in Next.js** — Next.js handles login,
   session, password reset. Next.js proxies GraphQL calls to
   NestJS with a service token. NestJS trusts the token, sets
   the RLS session var from the JWT claims. Cleanest if you
   want better-auth's UX.

2. **Passport.js + JWT in NestJS** — NestJS owns the entire auth
   surface. Web/mobile both call NestJS for login. JWTs are
   short-lived (15 min) + refresh tokens. More control, more
   code, more security surface to test.

My pick: **option 1 (better-auth BFF)** for v1, because RBAC+ABAC
is the v1 ask and better-auth's permission plugin is already
built. Migrate to option 2 in v1.1 if you need more control.

VPS sizing for Hostinger:
- 2GB plan: too small. NestJS + Postgres + Redis + MinIO + Coolify
  needs at least 4GB.
- 4GB plan: works for development, tight for production.
- 8GB plan: comfortable. ~$30/month.
- Pick 8GB. Save 2 hours/month of debugging OOMs.

---

## Updated timeline, real-world, if you go Option B

Week 1: VPS setup (Coolify install, DNS, SSL), NestJS scaffold,
        Next.js scaffold, monorepo setup, codegen skeleton.
Week 2: Postgres schema (Drizzle or Prisma), first migration,
        RLS policies written, NestJS GraphQL resolvers for
        `User`, `Team`, `Project`.
Week 3: better-auth (or Passport) wired in, login/logout working
        on web and mobile, RLS session-var middleware proven.
Week 4: Lead CRUD via GraphQL, Lead Inbox page on web.
Week 5: Chat pane + Supabase Realtime OR graphql-ws subscriptions
        (pick before week 1, this drives 2 weeks of work either
        way). WhatsApp webhook handler.
Week 6: Site Visit entity + scheduler UI, no-show/reschedule
        outcomes, Exotel webhook handler.
Week 7: Inventory grid, booking slice, audit log writer.
Week 8: Manager handoff flow, role permissions tested end-to-end,
        seed data, deploy to Hostinger, first smoke test.
Week 9-10: Bug fixes, real WhatsApp/Exotel testing (needs Meta
           production approval, that's been pending since Aug 27).

Real-world: 10 weeks to v1, not 6-8 weeks. The 8-week number
assumes the codegen, RLS, and real-time chat patterns are
already in your muscle memory. First time, budget 10.

---

## What stays the same regardless of stack choice

- §1 Roles (Admin / Manager / Telecaller / Sales Executive)
- §2 Modules (Lead Inbox, Lead Detail, Site Visit Scheduler,
  Inventory, In-app Chat + thin Booking + Audit Log)
- §3 Lifecycle (handoff at "customer agreed to visit," no-show
  / reschedule / cold states)
- §6 Integrations (WhatsApp, Exotel, landing-site webhook)
- §8 Metrics (same 5 + handoff latency + no-show rate)
- §11 Permission matrix (RBAC + ABAC, enforced via Postgres RLS)
- Manager handoff default, with rule-based auto-routing in v1.1
- Exotel call recording on by default for the cloud number

---

## What I'd still push back on, even if you go Option B

1. **ORM choice still matters.** Drizzle is faster and lighter
   than Prisma; Prisma is more familiar. For a NestJS backend
   specifically, both work. If you have Prisma experience, take
   Prisma. If neither, Drizzle is 2 days to learn, Prisma is
   2 days to learn. Pick one and move on.

2. **Don't add Keycloak unless you need SSO for >1 app.** For
   one app, Passport.js + JWT is fine. Keycloak is the right
   answer when Shadhil has 3+ apps and wants one login.

3. **Don't add Kubernetes.** Coolify + Docker Compose on one
   VPS is enough until you have 1000+ concurrent users. K8s
   is a part-time job to operate.

4. **MinIO only if you actually need file storage in v1.**
   The document vault was deferred to vNext. If you skip
   MinIO in v1, your VPS only needs NestJS + Postgres +
   Redis. Drops to 4GB plan.

5. **Push notifications on mobile = Firebase Cloud Messaging
   (FCM) for Android, Apple Push Notification Service (APNs)
   for iOS.** Both are free. Add `expo-notifications` to
   the Expo app. This is independent of the stack choice.

---

## What I need from you to lock the stack

Three questions:

1. **"Fast" or "reusable infra"?** This decides A vs B above.
2. **If Option B: better-auth BFF or Passport.js in NestJS?**
3. **If Option B: Drizzle or Prisma for the NestJS backend?**
   (I genuinely have no strong preference here for NestJS.
   Pick the one you want to learn.)

Once you answer, I'll rewrite DESIGN.md §7 with the locked
stack and update the timeline in §11.
