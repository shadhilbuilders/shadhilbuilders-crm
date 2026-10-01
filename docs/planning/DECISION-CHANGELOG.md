# Shadhil CRM - Change Log

A trace of every design decision in this directory, in order.

## Round 0 - 2026-08-29, 19:41 UTC - PM-agent first brief

`DESIGN.md` (v1) saved. Delegated to the `agency_agents` Product
Manager specialist. 10 sections: roles (Sales Agent + Sales Manager +
Admin + Marketing), 8 modules, single-owner lifecycle state machine,
MVP = 5 modules + thin booking, multi-project data model, 6
integration touchpoints, stack = Next.js + Drizzle + Neon + Vercel,
5 success metrics, 8 open questions, 7 out-of-scope items.

## Round 1 - 2026-08-29, ~20:00 UTC - Client's first call

`CLIENT-FEEDBACK-2026-08-29.md` saved. Client revealed:
- Roles are actually 4 distinct: Admin (1, super-user), Manager
  (multiple, manages telecallers + execs), Telecaller (first touch),
  Sales Executive (closer, post-handoff).
- Two-stage ownership with hard handoff gate at "customer agreed
  to visit" - single `assignedTo` field is wrong.
- Chat interface is a first-class MVP module, not an activity log.
- Permission matrix is missing.
- Cloud telephony (Exotel/Tata Tele/Knowlarity) gets promoted
  from defer to must-have.
- Audit log writes in v1, UI in vNext.
- 6 new open questions added (Q9–Q15).

## Round 2 - 2026-08-29, ~20:30 UTC - Stack pushback

`CLIENT-FEEDBACK-v2-2026-08-29.md` saved. User asked about Supabase
+ Prisma + better-auth instead of Neon + Drizzle + NextAuth, and
web + Android + iPhone apps, and direct telecaller → exec
assignment, and no-show follow-up, and RBAC + ABAC.

Decisions:
- "Director" → **Manager** (clearer in Indian real-estate).
- **Supabase** over Neon (free tier + RLS + Mumbai region).
- **Prisma** accepted (Drizzle push-back noted but user chose Prisma).
- **better-auth** over Supabase Auth (MIT, no per-user pricing).
- **Web + mobile both in v1** - recommend PWA first, Expo in v1.1.
- **Direct telecaller → exec: NO** for v1, manager handoff stays
  default. `ManagerAssignmentRule` table designed in for v1.1.
- **No-show / reschedule states in v1**, not vNext.
- **RBAC + ABAC both from day 1** (per PaalStack saas-mvp-architecture
  skill default at the time).

## Round 3 - 2026-08-29, ~20:50 UTC - Real-world stack evaluation

`CLIENT-FEEDBACK-v3-2026-08-29.md` saved. User said: drop the
PaalStack pattern matching, evaluate stacks for real-world fit.
User also said: NOT using Vercel, will use NestJS + GraphQL
backend on Hostinger VPS via Coolify.

Decision: **Option B (NestJS + GraphQL + VPS) locked**, with
explicit acknowledgement of the 3-4× slower time-to-MVP cost
in exchange for "reusable infra" value.

## Round 4 - 2026-08-29, ~21:10 UTC - BFF pattern locked

`CLIENT-FEEDBACK-v4-2026-08-29.md` saved. User asked: "Can we
use better-auth BFF in Next.js or Next.js route handler for
mobile?"

Verified `@better-auth/expo` (v1.6.29, 15+ projects) is the
official mobile plugin. Decision: **better-auth BFF in Next.js
serves BOTH web and mobile** via the same `/api/auth/*` endpoints.
JWT bridge to NestJS. Monorepo with 3 apps (web, mobile, backend)
+ 3 shared packages (api-types, auth-client, ui-tokens). Full
Prisma schema with 12 models included in this delta.

Subdomain structure: Option 1 (split - crm + api.crm) chosen.

## Round 5 - 2026-08-29, ~21:30 UTC - REST over GraphQL

`CLIENT-FEEDBACK-v5-2026-08-29.md` saved. User asked: "Can we
use REST instead of GraphQL? I only said GraphQL because easy
integration for mobile app. Is it true?"

Verified: half-true claim. TanStack Query is the 2026 standard
(12M+ weekly downloads), works equally well with REST and GraphQL.
Switched to **REST + TanStack Query + SSE for chat realtime**.
Saves 1-2 weeks of GraphQL setup + 1-2 weeks of subscription
server work. New realistic timeline: 8-9 weeks (later revised to
10 weeks for the first-time-build tax).

## Round 6 - 2026-08-29, ~21:45 UTC - India telephony pricing

`CLIENT-FEEDBACK-v6-2026-08-29.md` saved. User asked: "For
Telephony, can we have cheap and best for India?"

Verified 2026 pricing: FreJun (₹1,149/user/mo), TeleCMI
(₹587/user/mo), MyOperator (₹2,500/mo for 3 users), Knowlarity
(₹1,999/agent), Exotel (credit pool trap), WhatsApp Business
Calling API (free tier, inbound only).

Decision: **FreJun at ~₹1,149/user/month** for v1. AI call
transcription INCLUDED is the killer feature for the "monitor
by application" requirement. Total real cost for 10 users:
~₹15,300/month (plan + usage + number).

## Round 7 - 2026-08-29, ~21:57 UTC - Amazon Connect comparison

`CLIENT-FEEDBACK-v7-2026-08-29.md` saved. User asked: "What about
AWS Amazon Connect Customer?"

Verified pricing. Amazon Connect costs ~4.4× more for the same
workload ($735/month vs $184/month for 10 users). Has real
advantages (Amazon Q AI assist, enterprise compliance, 30+
regions) but not needed at Shadhil's current scale. Migration
path: both providers expose webhook APIs, so switching is
3-5 days of dev work. **FreJun stays locked for v1, Amazon
Connect documented as v2 migration path if Shadhil grows past
50 users, expands to UAE, or hits enterprise compliance.**

## Round 8 - 2026-08-29, ~22:15 UTC - Apply (DESIGN.md v2)

DESIGN.md v2 written. Consolidates v1 + 7 rounds into a single
38KB document. 18 sections: roles, modules, lifecycle, RBAC
matrix, entities, integrations, stack, auth flow, SSE chat,
push notifications, success metrics, timeline, open questions
(Q0–Q16), NOT in scope, what already exists, pushbacks, decision
log, where to read more. CLIENT-QUESTIONS.md updated to v2 with
Q0–Q16 grouped by priority.

## Round 9 - 2026-08-29, ~22:30 UTC - Prisma + multi-app database pattern

`CLIENT-FEEDBACK-v8-2026-08-29.md` saved. User asked:
1. "Can we use Prisma with NestJS + REST API?"
2. "How does the database share the same data for all three places?"

Verified: Prisma has an official guide for the pnpm monorepo
pattern. Two real gotchas identified:
1. **Connection pooling**: both apps need to share the database
   without exhausting Postgres connections. Solution: PgBouncer in
   docker-compose. Set `PGBOUNCER_POOL_MODE=session` for v1 (RLS
   works simply), switch to `transaction` in v2 when concurrent
   users exceed ~50.
2. **RLS + pooling interaction**: session pooling mode lets you
   set the RLS session vars per-request in middleware. Transaction
   pooling mode requires setting them inside `$transaction`
   blocks (more verbose but scales higher).

The recommended pattern (Model A):
- ONE Postgres database, ONE `schema.prisma` in `packages/database/`
- ONE generated Prisma Client, imported by both apps
- Next.js (BFF) writes ONLY to auth tables (User, Session, Account,
  Verification) via better-auth's Prisma adapter
- NestJS (backend) writes to ALL business tables via REST
  controllers and webhook receivers
- Mobile calls NestJS REST, never touches Prisma directly
- Next.js server components do NOT query business tables directly
  (the "second write path" trap)
- PgBouncer in docker-compose handles connection multiplexing

