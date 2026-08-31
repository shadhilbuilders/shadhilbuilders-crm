# Shadhil CRM — Change Log

A trace of every design decision in this directory, in order.

## Round 0 — 2026-08-29, 19:41 UTC — PM-agent first brief

`DESIGN.md` (v1) saved. Delegated to the `agency_agents` Product
Manager specialist. 10 sections: roles (Sales Agent + Sales Manager +
Admin + Marketing), 8 modules, single-owner lifecycle state machine,
MVP = 5 modules + thin booking, multi-project data model, 6
integration touchpoints, stack = Next.js + Drizzle + Neon + Vercel,
5 success metrics, 8 open questions, 7 out-of-scope items.

## Round 1 — 2026-08-29, ~20:00 UTC — Client's first call

`CLIENT-FEEDBACK-2026-08-29.md` saved. Client revealed:
- Roles are actually 4 distinct: Admin (1, super-user), Manager
  (multiple, manages telecallers + execs), Telecaller (first touch),
  Sales Executive (closer, post-handoff).
- Two-stage ownership with hard handoff gate at "customer agreed
  to visit" — single `assignedTo` field is wrong.
- Chat interface is a first-class MVP module, not an activity log.
- Permission matrix is missing.
- Cloud telephony (Exotel/Tata Tele/Knowlarity) gets promoted
  from defer to must-have.
- Audit log writes in v1, UI in vNext.
- 6 new open questions added (Q9–Q15).

## Round 2 — 2026-08-29, ~20:30 UTC — Stack pushback

`CLIENT-FEEDBACK-v2-2026-08-29.md` saved. User asked about Supabase
+ Prisma + better-auth instead of Neon + Drizzle + NextAuth, and
web + Android + iPhone apps, and direct telecaller → exec
assignment, and no-show follow-up, and RBAC + ABAC.

Decisions:
- "Director" → **Manager** (clearer in Indian real-estate).
- **Supabase** over Neon (free tier + RLS + Mumbai region).
- **Prisma** accepted (Drizzle push-back noted but user chose Prisma).
- **better-auth** over Supabase Auth (MIT, no per-user pricing).
- **Web + mobile both in v1** — recommend PWA first, Expo in v1.1.
- **Direct telecaller → exec: NO** for v1, manager handoff stays
  default. `ManagerAssignmentRule` table designed in for v1.1.
- **No-show / reschedule states in v1**, not vNext.
- **RBAC + ABAC both from day 1** (per PaalStack saas-mvp-architecture
  skill default at the time).

## Round 3 — 2026-08-29, ~20:50 UTC — Real-world stack evaluation

`CLIENT-FEEDBACK-v3-2026-08-29.md` saved. User said: drop the
PaalStack pattern matching, evaluate stacks for real-world fit.
User also said: NOT using Vercel, will use NestJS + GraphQL
backend on Hostinger VPS via Coolify.

Decision: **Option B (NestJS + GraphQL + VPS) locked**, with
explicit acknowledgement of the 3-4× slower time-to-MVP cost
in exchange for "reusable infra" value.

## Round 4 — 2026-08-29, ~21:10 UTC — BFF pattern locked

`CLIENT-FEEDBACK-v4-2026-08-29.md` saved. User asked: "Can we
use better-auth BFF in Next.js or Next.js route handler for
mobile?"

Verified `@better-auth/expo` (v1.6.29, 15+ projects) is the
official mobile plugin. Decision: **better-auth BFF in Next.js
serves BOTH web and mobile** via the same `/api/auth/*` endpoints.
JWT bridge to NestJS. Monorepo with 3 apps (web, mobile, backend)
+ 3 shared packages (api-types, auth-client, ui-tokens). Full
Prisma schema with 12 models included in this delta.

Subdomain structure: Option 1 (split — crm + crm-api) chosen.

## Round 5 — 2026-08-29, ~21:30 UTC — REST over GraphQL

`CLIENT-FEEDBACK-v5-2026-08-29.md` saved. User asked: "Can we
use REST instead of GraphQL? I only said GraphQL because easy
integration for mobile app. Is it true?"

Verified: half-true claim. TanStack Query is the 2026 standard
(12M+ weekly downloads), works equally well with REST and GraphQL.
Switched to **REST + TanStack Query + SSE for chat realtime**.
Saves 1-2 weeks of GraphQL setup + 1-2 weeks of subscription
server work. New realistic timeline: 8-9 weeks (later revised to
10 weeks for the first-time-build tax).

## Round 6 — 2026-08-29, ~21:45 UTC — India telephony pricing

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

## Round 7 — 2026-08-29, ~21:57 UTC — Amazon Connect comparison

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

## Round 8 — 2026-08-29, ~22:15 UTC — Apply (DESIGN.md v2)

DESIGN.md v2 written. Consolidates v1 + 7 rounds into a single
38KB document. 18 sections: roles, modules, lifecycle, RBAC
matrix, entities, integrations, stack, auth flow, SSE chat,
push notifications, success metrics, timeline, open questions
(Q0–Q16), NOT in scope, what already exists, pushbacks, decision
log, where to read more. CLIENT-QUESTIONS.md updated to v2 with
Q0–Q16 grouped by priority.

