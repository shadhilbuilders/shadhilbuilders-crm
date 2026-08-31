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