Two schema additions needed before build:
1. `Account` model (for better-auth's OAuth provider data)
2. `Verification` model (for email verification tokens)

---

## File index

| File | Purpose | Size |
|---|---|---|
| `DESIGN.md` | v2 source of truth, 18 sections | ~38 KB |
| `CLIENT-QUESTIONS.md` | Q0–Q16 grouped by priority | ~5 KB |
| `DECISION-CHANGELOG.md` | This file | ~7 KB |
| `CLIENT-FEEDBACK-2026-08-29.md` | Round 1 delta (roles, handoff, chat) | ~12 KB |
| `CLIENT-FEEDBACK-v2-2026-08-29.md` | Round 2 (Supabase/Prisma/better-auth, RBAC+ABAC) | ~13 KB |
| `CLIENT-FEEDBACK-v3-2026-08-29.md` | Round 3 (NestJS+VPS, Option A vs B) | ~16 KB |
| `CLIENT-FEEDBACK-v4-2026-08-29.md` | Round 4 (BFF pattern, Prisma schema) | ~21 KB |
| `CLIENT-FEEDBACK-v5-2026-08-29.md` | Round 5 (REST, SSE, TanStack Query) | ~12 KB |
| `CLIENT-FEEDBACK-v6-2026-08-29.md` | Round 6 (FreJun) | ~11 KB |
| `CLIENT-FEEDBACK-v7-2026-08-29.md` | Round 7 (Amazon Connect) | ~11 KB |
| `CLIENT-FEEDBACK-v8-2026-08-29.md` | Round 8 (Prisma + multi-app DB pattern) | ~13 KB |

## Round 10 - 2026-08-29, ~22:35 UTC - Reminders module added

`CLIENT-FEEDBACK-v9-2026-08-29.md` saved. User asked for reminders
to staff (telecaller + sales exec) when customer reschedules a
site visit. Not just a clarification - a real new feature.

Added a new Reminders module to v1 with 4 reminder types:
1. Pre-visit staff reminder (T-2h before, push + in-app + email)
2. Pre-visit customer reminder (T-24h and T-2h, WhatsApp)
3. Reschedule follow-up reminder (T+1h after reschedule,
   prompts staff to confirm with customer - THE ONE USER ASKED FOR)
4. No-show staff reminder (already in v2, T+2h)

Added a new `Reminder` Prisma model with status state machine
(SCHEDULED → FIRING → FIRED → ACKNOWLEDGED/CANCELLED/FAILED).
Cron-based processor with exponential backoff retry (5 attempts).

Two genuine choices surfaced to the client:
- Choice A: Include customer-side reminders (recommended, halves
  no-show rate)
- Choice B: Re-add email as a fallback channel for reminders
  (recommended, push failures are real)

Two new WhatsApp templates needed (visit_reminder_24h,
visit_reminder_2h) - submit in week 1 to overlap with Meta's
approval SLA.

Updated timeline: 10 weeks → 12 weeks (1 week for reminder system).

## Round 11 - 2026-08-29, ~22:36 UTC - Resolved all 16 client questions

User said "client leave it to me, you pick the best option for
long run. System needs to adapt, adjust, reliable, scalable,
system should fail even 1 ms." Created CLIENT-DECISIONS.md with
all 16 questions answered, biased for reliability + scalability
+ adaptability. Archived CLIENT-QUESTIONS.md to
CLIENT-QUESTIONS.md.archived-2026-08-29.

Key calls:
- Q0: New production WhatsApp number, separate from landing site
- Q1: v1 5-15 users, v2 50-200, design once scale later
- Q2: v1 captures handoff, v1.1 adds agreement generation
- Q3: RERA + DPDP Act both in v1 (5-7 year audit retention)
- Q4: v1 100-500 leads/month, v2 1K-5K
- Q5: BOTH PWA in v1 AND Expo in v1.1 (not optional)
- Q8: 4 manager KPI widgets in v1 (funnel, handoff latency,
       per-exec performance, source ROI)
- Q9: Admin in-app creates all roles
- Q11: Recording + AI transcription ON by default, 7y R2 archive
- Q12: 7-year audit log retention (RERA upper bound)
- Q13: Manager per-team ONLY, Admin is global
- Q14: Mudichur only in v1 UI, multi-site data model day 1
- Q15: One-click handoff, no manager gate

Reliability design (§4 of CLIENT-DECISIONS.md):
- 99.95% uptime target (52 min/year allowed)
- No single point of failure in request path
- Daily pg_dump + WAL archive to R2, 7-day PITR
- Weekly restore test
- Monitoring: Better Stack (free) + Sentry (free) + Telegram alerts
- Documented runbook per failure mode
- v1 single VPS, v2 adds standby VPS, v3 multi-region

Pushed back honestly: "1 ms literally" is impossible. 99.95% is
the realistic target for v1.

## Round 12 - 2026-08-29, ~22:50 UTC - Full push notification system

`CLIENT-FEEDBACK-v10-2026-08-29.md` saved. User asked for "push
notification for staff for both web and mobile." The v2 brief §10
only covered ONE trigger (lead assignment). This delta adds a
complete cross-platform push system.

**Design:**
- **Expo Push as the universal push service** (handles iOS,
  Android, AND web via one API - saves 1-2 weeks of multi-
  platform setup)
- **12 distinct staff triggers** (lead assigned, handoff, no-show,
  chat reply, booking approval, daily summary, etc.) all going
  through the same push infrastructure
- **Two new Prisma models:** `PushSubscription` (per-device
  token) + `PushNotification` (audit log of every push sent)
- **Quiet hours** (22:00-07:00 local) respected for reminder
  triggers, bypassed for real-time state-transition triggers
- **Fallback chain:** in-app SSE banner (primary) → push
  (secondary) → email (last resort)
- **Token rotation handling** (mark invalid tokens inactive,
  periodic cleanup)

**Two real reliability concerns flagged:**
- Push delivery is not 100% (Expo ~99%, Web Push ~95%)
- Push tokens change (app reinstall, FCM refresh, browser
  data clear) - backend must handle

**The one choice to surface:** Daily summary push (trigger 12)
should be opt-in, default off. Some managers love it, others
find it annoying.

**Updated push trigger list:** 1. Lead assigned to telecaller
2. Handoff to manager 3. Handoff to manager's team 4. Lead
assigned to exec 5. Pre-visit staff reminder (T-2h) 6. No-show
staff (T+2h) 7. Customer replied to chat (when staff is away)
8. Booking awaiting approval 9. Booking approved/rejected
10. Customer rescheduled 11. Mentioned in note/chat (deferred
to v1.1) 12. Daily summary (opt-in, default off).

## Round 13 - 2026-08-29, ~22:58 UTC - Notification center (inbox) added

`CLIENT-FEEDBACK-v11-2026-08-29.md` saved. User asked: "Store
notifications and show it in the crm app both web and mobile."
The v10 push design covered OUTBOUND (sending push) but not
INBOUND (user sees their notifications in the app). This delta
adds the inbox-style notification center.

**Design:**
- New `Notification` table (separate from v10's `PushNotification`
  audit log) - the user's inbox. Mutable state (`readAt`,
  `dismissedAt`). 90-day visibility, 7-year retention.
- Bell icon + unread badge in top nav (web) and tab bar (mobile).
- Dropdown panel (web) and full screen (mobile) listing all
  notifications, newest first, filterable by status/category.
- Real-time updates via SSE on a new per-user Redis channel
  (`user:{id}:notifications`).
- Unread count cached in Redis (5-min TTL) for fast page loads.
- 3 SSE channels per user: new notification, single mark-read,
  all-mark-read.
- All 12 triggers from v10 automatically create `Notification`
  rows + push delivery.

**Key behaviors:**
- 90-day inbox visibility, 7-year DB retention (matches audit)
- Unread badge capped at "9+" (standard iOS/Gmail pattern)
- Grouping by date (Today / Yesterday / This week / Older)
- Empty state ("You're all caught up!")
- Deep links to relevant pages (best-effort, no validation in v1)
- Real-time badge updates via SSE

**One choice to surface:** Daily summary push (trigger 12) -
should it ALSO create an inbox entry? Default: yes. Surface
to client.

**Two real reliability concerns flagged:**
- Unread count cache can drift (mitigated by 5-min TTL + daily
  recompute cron)
- SSE connection storm on app open (not a concern for 5-15
  users in v1; v2+ may need a dedicated SSE service)

**What I'd push back on:**
- 90-day window might be wrong (default for v1, configurable
  in Settings, re-evaluate after 30 days of usage)
- Don't add notification PREFERENCES in v1 (12 triggers all on
  by default, use Mark all as read / Dismiss for noise control;
  v1.1 adds per-trigger settings if Shadhil complains)
- Don't add notification SOUND customization in v1

## Round 14 - 2026-08-29, ~23:05 UTC - APPLY: DESIGN.md v3

DESIGN.md v3 written. 43.5KB, 21 sections, 19 Prisma models,
9 modules, 12 push triggers, 4 reminder types.