## Round 9 — 2026-08-29, ~22:30 UTC — Prisma + multi-app database pattern

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

## Round 10 — 2026-08-29, ~22:35 UTC — Reminders module added

`CLIENT-FEEDBACK-v9-2026-08-29.md` saved. User asked for reminders
to staff (telecaller + sales exec) when customer reschedules a
site visit. Not just a clarification — a real new feature.

Added a new Reminders module to v1 with 4 reminder types:
1. Pre-visit staff reminder (T-2h before, push + in-app + email)
2. Pre-visit customer reminder (T-24h and T-2h, WhatsApp)
3. Reschedule follow-up reminder (T+1h after reschedule,
   prompts staff to confirm with customer — THE ONE USER ASKED FOR)
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
visit_reminder_2h) — submit in week 1 to overlap with Meta's
approval SLA.

Updated timeline: 10 weeks → 12 weeks (1 week for reminder system).

## Round 11 — 2026-08-29, ~22:36 UTC — Resolved all 16 client questions

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

## Round 12 — 2026-08-29, ~22:50 UTC — Full push notification system

`CLIENT-FEEDBACK-v10-2026-08-29.md` saved. User asked for "push
notification for staff for both web and mobile." The v2 brief §10
only covered ONE trigger (lead assignment). This delta adds a
complete cross-platform push system.

**Design:**
- **Expo Push as the universal push service** (handles iOS,
  Android, AND web via one API — saves 1-2 weeks of multi-
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
  data clear) — backend must handle

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

## Round 13 — 2026-08-29, ~22:58 UTC — Notification center (inbox) added

`CLIENT-FEEDBACK-v11-2026-08-29.md` saved. User asked: "Store
notifications and show it in the crm app both web and mobile."
The v10 push design covered OUTBOUND (sending push) but not
INBOUND (user sees their notifications in the app). This delta
adds the inbox-style notification center.

**Design:**
- New `Notification` table (separate from v10's `PushNotification`
  audit log) — the user's inbox. Mutable state (`readAt`,
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

**One choice to surface:** Daily summary push (trigger 12) —
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

## Round 14 — 2026-08-29, ~23:05 UTC — APPLY: DESIGN.md v3

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

## Round 15 — 2026-08-29, ~23:08 UTC — Telecaller handoff point question

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

  A) Handoff at "verbal yes" — current v3. Telecaller has
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