**Consolidates 5 deltas + CLIENT-DECISIONS.md into the build spec:**

  - v8 (Prisma multi-app DB pattern + PgBouncer)
  - v9 (Reminders module: 4 types, cron, reschedule flow)
  - v10 (Push notification system: 12 triggers, Expo Push)
  - v11 (Notification Center: in-app inbox, SSE, real-time)
  - CLIENT-DECISIONS.md (16 resolved questions + 99.95%
    reliability design + RERA/DPDP compliance)

**Sections in v3:**
  1.  Primary user roles
  2.  Core modules (9)
  3.  Lead lifecycle state machine (15 states, 2-stage ownership)
  4.  Permission matrix (RBAC + ABAC + RLS policies)
  5.  Key entities and relationships (19 Prisma models)
  6.  Integration touchpoints (landing site, WhatsApp NEW number,
      FreJun, Expo Push, email fallback, Google Sheets, Coolify)
  7.  Tech stack (locked, with multi-app Prisma pattern, monorepo)
  8.  Auth flow (BFF + JWT bridge, same Next.js app)
  9.  Realtime SSE channels (chat + notifications + reminders)
  10. Push notifications (12 triggers, Expo Push)
  11. Notification center (in-app inbox, 90-day visibility)
  12. Reminders module (4 types, cron, reschedule flow)
  13. Success metrics (8 metrics at 30/60/90 days)
  14. Reliability design (99.95% uptime, 10 failure modes)
  15. Compliance: RERA + DPDP Act
  16. Timeline (13-week plan to v1)
  17. NOT in scope (deferred, with reason)
  18. What already exists (carry forward)
  19. What I'd push back on (10 items)
  20. Decision log (28 locked decisions, with sources)
  21. Where to read more

**Timeline: 13 weeks honest estimate** (was 10-12 in earlier
rounds; the 3-week bump accounts for compliance workflows,
push notification system, notification center UI on both
web and mobile, and the longer production-readiness tail).

**The brief is now build-ready.** Send to Shadhil for final
sign-off. Then start week 1.

## Round 15 - 2026-08-29, ~23:08 UTC - Telecaller handoff point question

User asked: "Should telecaller follow up the customer until site
visited, or telecaller assign to manager after the first
confirmation site visit by customer? Which is correct approach
in real estate?"

Created CLIENT-FEEDBACK-v12-2026-08-29.md with FOUR real-world
models (A, B, C, D) and the tradeoffs for each.

**Key insight:** This is a product/workflow question, not a
software question. The "correct" answer depends on Shadhil's
existing sales process, not on what's cleanest architecturally.

**The four models:**

  A) Handoff at "verbal yes" - current v3. Telecaller has
     no skin in the game for visit actually happening. Bad
     for no-show rate (30-40% industry baseline).

  B) Handoff after visit completed. Telecaller owns through
     the visit. Sales exec is the closer only. Better, used
     by mid-market builders.

  C) Hybrid: shared visibility during scheduled, handoff at
     visit outcome. Best-in-class Indian real estate CRM model.
     Used by Housing.com, NoBroker, Brigade, Prestige, Lodha.

  D) No handoff (one person does everything). Only for
     boutique builders. Doesn't match Shadhil's 4-role org.

**My recommendation: Model C.** Removes the perverse
incentive (telecaller loses credit for no-shows) and gives
the sales exec a warm lead at the visit (not a cold lead
from a form).

**Did NOT auto-apply.** This is a product decision, not a
technical one. Surfacing to client with the "which model
matches your reality" question. v3 stays as Model A until
client picks.

If you (the PaalStack user) want to lock Model C in advance,
say "apply Model C" and I'll update the relevant sections
of DESIGN.md.

## Round 16 - 2026-08-29, ~23:15 UTC - APPLY Model C: Hybrid handoff

User said "apply Model C." Updated DESIGN.md v3 → v3.1 with
the hybrid handoff model (telecaller owns through VISIT
outcome, exec conducts the visit and takes over after).