## Round 16 — 2026-08-29, ~23:15 UTC — APPLY Model C: Hybrid handoff

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
    VISIT_SCHEDULED visibility — both telecaller and exec
    can see the lead during the scheduled window.
  - **§5 Enums:** LeadStatus reduced from 15 to 13 states
    (removed HANDED_OFF_TO_MANAGER, ASSIGNED_TO_EXEC).
  - **§6 Integrations:** Removed `sales_exec_handoff_intro`
    WhatsApp template (not needed in Model C — the exec
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

## Round 17 — 2026-08-31 — User-creation hierarchy locked

Client confirmed the user-creation model:

- ONE admin exists (seeded, placeholder credentials per §17
  Input #5, rotate on first login). The admin bootstraps the
  org: can create MANAGER, TELECALLER and SALES_EXEC users.
- A MANAGER, once created, can create TELECALLER and
  SALES_EXEC users — scoped to their own team.
- TELECALLER and SALES_EXEC can create nobody.

Code change baked in now
(`packages/auth-client/src/auth.ts`): `admin()` plugin options
extended to `admin({ defaultRole: 'TELECALLER', adminRoles:
['ADMIN'] })` — better-auth 1.7 gates its admin endpoints
(user create/list/ban via adminClient) to the ADMIN role only;
MANAGER keeps plain sign-in. `role`/`teamId` remain
`input: false` additional fields, so no signup path can
self-assign a role.

Still to build (not yet in the repo as of this round):
- `users` module in apps/backend — role-guarded create/list
  endpoints. ADMIN creates any role; MANAGER creates
  TELECALLER/SALES_EXEC only within `Team.managerId` scope.
  Enforce with a NestJS guard, not UI hiding.
- Credential setup on create must mirror `seed.ts` upsertUser:
  `Account` row keyed `providerId: 'credential'`,
  `accountId: user.id`, `issuer: 'local:credential'`,
  scrypt `salt:key` hash (N=16384, r=16, p=1, dkLen=64,
  NFKC-normalized) — better-auth 1.7 sign-in contract
  (dist/api/routes/sign-in.mjs:320).
- Web UI: admin "Users" page + manager "My Team" page.
- Open question: when the ADMIN creates a MANAGER, team
  assignment — creating the manager auto-creates their Team
  (Team.managerId = manager) vs admin picks an existing team.
  Recommended: auto-create team on manager creation;
  manager-created users join the manager's teamId.
- Open question (superseded by Round 20): the earlier
  single-ADMIN fragility is resolved by the new SUPER_ADMIN
  layer instead of admin self-service.

## Round 18 — 2026-08-31 — Lead creation + authority inheritance

Client confirmed two more rules:

1. **Telecaller and Sales Exec CAN create leads/enquiries.**
   The §4 permission matrix had no "create lead" row at all —
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
telecaller cannot log VISITED — these are Model C
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

## Round 19 — 2026-08-31 — Users module BUILT and live-verified

The user-creation hierarchy (Rounds 17/18) is implemented,
endpoint-tested, and cleaned up after. Uncommitted.

**New files**
- `apps/backend/src/users/` — module, controller, service:
  - `POST /api/users` — ADMIN creates any role; MANAGER
    creates TELECALLER/SALES_EXEC in their own team; staff
    roles → 403. Admin creating a MANAGER without teamId
    auto-creates the Team. Admin creating staff without
    teamId → 400. Unique-email conflict → 409 (Prisma).
  - `GET /api/users` — admin: all; manager: via
    `Team.managerId`; staff: self. 403-free for admin/manager
    paths by role. staff see exactly one row (self).
  - `apps/backend/src/users/roles.ts` — hierarchy +
    `assertCanCreateRole`. Explicit per-target rules after
    live test caught rank-equality bug (manager→manager was
    201 before the fix).
  - `apps/backend/src/users/credentials.ts` — better-auth 1.7
    Account contract: `providerId: 'credential'`,
    `accountId: user.id`, `issuer: 'local:credential'`,
    scrypt N=16384/r=16/p=1/dkLen=64 "salt:key" (seed.ts
    mirror). Verified: admin-created manager signs in 200.

**Changed files**
- `packages/database/src/index.ts` — re-exports
  `withRlsContext` / `RlsContext` / `RlsTx` (was internal only).
- `packages/api-types/src/auth.ts` — `CreateUserDtoSchema` /
  `CreateUserDto` (Zod, role explicit, no default).
- `apps/backend/src/auth/better-auth.middleware.ts` —
  `forRoutes('auth/*splat')` (Nest 12 path-to-regexp v8) +
  imports AuthModule for the handler token + **now imported in
  app.module.ts** (it never was — sign-in was broken on the
  API side until today).
- `apps/backend/src/app.module.ts` — UsersModule +
  BetterAuthMiddlewareModule registered.
- `apps/backend/src/prisma/prisma.module.ts` — exports
  PrismaService.
- `packages/auth-client/src/auth.ts` (from earlier today) —
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
  issue (or manager JWTs should carry the managed team id) —
  tracked as a follow-up.
- Round 17's open question is resolved by implementation:
  manager creation auto-creates a Team; passing an explicit
  teamId for a new MANAGER is also supported (admin choice).


## Round 20 — 2026-08-31 — 5-role model + role changes, BUILT and live-verified

Client locked the final role model and its change hierarchy:

- Roles: SUPER_ADMIN, ADMIN, MANAGER, TELECALLER, SALES_EXEC.
- Exactly ONE SUPER_ADMIN, ever (client-confirmed). Exists only
  via seed/migration; the API refuses to create, assign, or
  change it — enforced in code AND by a Postgres partial
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
- `20260831110000_role_super_admin` — ALTER TYPE Role ADD
  VALUE 'SUPER_ADMIN' BEFORE 'ADMIN' (split transaction per
  Postgres ALTER TYPE rules).
- `20260831110100_bootstrap_super_admin` — seeded
  admin@shadhilbuilders.in row updated ADMIN → SUPER_ADMIN.
- `20260831110200_one_super_admin_only` — partial unique index
  ON "User"(role) WHERE role='SUPER_ADMIN' (Prisma cannot
  express partial indexes; native SQL only). Live-verified
  with a deliberate duplicate insert → unique violation.
- schema.prisma Role enum + regenerated client.
- seed.ts: 'SUPER_ADMIN' placeholder (admin@ email kept),
  Role type widened.

**RLS layer** (packages/database/src/rls.ts): SUPER_ADMIN has
no policies of its own — withRlsContext downcasts it to ADMIN
so all 19 existing policy sites keep working unchanged.
app.user_role receives 'ADMIN' for super admins; the JWT and
API layer keep the distinction. Role registries moved in
lockstep: rls.ts ROLES + Role union, jwt.ts ROLES,
api-types RoleSchema (+ new AssignableRoleSchema excluding
SUPER_ADMIN — unused by the endpoint for now, kept as the
documented contract), auth-client admin plugin now
`roles: { ADMIN: adminAc, SUPER_ADMIN: adminAc },
adminRoles: ['SUPER_ADMIN','ADMIN']` (better-auth 1.7 requires
adminRoles entries to be keys in `roles`; ADMIN reuses the
stock adminAc statement set — the package test caught this).

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
  teams are `seed-team-<id>` — a permanent legit pattern the
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
Test data deleted after the run — DB back to the 4 seeded
users (1 super admin, 1 manager, 1 telecaller, 1 sales exec),
1 team, audit rows intact.

**Still open (pre-existing, tracked in Round 19):** jwks table
for better-auth's /api/auth/token; JWT teamId claim refresh
for managers.