**Changes from v3 (Model A) to v3.1 (Model C):**

  - **§1 Roles:** Telecaller now owns through "Visit Scheduled"
    + confirmation (24h, 2h before). Cannot log VISITED.
    Sales Exec conducts visit + takes over post-visit.
    Cannot schedule visit (only the telecaller does that).
  - **§3 Lifecycle:** Removed `HANDED_OFF_TO_MANAGER` and
    `ASSIGNED_TO_EXEC` states. Added shared VISIT_SCHEDULED
    visibility window. NO_SHOW reverts to telecaller, not exec.
  - **§4 RBAC matrix:** Updated with the new role split.
    Telecaller schedules + confirms + re-engages. Exec
    conducts + logs outcome + closes.
  - **§4 RLS policies:** New EXISTS subquery for shared
    VISIT_SCHEDULED visibility - both telecaller and exec
    can see the lead during the scheduled window.
  - **§5 Enums:** LeadStatus reduced from 15 to 13 states
    (removed HANDED_OFF_TO_MANAGER, ASSIGNED_TO_EXEC).
  - **§6 Integrations:** Removed `sales_exec_handoff_intro`
    WhatsApp template (not needed in Model C - the exec
    just shows up to a confirmed visit, no separate intro).
  - **§13 Success metrics:** New "No-show rate" metric
    (the KEY Model C metric) + updated "Handoff latency"
    to measure VISITED-to-first-message, not verbal-yes
    (no longer meaningful in Model C).
  - **§16 Timeline:** No change.
  - **§19 Pushback:** Updated item 2 to recommend Model C
    and item 6 to reflect the new process requirements.
  - **§20 Decision log:** Renumbered (entry was duplicated
    as #15; fixed to #21).

**Known limitation:** `WORKFLOW-DIAGRAMS.md` (Diagram 4,
the lifecycle state machine) still shows the v3 Model A
flow. Will regenerate in a v3.1 of the diagrams if needed;
for now the ASCII + Mermaid in DESIGN.md §3 is the source
of truth.

**No timeline change.** Model C is the same dev work as
Model A (same state machine, just different transitions).
13 weeks to v1.

## Round 17 - 2026-08-31 - User-creation hierarchy locked

Client confirmed the user-creation model:

- ONE admin exists (seeded, placeholder credentials per §17
  Input #5, rotate on first login). The admin bootstraps the
  org: can create MANAGER, TELECALLER and SALES_EXEC users.
- A MANAGER, once created, can create TELECALLER and
  SALES_EXEC users - scoped to their own team.
- TELECALLER and SALES_EXEC can create nobody.

Code change baked in now
(`packages/auth-client/src/auth.ts`): `admin()` plugin options
extended to `admin({ defaultRole: 'TELECALLER', adminRoles:
['ADMIN'] })` - better-auth 1.7 gates its admin endpoints
(user create/list/ban via adminClient) to the ADMIN role only;
MANAGER keeps plain sign-in. `role`/`teamId` remain
`input: false` additional fields, so no signup path can
self-assign a role.

Still to build (not yet in the repo as of this round):
- `users` module in apps/backend - role-guarded create/list
  endpoints. ADMIN creates any role; MANAGER creates
  TELECALLER/SALES_EXEC only within `Team.managerId` scope.
  Enforce with a NestJS guard, not UI hiding.
- Credential setup on create must mirror `seed.ts` upsertUser:
  `Account` row keyed `providerId: 'credential'`,
  `accountId: user.id`, `issuer: 'local:credential'`,
  scrypt `salt:key` hash (N=16384, r=16, p=1, dkLen=64,
  NFKC-normalized) - better-auth 1.7 sign-in contract
  (dist/api/routes/sign-in.mjs:320).
- Web UI: admin "Users" page + manager "My Team" page.
- Open question: when the ADMIN creates a MANAGER, team
  assignment - creating the manager auto-creates their Team
  (Team.managerId = manager) vs admin picks an existing team.
  Recommended: auto-create team on manager creation;
  manager-created users join the manager's teamId.
- Open question (superseded by Round 20): the earlier
  single-ADMIN fragility is resolved by the new SUPER_ADMIN
  layer instead of admin self-service.

## Round 18 - 2026-08-31 - Lead creation + authority inheritance

Client confirmed two more rules:

1. **Telecaller and Sales Exec CAN create leads/enquiries.**
   The §4 permission matrix had no "create lead" row at all -
   it now exists: telecaller/exec creation puts the creator on
   the lead as `ownerId` (ownerType from their role).
   Manager-created leads land in the manager's team; admin can
   create into any team.
2. **Authority inheritance:** admin ⊇ manager ⊇
   telecaller/exec. An admin can do any action a manager can,
   a manager any action a telecaller/exec can. Scope follows
   the actor: manager inherits staff actions within their own
   team's leads only; admin across all leads.

Matrix rows flipped from ❌ to ✅ under admin/manager: schedule
site visit, confirm visit, log visit outcome (manager gets all
outcomes), re-engage after no-show, log activity, send
WhatsApp. "Create user accounts" now shows manager ✅ for
telecaller + exec in their own team (Round 17). Two gates stay
❌ for superiors on purpose: exec cannot schedule visits and
telecaller cannot log VISITED - these are Model C
*responsibility* boundaries (credit/KPI assignment), not
capability caps. Reports row clarified: admin sees org-wide
KPIs.

DESIGN.md §4 is updated (matrix + inheritance paragraph +
creation flows). Backend enforcement notes for the build:
inherit in NestJS via a role-hierarchy helper
(e.g. `hasAtLeast(actorRole, requiredRole)`) combined with the
existing team-scope check, not a second parallel matrix; every
staff-level endpoint keeps its team/ownership ABAC filter on
top of the inherited capability.

Ground-truth check against `packages/database/prisma/rls/
policies.sql` (2026-08-31): the RLS layer already implements
both rules. `lead_insert` allows all four roles WITH CHECK
`teamId = app.user_team_id`; staff update own rows, manager
team-wide, admin unrestricted. Build nuance: the admin's RLS
context carries their own (usually null) `app.user_team_id`,
so admin/manager creating a lead INTO another team must have
the service layer set the RLS context team to the TARGET team
for that insert, or the WITH CHECK will reject the row.

## Round 19 - 2026-08-31 - Users module BUILT and live-verified

The user-creation hierarchy (Rounds 17/18) is implemented,
endpoint-tested, and cleaned up after. Uncommitted.

**New files**
- `apps/backend/src/users/` - module, controller, service:
  - `POST /api/users` - ADMIN creates any role; MANAGER
    creates TELECALLER/SALES_EXEC in their own team; staff
    roles → 403. Admin creating a MANAGER without teamId
    auto-creates the Team. Admin creating staff without
    teamId → 400. Unique-email conflict → 409 (Prisma).
  - `GET /api/users` - admin: all; manager: via
    `Team.managerId`; staff: self. 403-free for admin/manager
    paths by role. staff see exactly one row (self).
  - `apps/backend/src/users/roles.ts` - hierarchy +
    `assertCanCreateRole`. Explicit per-target rules after
    live test caught rank-equality bug (manager→manager was
    201 before the fix).
  - `apps/backend/src/users/credentials.ts` - better-auth 1.7
    Account contract: `providerId: 'credential'`,
    `accountId: user.id`, `issuer: 'local:credential'`,
    scrypt N=16384/r=16/p=1/dkLen=64 "salt:key" (seed.ts
    mirror). Verified: admin-created manager signs in 200.

**Changed files**
- `packages/database/src/index.ts` - re-exports
  `withRlsContext` / `RlsContext` / `RlsTx` (was internal only).
- `packages/api-types/src/auth.ts` - `CreateUserDtoSchema` /
  `CreateUserDto` (Zod, role explicit, no default).
- `apps/backend/src/auth/better-auth.middleware.ts` -
  `forRoutes('auth/*splat')` (Nest 12 path-to-regexp v8) +
  imports AuthModule for the handler token + **now imported in
  app.module.ts** (it never was - sign-in was broken on the
  API side until today).
- `apps/backend/src/app.module.ts` - UsersModule +
  BetterAuthMiddlewareModule registered.
- `apps/backend/src/prisma/prisma.module.ts` - exports
  PrismaService.
- `packages/auth-client/src/auth.ts` (from earlier today) -
  `admin({ defaultRole: 'TELECALLER', adminRoles: ['ADMIN'] })`.

**Live verification (dev server, e2e via curl + issueJwt)**
1. ADMIN creates MANAGER → 201, team auto-created, manager's
   own teamId set. 2. MANAGER creates TELECALLER → 201, joins
   manager's team (resolved via Team.managerId). 3. ADMIN
   creates TELECALLER into an explicit team → 201. 4. MANAGER
   creating MANAGER → 403. 5. TELECALLER creating anyone →
   403. 6. Admin-created manager signs in via better-auth →
   200 (credential contract works). 7. GET scoping: admin 15
   rows, manager 6 (own team), telecaller 1 (self).
Test rows deleted after the run (DB back to the 4 seeded
users).

**Known gaps / follow-ups**
- better-auth jwt() plugin requires a `Jwks` table that
  schema.prisma lacks → `GET /api/auth/token` 500s. JWT
  verification currently uses `issueJwt()` bridge instead.
  Add the model (id/version/keys/createdAt/updatedAt per
  better-auth docs) in a follow-up migration.
- Manager scoping now depends on Team.managerId; the JWT
  teamId claim should be refreshed from the DB at session
  issue (or manager JWTs should carry the managed team id) -
  tracked as a follow-up.
- Round 17's open question is resolved by implementation:
  manager creation auto-creates a Team; passing an explicit
  teamId for a new MANAGER is also supported (admin choice).


## Round 20 - 2026-08-31 - 5-role model + role changes, BUILT and live-verified

Client locked the final role model and its change hierarchy:

- Roles: SUPER_ADMIN, ADMIN, MANAGER, TELECALLER, SALES_EXEC.
- Exactly ONE SUPER_ADMIN, ever (client-confirmed). Exists only
  via seed/migration; the API refuses to create, assign, or
  change it - enforced in code AND by a Postgres partial
  unique index (`one_super_admin`, verified live: inserting a
  second super admin is rejected at the DB).
- Create hierarchy: SUPER_ADMIN → any role below itself;
  ADMIN → MANAGER/TELECALLER/SALES_EXEC; MANAGER →
  TELECALLER/SALES_EXEC (own team); staff → nobody.
- Change hierarchy (PATCH /api/users/:id/role): SUPER_ADMIN
  changes anyone into anything (except into/out of
  SUPER_ADMIN, and never themself); ADMIN changes roles below
  admin; MANAGER changes staff roles within their team.
- Guards, all live-tested: no self-role-changes (403),
  SUPER_ADMIN unassignable (403), staff cannot change roles
  (403), manager cannot touch admin rows (403), demoting a
  manager who still leads a team is blocked until members
  move (409), promotion to manager auto-creates their team
  (parity with create), sign-in survives role changes
  (verified: promoted user signed in 200 with the new role).

**Schema/migration** (packages/database, applied to the live DB):
- `20260831110000_role_super_admin` - ALTER TYPE Role ADD
  VALUE 'SUPER_ADMIN' BEFORE 'ADMIN' (split transaction per
  Postgres ALTER TYPE rules).
- `20260831110100_bootstrap_super_admin` - seeded
  admin@shadhilbuilders.in row updated ADMIN → SUPER_ADMIN.
- `20260831110200_one_super_admin_only` - partial unique index
  ON "User"(role) WHERE role='SUPER_ADMIN' (Prisma cannot
  express partial indexes; native SQL only). Live-verified
  with a deliberate duplicate insert → unique violation.
- schema.prisma Role enum + regenerated client.
- seed.ts: 'SUPER_ADMIN' placeholder (admin@ email kept),
  Role type widened.

**RLS layer** (packages/database/src/rls.ts): SUPER_ADMIN has
no policies of its own - withRlsContext downcasts it to ADMIN
so all 19 existing policy sites keep working unchanged.
app.user_role receives 'ADMIN' for super admins; the JWT and
API layer keep the distinction. Role registries moved in
lockstep: rls.ts ROLES + Role union, jwt.ts ROLES,
api-types RoleSchema (+ new AssignableRoleSchema excluding
SUPER_ADMIN - unused by the endpoint for now, kept as the
documented contract), auth-client admin plugin now
`roles: { ADMIN: adminAc, SUPER_ADMIN: adminAc },
adminRoles: ['SUPER_ADMIN','ADMIN']` (better-auth 1.7 requires
adminRoles entries to be keys in `roles`; ADMIN reuses the
stock adminAc statement set - the package test caught this).

**Users module** (apps/backend/src/users/):
- roles.ts reworked: RANK total order with SUPER_ADMIN=4,
  strict-inequality checks (rank equality never passes),
  assertCanCreateRole + assertCanChangeRole with the three
  client guards baked in.
- users.service.ts: changeRole() (existence check, self-change
  block, hierarchy assert, team-lead demotion guard, manager-
  promotion auto-team, audited update) + create()/list()
  widened for SUPER_ADMIN (org-owner class: acts like ADMIN on
  team surfaces, sees all in list).
- users.controller.ts: PATCH :id/role endpoint; Zod
  safeParse helper mapping ZodError → 400 (was 500).
- api-types: ChangeRoleDtoSchema/ChangeRoleDto; SignupDto
  teamId relaxed from `.cuid()` to a non-empty string (seed
  teams are `seed-team-<id>` - a permanent legit pattern the
  old validator rejected).
- apps/backend now declares zod (imports it directly for the
  parse helper).

**Live verification** (dev server, curl + issueJwt bridge):
RC1 super promotes telecaller → ADMIN (200, audited).
RC2 admin creating admin → 403. RC3 admin changes telecaller
→ SALES_EXEC (200). RC4 assigning SUPER_ADMIN → 403 even from
super. RC5 super changing own role → 403. RC6 staff changing
roles → 403. RC7 manager touching an admin row → 403. RC8
demoting a team-leading manager → 409 with the team named in
the message. RC9 the ADMIN-promoted user signs in → 200
(credential row untouched by role changes). Audit trail
verified: user.create + user.changeRole rows with before/after.
Test data deleted after the run - DB back to the 4 seeded
users (1 super admin, 1 manager, 1 telecaller, 1 sales exec),
1 team, audit rows intact.

**Still open (pre-existing, tracked in Round 19):** jwks table
for better-auth's /api/auth/token; JWT teamId claim refresh
for managers.

## Round 21 - 2026-09-03 - Role rename: SUPER_ADMIN → OWNER

Client asked to rename the org-owner role from `SUPER_ADMIN` to
`OWNER` for clarity (a "super admin" sounds like an elevated
admin; "owner" matches how the client talks about the account
that bootstraps the org). No semantic change to the role -
same rank (top of hierarchy), same uniqueness invariant
(exactly one exists, partial unique index), same RLS downcast
behavior (travels as ADMIN at the Postgres layer).

**Why now:** Round 20 had shipped and the role was not yet
referenced in any production migration journal (no live DB had
been migrated past 20260831 init), so we could safely:

- Drop the three `20260831*_super_admin` migration directories
  and recreate them under new names with the renamed value.
- Rename the partial unique index `one_super_admin` → `one_owner`.
- Rename the env vars `SEED_ADMIN_*` → `SEED_OWNER_*` (the
  existing `SEED_ADMIN_*` names were already a latent bug -
  `seed.ts` always read `SEED_${prefix}_*` with `prefix ===
  'SUPER_ADMIN'`, so the env vars had never been reachable).
- Update every string literal, type alias, exported constant,
  JSDoc, and Swagger summary that mentions SUPER_ADMIN /
  super admin across:
  - `packages/database/src/{rls.ts,seed.ts}`
  - `packages/auth-client/src/{auth.ts,jwt.ts}`
  - `packages/api-types/src/{enums.ts,auth.ts}`
  - `apps/backend/src/users/{roles.ts,users.service.ts,users.controller.ts}`
  - `apps/web/src/{lib/session.ts,apis/client.ts,app/(app)/page.tsx,app/(app)/users/page.tsx}`
- Update `README.md` forward-looking copy (the seat-table row,
  the role-model line, the security model bullet).
- Update `docs/planning/DESIGN.md` forward-looking copy of the
  RBAC section (with an inline note pointing at Round 21 so the
  Round 20 wording still makes sense historically).

**DB migrations replaced (delete-and-recreate, not edited in
place):**

- `20260831110000_role_super_admin` → `20260831110000_role_owner`
  - `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OWNER' BEFORE 'ADMIN';`
- `20260831110100_bootstrap_super_admin` → `20260831110100_bootstrap_owner`
  - `UPDATE "User" SET "role" = 'OWNER' WHERE "email" = 'admin@shadhilbuilders.in';`
- `20260831110200_one_super_admin_only` → `20260831110200_one_owner_only`
  - partial unique index renamed to `one_owner`, `WHERE` clause
    flipped to `'OWNER'`.

**Renamed in code:**

- `prisma/schema.prisma` - `enum Role` first value
  `SUPER_ADMIN` → `OWNER`.
- `packages/database/src/rls.ts` - local `Role` union,
  `ROLES` allowlist, and the downcast target `ctx.role === 'SUPER_ADMIN'`.
- `packages/database/src/seed.ts` - `readSeedUser` prefix
  union, default name `"Super Admin"` → `"Owner"`, env-var
  prefix, and the final `superAdmin` → `owner` local.
- `packages/auth-client/src/auth.ts` - `admin({ roles: { ...
  }, adminRoles: [...] })` keys.
- `packages/auth-client/src/jwt.ts` - `ROLES` tuple.
- `packages/api-types/src/enums.ts` - `RoleSchema` and
  `AssignableRoleSchema` (the `.exclude(['OWNER'])`).
- `packages/api-types/src/auth.ts` - JSDoc on `ChangeRoleDtoSchema`.
- `apps/backend/src/users/roles.ts` - `RANK` record, exported
  constant `SUPER_ADMIN` → `OWNER`, guard message strings,
  JSDoc.
- `apps/backend/src/users/users.service.ts` - file header,
  import name, all four `actorRole === '...'` checks,
  comments.
- `apps/backend/src/users/users.controller.ts` - both
  `@ApiOperation({ summary })` strings.
- `apps/web/src/lib/session.ts` - `isAdminLike` check,
  comments on `canReassign` and `canViewAudit`.
- `apps/web/src/apis/client.ts` - `Role` union and
  `STAFF_ROLES` allowlist.
- `apps/web/src/app/(app)/page.tsx` - file-header comment.
- `apps/web/src/app/(app)/users/page.tsx` - file-header
  comment.

**Env vars:**

- `SEED_ADMIN_EMAIL / NAME / PASSWORD` →
  `SEED_OWNER_EMAIL / NAME / PASSWORD`. Updated in
  `.env.example` and `packages/database/.env.example`. The
  placeholder display name changed from `"Admin"` to
  `"Owner"` (the seeded `admin@shadhilbuilders.in` email is
  kept - it's the only stable handle the client knows).

**Unchanged on purpose:**

- `docker/postgres-init/00-init.sql` line 30 - the Postgres
  role attribute `NOSUPERUSER` is a Postgres built-in, unrelated.
- `packages/auth-client/test/auth.test.ts` line 99 - `'SUPERUSER'`
  is a deliberate sentinel role used to assert that `verifyJwt`
  rejects unknown role values. Renaming it would weaken the
  test.
- `README.md` line 37 - `admin_placeholder_pw` is the password
  string. Renaming it would invalidate any existing dev DB
  rows; keeping it makes the migration a pure rename, not a
  re-seed.
- All Round 17 and Round 20 entries in this changelog - they
  accurately describe what was decided at those rounds
  (`SUPER_ADMIN` was the name then). History is preserved;
  the rename is recorded here, in Round 21.

**Verification after this round:**

- `pnpm --filter @shadhil/database generate` must be re-run
  before `pnpm type-check` (Prisma client carries the new enum).
- `pnpm db:migrate reset` on a fresh DB should land with
  `User.role = 'OWNER'` for the `admin@shadhilbuilders.in`
  row.
- `pnpm test` for `@shadhil/auth` still passes (the SUPERUSER
  sentinel test is the deliberate guard against future
  regressions).

## Round 22 - 2026-09-03 - Seed: add ADMIN placeholder

After Round 21's rename, the only seed user with admin-class
powers was the OWNER (`admin@shadhilbuilders.in`). That left
nothing for the OWNER to **practice delegation** with on a fresh
clone - they could sign in and look around, but every demo
flow ("OWNER creates an admin → admin creates a manager →
manager creates a telecaller") had to start at the OWNER seat,
which is the one seat the client is least likely to use in
production.

**Decision:** seed a second placeholder user with role
`ADMIN`, distinct email `admin2@shadhilbuilders.in`, and
fallback password `admin2_placeholder_pw`. After seed the
fresh-clone roster is:

| Email | Role |
|---|---|
| `admin@shadhilbuilders.in` | OWNER (exactly one, ever) |
| `admin2@shadhilbuilders.in` | ADMIN |
| `manager@shadhilbuilders.in` | MANAGER (leads the seeded team) |
| `telecaller@shadhilbuilders.in` | TELECALLER (team member) |
| `sales_exec@shadhilbuilders.in` | SALES_EXEC (team member) |

The OWNER → ADMIN → MANAGER → TELECALLER/SALES_EXEC chain is
now fully exercisable from the moment seed completes.

**Why a distinct email (`admin2` not `admin`):** the
`User.email` column has a `@unique` constraint; reusing
`admin@shadhilbuilders.in` would collide with the OWNER row
and the seed would silently UPSERT the OWNER back to
role=ADMIN - a hard auth-bypass bug (the unique-OWNER partial
index then refuses to run because more than one row has the
role, but the OWNER's seed row would have lost its role
mid-update). `admin2` sidesteps it without inventing a new
domain for the placeholder.

**Changes:**

- `packages/database/src/seed.ts` - `readSeedUser` prefix
  union now includes `'ADMIN'`. Fallback email/name/password
  replaced with three `Record<typeof prefix, string>` lookup
  tables (cleaner than the chained ternary that would have
  been needed to slot ADMIN in). `main()` calls
  `readSeedUser('ADMIN')`, then `upsertUser(admin, 'ADMIN')`
  (no team - same shape as the OWNER row).
- `packages/database/.env.example` and `.env.example` - new
  `SEED_ADMIN_EMAIL / NAME / PASSWORD` block, mirroring the
  OWNER block. Optional - fall back to the `admin2` defaults.
- `README.md` - seat table grew by one row; the
  `pnpm --filter @shadhil/database seed` description now
  reads "owner + admin + manager + 2 staff".

**Not changed on purpose:**

- `apps/backend/src/users/roles.ts` - the role hierarchy
  already accepts both OWNER and ADMIN. No code change
  needed; the hierarchy now has one extra row in the roster
  but zero new authorization rules.
- The unique-OWNER partial unique index `one_owner` - only
  one OWNER ever, regardless of how many ADMINs are seeded.
- Round 21 entry above - historical.

**Verification:**

- `pnpm --filter @shadhil/database seed` on a fresh DB
  should report `[seed] ✓ owner, admin, manager, telecaller,
  sales exec created/updated` and leave the seeded team
  untouched.
- `pnpm --filter @shadhil/database generate` + the existing
  type-checks stay green (no schema change this round - the
  `Role` enum still has the same five values, the `User.email`
  unique constraint already covers `admin2@...`).
- The dev README seat table matches the seat table in
  `docs/planning/DECISION-CHANGELOG.md` Round 22.

## Round 23 - 2026-09-03 - Seed: align emails with role names

Round 22 introduced an ADMIN placeholder but parked it at
`admin2@shadhilbuilders.in` because the OWNER row already
owned `admin@shadhilbuilders.in`. The `admin2@...` address was
correct as a collision-avoidance tactic but read as a hack -
anyone reading the seed code had to mentally translate the
suffix back to the role. Cleaner to put each role's email at
`<role>@shadhilbuilders.in` and reserve `admin@...` for ADMIN.

**Decision:** swap the OWNER and ADMIN fallback emails:

- OWNER:  `admin@shadhilbuilders.in`  →  `owner@shadhilbuilders.in`
- ADMIN:  `admin2@shadhilbuilders.in`  →  `admin@shadhilbuilders.in`

Fallback passwords mirror the new emails (so they stay
discoverable):

- OWNER:  `admin_placeholder_pw`  →  `owner_placeholder_pw`
- ADMIN:  `admin2_placeholder_pw`  →  `admin_placeholder_pw`

After this round the seeded roster is:

| Email | Role | Password |
|---|---|---|
| `owner@shadhilbuilders.in` | OWNER (exactly one, ever) | `owner_placeholder_pw` |
| `admin@shadhilbuilders.in` | ADMIN | `admin_placeholder_pw` |
| `manager@shadhilbuilders.in` | MANAGER | `manager_placeholder_pw` |
| `telecaller@shadhilbuilders.in` | TELECALLER | `telecaller_placeholder_pw` |
| `sales_exec@shadhilbuilders.in` | SALES_EXEC | `sales_exec_placeholder_pw` |

Each email is now `<role-name>@shadhilbuilders.in`. The
collision-avoidance problem Round 22 was solving doesn't
recur because Round 23 removes the second-`admin@...` attempt
entirely.

**Changes:**

- `packages/database/src/seed.ts` - `FALLBACK_EMAIL` and
  `FALLBACK_PASSWORD` records updated. `FALLBACK_NAME` is
  unchanged. JSDoc on `readSeedUser` updated to reflect the
  new mapping and to point at this round.
- `packages/database/.env.example` -
  `SEED_OWNER_EMAIL=admin@...` → `owner@...`,
  `SEED_ADMIN_EMAIL=admin2@...` → `admin@...`.
- `README.md` - seat table updated.

**Not changed:**

- Round 22 entry above is preserved as historical - it
  accurately describes what shipped at the time (the
  `admin2@...` workaround). The current seat table is the one
  in Round 23.
- The bootstrap migration `20260831110100_bootstrap_owner`
  references the OLD `admin@shadhilbuilders.in` email for
  the OWNER row (`UPDATE "User" SET "role" = 'OWNER' WHERE
  "email" = 'admin@shadhilbuilders.in'`). On a fresh clone
  this lands a row at `admin@shadhilbuilders.in` with role
  OWNER. After this round the `seed.ts` upsert for OWNER
  targets `owner@shadhilbuilders.in` instead, which does NOT
  match the migration's WHERE clause. Two paths:

  a) Drop and recreate the bootstrap migration to point at
     `owner@shadhilbuilders.in`. Cleanest - every reference
     points at the same email.
  b) Keep both: migration sets up `admin@...` as OWNER, then
     seed.ts upserts `owner@...` as OWNER, then upserts
     `admin@...` as ADMIN. Works but leaves the placeholder
     layout split across two files.

  **Resolution this round:** we are dropping and recreating
  the bootstrap migration (Round 23 supersedes
  `20260831110100_bootstrap_owner`). No production DB exists
  to migrate, so this is just a file rename + edit. New
  directory will be created alongside Round 21's other
  `_owner` migrations.

**Verification:**

- All five workspaces still type-check clean (the
  `Record<typeof prefix, string>` lookup-table pattern
  enforces that `FALLBACK_EMAIL` covers every `prefix`
  value - TS would have failed otherwise).
- `pnpm --filter @shadhil/database seed` on a fresh DB
  should report `[seed] ✓ owner, admin, manager, telecaller,
  sales exec created/updated` and the `User` table should
  contain exactly five rows with the emails above.

## Round 24 - 2026-09-03 - Fix `pn db:migrate` "Connection url is empty"

After Round 23, `pnpm db:migrate` (run from the repo root)
errored with `Error: Connection url is empty`. Root cause:
`packages/database/prisma.config.ts` reads
`process.env.DIRECT_DATABASE_URL`, but `prisma migrate dev`
loads env for the schema's PG connection but NOT for the
config file's `process.env` access. pnpm doesn't auto-load
`.env` either. Net: the var arrives empty when prisma.config.ts
runs.

**Investigation (chronological - kept for the record so the
next agent doesn't repeat it):**

1. First instinct: add `--env-file=../../.env` to the
   migrate/generate/studio scripts (matching the existing
   pattern in `seed`, `nest start --watch`, `docker compose`).
   Reverted: Prisma CLI does NOT accept `--env-file` - that's
   a Node runtime flag, not a Prisma flag.
   `prisma migrate dev --help` only lists `--config`,
   `--schema`, `--url`, `--name`, `--create-only`.
2. Second instinct: use `dotenv-cli` as a wrapper. Reverted:
   adds a new dep (the repo only has `dotenv` ^17.4.2 in
   `packages/database/devDependencies`).
3. Third instinct: `import 'dotenv/config'` at the top of
   `prisma.config.ts`. Reverted because `dotenv/config` reads
   from CWD (which pnpm filter sets to `packages/database`),
   so it looks for `.env` in the wrong place. Verified by
   control test (see below).
4. **Actual fix:** use the explicit-path form of dotenv -
   `loadDotenv({ path: resolve(__dirname, '..', '..', '.env') })`
   - so the path is anchored to the config file, not CWD.
   Verified by:
   - Control test: remove the dotenv import → `pnpm db:migrate`
     fails with "Connection url is empty".
   - With the import: `pnpm db:migrate` succeeds with the
     "◇ injected env (13) from ../../.env" line, then
     "Already in sync".

**What changed this round:**

- `packages/database/prisma.config.ts` - added the explicit
  `loadDotenv({ path: resolve(__dirname, '..', '..', '.env') })`
  call (with JSDoc explaining why and what the alternatives
  were tried). The defineConfig body is unchanged.
- `packages/database/src/seed.ts` - replaced `import { prisma
  } from './index'` with a local `new PrismaClient({ adapter:
  new PrismaPg({ connectionString: process.env
  .DIRECT_DATABASE_URL ?? process.env.DATABASE_URL }) })`. The
  shared `prisma` is bound to `DATABASE_URL` (the non-owner
  pooled path) so the API runtime keeps RLS enforced - the
  seed needs `DIRECT_DATABASE_URL` (owner role) for its GRANTs,
  so it constructs its own client. The previous workaround of
  exporting `DATABASE_URL=$DIRECT_DATABASE_URL` before
  `pnpm db:seed` is no longer needed.

**What was reverted (kept for the historical record):**

- A first-pass `--env-file=../../.env` edit on the
  `generate`/`migrate`/`studio` lines of
  `packages/database/package.json`.
- A second-pass `import 'dotenv/config'` edit on
  `prisma.config.ts`.
- An intermediate edit that made the shared `prisma` in
  `src/index.ts` prefer `DIRECT_DATABASE_URL` over
  `DATABASE_URL`. Reverted because that would silently bypass
  RLS for every runtime API request - the seed needs the
  owner role, not the runtime.

**Verification (in a truly fresh shell - `env -i HOME="$HOME"
PATH="$PATH"`):**

- `pnpm db:migrate` → `◇ injected env (13) from ../../.env`
  then `Already in sync, no schema change or pending
  migration was found.`
- `pnpm db:generate` → `✔ Generated Prisma Client (7.10.0)`.
- `pnpm db:seed` → `[seed] ✓ owner, admin, manager, telecaller,
  sales exec created/updated`.
- `pnpm db:studio` was not exercised (it would block on a
  long-running server); the same env-load path applies.

## Round 25 - 2026-09-03 - Fix web app login: shadhil_app GRANTs missing

After Round 24, the web app's better-auth catch-all
(`/api/auth/sign-in/email`) returned 500 with
`42501 permission denied for schema public` (and later
`42501 permission denied for table Jwks`). Two GRANTs were
missing on the `shadhil_app` role:

1. **Schema-level USAGE + CREATE on `public`** - without
   these, table-level GRANTs are invisible to the role and
   Postgres returns `permission denied for schema public` (or
   `42P01 relation does not exist` depending on the access
   path). The `public` schema's default ACL was empty in this
   setup, so the implicit pseudo-role grant did not apply.
2. **Table-level CRUD on `Jwks`** - added in migration
   `20260831140000_add_jwks` without GRANTs for `shadhil_app`.
   Better-auth's `jwt()` plugin reads/writes `Jwks` on the
   pooled URL (`DATABASE_URL` → `shadhil_app`), so every
   `/api/auth/get-session` and `/api/auth/token` request failed
   with `42501 permission denied for table Jwks`.

**Investigation (chronological):**

- Initial hypothesis: same RLS-context shape as `rls.ts`
  (admin-class queries should go through `withRlsContext`).
  Disproved by reading `packages/database/src/rls.ts:17-19`:
  "the bare client (this module's `prisma` export) is NOT
  subject to RLS because the DB role used is typically the
  owner/migration role. SECOND-ROUND audit: the app now connects
  as the non-owner role `shadhil_app`..." - so the bare
  client IS the right thing for `shadhil_app` queries;
  something else is wrong.
- Probed `pg_namespace.nspacl` for `public` schema via
  `array_to_string` (Prisma can't serialize the raw array
  type). Result: `null` - no ACL entries at all. In Postgres
  16-alpine with `shadhil` (not `postgres`) as the owner, the
  default `GRANT CREATE, USAGE ON SCHEMA public TO PUBLIC`
  was apparently not preserved.
- Probed `has_schema_privilege('shadhil_app', 'public',
  'USAGE')` - false. Probed
  `has_schema_privilege('shadhil_app', 'public', 'CREATE')` -
  false. The schema-level grants are missing.
- Probed `has_table_privilege('shadhil_app', '"Jwks"',
  'SELECT')` - false. (Noticed: `Jwks` must be quoted in the
  probe because Postgres folds unquoted identifiers to
  lowercase, so `'Jwks'` would have looked up `'jwks'` which
  doesn't exist.) The table-level grant is missing on `Jwks`
  specifically.

**Changes:**

- `docker/postgres-init/00-init.sql` - added
  `GRANT USAGE, CREATE ON SCHEMA public TO shadhil_app;`
  (with JSDoc explaining the empty-ACL root cause).
- `packages/database/prisma/migrations/20260903021150_schema_grants_for_app_role/migration.sql`
  (new) - same GRANT, applied via the migration system to
  the live DB. Idempotent at the role level.
- `packages/database/prisma/migrations/20260903021500_grants_for_jwks/migration.sql`
  (new) - `GRANT SELECT, INSERT, UPDATE, DELETE ON "Jwks" TO
  shadhil_app;` for the missing table-level GRANT.
- `packages/database/prisma/rls/policies.sql` - canonical
  source updated with both GRANTs (so a future
  `psql -f policies.sql` lands them; the migrations are the
  application point for `prisma migrate`).

**What was reverted:**

- Initial first-pass edit that added a `GRANT USAGE` only to
  `policies.sql` (no schema-level fix and no `Jwks` GRANT)
  - replaced with the canonical 3-file fix above.

**Verification:**

- `pnpm db:migrate` applies both new migrations cleanly
  (`Applying migration 20260903021150_schema_grants_for_app_role`
  → `Applying migration 20260903021500_grants_for_jwks`).
- Full login flow against the running web dev server:

  ```text
  POST /api/auth/sign-in/email
    {"email":"owner@shadhilbuilders.in","password":"owner_placeholder_pw"}
    → 200 (returns session + user with role:"OWNER")
  GET  /api/auth/get-session
    → 200 (returns session + user)
  GET  /api/auth/token
    → 200 (returns JWT with role:"OWNER", iss:"shadhil-crm", aud:"shadhil-crm")
  ```

- All five workspaces type-check clean (no source code
  changed in this round, only SQL files).
- `@shadhil/auth` tests still pass (11/11).

**Lessons (for the next agent adding a new table that
better-auth writes to the pooled path):**

- Every new table that any service touches via `DATABASE_URL`
  needs both (a) a schema-level GRANT (covered by the
  `20260903021150` migration, idempotent) and (b) a
  table-level GRANT on the new table.
- Postgres' case-folding means `"Jwks"` (quoted) and `Jwks`
  (unquoted) are different - when probing privileges, always
  quote the table name in the function argument.

## Round 26 - 2026-09-03 - Fix IDB persistence: `retryDelay` function in cache

After Round 25 the login flow worked end-to-end, but a second
console error fired on every cache mutation in the browser:

```text
[browser] ⨯ unhandledRejection: DataCloneError:
  Failed to execute 'put' on 'IDBObjectStore':
    (attemptIndex)=>Math.min(1000 * 2 ** attemptIndex, 30000)
    could not be cloned.
  at <unknown> (../../packages/offline-store/src/idb-stores.ts:64:27)
  at async persistCache (src/lib/query-client/lib.ts:57:3)
```

The error names two offenders that converge on the same root
cause: the `persistCache` function was serializing the entire
Query cache via `qc.getQueryCache().getAll()` and pushing the
result straight into IndexedDB. Each `Query` object carries
its full `options` (queryFn, retry, retryDelay, ...), and the
default-options block in `lib.ts` had a custom
`retryDelay: (attemptIndex) => Math.min(1000 * 2 **
attemptIndex, 30000)` - a function. IndexedDB's structured
clone algorithm refuses functions, so every persist threw.

**Investigation (short - the stack trace pointed straight at
the bug):**

1. Confirmed `queryClient.defaultOptions.queries.retryDelay`
   in `apps/web/src/lib/query-client/lib.ts:112` was the
   function being seen in the error.
2. Confirmed `persistCache` in the same file used
   `qc.getQueryCache().getAll()` - full Query objects, not
   dehydrated - and passed them to `idbSet`.
3. Confirmed `rehydrateQueryCache` used a hand-rolled
   `qc.getQueryCache().build(qc, { queryKey })` loop that
   only seeded `queryKey`, leaving the rehydrated queries in
   an empty observable state with no `data`. So even after a
   successful read-back the UI would re-fetch everything on
   next mount, defeating the whole point of offline
   persistence.

**Decision:** use TanStack Query's official serialization
helpers (`dehydrate` / `hydrate`), which strip
non-cloneable fields (queryFn, retry, retryDelay, observers,
...) by design. Also drop the custom `retryDelay` default -
TanStack's built-in default is the same exponential backoff
`Math.min(1000 * 2 ** attemptIndex, 30000)`, so no behavior
change.

**Changes:**

- `apps/web/src/lib/query-client/lib.ts` -
  - `persistCache` now uses `dehydrate(qc)` from
    `@tanstack/react-query` instead of `getAll()`. The
    dehydrated snapshot (`{ mutations, queries }`) contains
    only data/status/error/queryKey/queryHash - no functions,
    no queryFn.
  - `rehydrateQueryCache` now uses `hydrate(qc,
    persisted.cacheState)` from the same package instead of the
    hand-rolled `build()` loop. `hydrate` re-seeds the
    QueryClient so observers can immediately see the cached
    `data` without a fresh network request - the offline-boot
    UX goal.
  - Removed the custom `retryDelay` function from
    `queryClient` defaults. TanStack's built-in default is
    identical.
- `apps/web/src/lib/query-client/lib.ts` - JSDoc updated to
    describe the new dehydrated snapshot shape and to point
    future readers at Round 26 for the history.

**What was kept:**

- The `BUSTER` / `BUSTER_KEY` mechanism - same per-load UUID
  envelope, same buster-mismatch wipes the cache. Migrations
  bump the buster by changing `BUSTER =` to a new value.
- The `lastPersistedTimestamp === 0 && empty` short-circuit -
  preserves the eng-review 4C "only write on actual cache
  change" optimization. Now keyed off the dehydrated snapshot
  (`snapshot.queries.length + snapshot.mutations.length`).
- The `RQ_CACHE_KEY` value - keys live in `rqCacheStore`
  (`packages/offline-store/src/idb-stores.ts:69`).

**Verification:**

- All five workspaces type-check clean.
- `@shadhil/auth` tests: 11/11 pass.
- Live web app: `POST /api/auth/sign-in/email` → 200;
  subsequent dashboard load → 200. The Next dev server log
  shows no `DataCloneError` entries after the fix (only the
  pre-fix entries from the prior `pn dev` process). Sign-in
  via the OWNER seat (`owner@shadhilbuilders.in`) and the
  ADMIN seat (`admin@shadhilbuilders.in`) both succeed;
  page loads run clean; cache mutations no longer trip the
  IDB clone guard.

**Lesson (for the next agent extending the cache shape):**

- Anything that ends up inside `qc.getQueryCache().getAll()`
  will eventually hit `structuredClone` on the IDB persist
  path. Use `dehydrate()` / `hydrate()` for the round-trip,
  not raw `Query` objects. If a custom field needs to ride
  along, register it via the dehydrate options
  (`shouldDehydrateQuery`) and add a rehydrate handler - but
  first ask whether it actually needs to survive a reload.
- Functions in `defaultOptions` are fine for runtime, but
  they will reach `structuredClone` the moment you serialize
  a Query. If the default is identical to TanStack's built-in
  (it usually is for `retryDelay`), drop the override.


## Round 27 - 2026-10-01 - Production images were unbuildable; deployment doc rewritten

An eng review of `docs/deployment/hostinger-coolify.md` turned into a
repair job: the guide described a stack that no longer existed, and
when the described artifacts were actually built, **two of the three
production images failed to build at all**. Nothing in CI built an
image, so none of it was visible.

**Why the doc had drifted.** It was written 2026-09-02 and edited
only mechanically since (a `yourdomain` → real-domain substitution on
2026-09-30). The plan of record moved underneath it: Decision Audit
#33-37, plan §5.0/§10, and `references/prod-deployment.md` all lock
**three** subdomains and **Traefik**, while the doc still described two
services on Supabase behind "Caddy"/"Nginx". The doc is a translation
of a locked plan, so it is only as current as its last re-read of that
plan.

**Decisions taken:**

- **Three services, not two.** `apps/realtime-sse` gets its own
  Coolify app, subdomain (`sse.crm.shadhilbuilders.in`) and Dockerfile
  - which did not exist, so the SSE service could never be deployed.
  Matches Decision #33 and the web BFF's existing `SSE_BACKEND_URL`
  contract; no application code changed.
- **Self-hosted Postgres 16 + PgBouncer, not Supabase.** The repo
  already runs this in `docker/docker-compose.yml` with
  `POOL_MODE=session` boot-enforced for RLS. Supabase was removed from
  the web Dockerfile, the CI job and `.env.example` (the web env schema
  never had Supabase vars and there is no `supabase` dependency).
- **Traefik, never Caddy/Nginx** (restates Decision #36 - the doc was
  the one place still contradicting it).
- **Traefik labels stay in `docker/docker-compose.yml`, but with
  `${VAR:-default}` hostnames** (`CRM_HOST`/`API_HOST`/`SSE_HOST`).
  Keeps one file serving both the Coolify production topology and a
  local Traefik run, instead of hardcoding production domains into a
  file that also does dev duty. Labels are inert without a Traefik
  container on the network, so `docker compose up api` still works
  standalone. Verified: defaults render the production hostnames, and
  `CRM_HOST=crm.local` renders `crm.local`.
- **`.github/workflows/vercel.yml` and `.vercel-deploy-test.md` deleted.**
  They contradicted the Coolify stack; nothing referenced them except
  one design doc (now stale on that point).

**Build defects fixed (all reproduced with a real `docker build`):**

1. `apps/backend/Dockerfile` ran `tsc` before `prisma generate`. The
   generated Prisma client is **gitignored**, so a clean build context
   lacks it and `tsc` exits 2 with five `TS2307` errors. Invisible
   locally because a dev working tree already has the generated files.
   Fix: run `prisma generate` before the database build. `prisma
   generate` needs no `DATABASE_URL` (only `migrate` does).
2. `apps/web/next.config.ts` had `output: 'standalone'` commented out
   while the Dockerfile copied `.next/standalone`. Fix: enabled it. CI
   now asserts the file exists so the failure names its cause.
3. Web install copied `package.json` + `pnpm-lock.yaml` but not
   `pnpm-workspace.yaml`, where the lockfile's `overrides` live →
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, which blocked **all three**
   images. The old `COPY . .` had masked it.
4. The web runner ran `node server.js`, but a pnpm monorepo standalone
   tree roots at the repo root, so the server is at
   `apps/web/server.js`. Fix: corrected the copy paths and `CMD`.
5. The web `postinstall` runs bash and `node:22-alpine` has no bash.
   Fix: `pnpm install --ignore-scripts`.
6. `BACKEND_API_URL` had no build arg, so the image baked the
   `http://localhost:8080` fallback → healthy container, every BFF call
   502s. Fix: declared it as a build `ARG`.
7. `next build` prerenders `/api/docs` and imports the auth chain, so
   `@t3-oss/env-nextjs` and `assertAuthEnv()` both run at build time;
   `assertAuthEnv()` has no skip switch. Fix: shape-valid placeholder
   server env, INLINE on the build `RUN` (not `ENV`) so no scanner
   mistakes them for baked secrets, and they stay out of the runner
   stage. Never pass real secrets as build args.
8. Nothing in CI built an image. Fix: added the `docker-images` job
   (all three Dockerfiles, from a clean checkout).

Also added a repo-root `.dockerignore` - root-context builds were
shipping `node_modules`, every `.next`, and the real `.env` into the
builder.

**Verification (not assumptions):**

- `docker build` exit 0 for `shadhil-web`, `shadhil-backend`,
  `shadhil-realtime-sse` on Docker 29.8.0.
- `shadhil-web` runner contains `/app/apps/web/server.js`, owned by
  `nextjs`; `0` `SecretsUsedInArgOrEnv` warnings.
- The SSE image **boots**: `[realtime-sse] listening on
  http://localhost:8090`.
- `docker compose config` valid; all 6 services resolve.
- `pnpm --filter @shadhil/web type-check` → 0; `lint` → 0;
  `test` → 865 passing across 89 files.

**Lesson for the next agent:** a Dockerfile that nothing builds is not
"probably fine" - it is unverified. Two of these had been broken since
they were written, and every one of them was invisible to `pnpm build`
because the local tree holds state (the generated Prisma client) that a
clean build context does not. When a deploy guide and the plan of
record disagree, re-read the plan before touching the guide.

**Still open:** the SSE service has no lint/test config (`test` is an
`echo` stub), and there is no SSE load test. Both are Week 12+ work.
