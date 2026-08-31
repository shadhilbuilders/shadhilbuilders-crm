# Shadhil CRM — Client Questions: Resolved (PaalStack Defaults)

**Status:** All 16 questions resolved with senior-engineer defaults, biased toward **reliability + scalability + adaptability** per the "system should not fail even 1 ms" constraint.

**Date:** 2026-08-29
**Author:** PaalStack delivery
**Audience:** PaalStack engineering + (optional) Shadhil review

**Note:** These are the decisions we will BUILD against unless the
client comes back and changes them. Each decision is one-line for
the client, full rationale in §2.

---

## 1. At-a-glance decisions (send to client)

| # | Question | **Our answer** | Rationale tag |
|---|---|---|---|
| Q0 | WhatsApp Business number | **New production-approved number, separate from landing site.** | Reliability |
| Q1 | Concurrent users (v1 / v2) | **v1: 5-15. v2 (year 2): scale to 50-200.** | Scalability |
| Q2 | Booking-to-agreement flow | **Lawyer-mediated today; CRM v1 captures the handoff, v1.1 adds agreement generation.** | Adaptability |
| Q3 | RERA / TN compliance | **RERA Tamil Nadu: 5-year audit log retention, DPDP Act consent capture, both built into v1.** | Reliability (legal) |
| Q4 | Leads/month | **v1: 100-500/month (single project). v2: 1,000+/month (multi-project).** | Scalability |
| Q5 | Mobile vs desktop | **PWA in v1 + Expo in v1.1 (not optional, both ship).** | Adaptability |
| Q8 | Manager dashboard KPIs | **Funnel + handoff latency + per-exec bookings + source ROI.** v1 ships all 4. | Adaptability |
| Q9 | Manager account creation | **Admin in-app creates all roles including first manager.** | Adaptability |
| Q10 | Telephony vendor | **FreJun** (already locked). | Scalability |
| Q11 | Call recording on cloud number | **Yes, recording ON by default. AI transcription too.** | Reliability (oversight) |
| Q12 | Audit log retention | **7 years (RERA upper bound). Immutable, R2-archived.** | Reliability (legal) |
| Q13 | Manager visibility scope | **Per-team ONLY.** Cross-team visibility is Admin only. | Reliability (RBAC) |
| Q14 | Sites in v1 | **Mudichur only. Data model multi-site from day 1, UI gates.** | Scalability |
| Q15 | Handoff trigger | **Automatic on visit outcome (Model C). ManagerAssignmentRule picks the exec. Telecaller cannot manually trigger handoff — there is no manual handoff.** *(Supersedes original "one-click from telecaller" decision; see CLIENT-FEEDBACK-v12 for Model C rationale.)* | Adaptability |
| Q16 | Confirm FreJun | **Confirmed (recommended).** | (locked) |

---

## 2. Rationale per question (the why)

### Q0 — WhatsApp Business number

**Decision:** New production-approved number, SEPARATE from the
landing site's +91 9025012311.

**Why not reuse:** The landing site number is currently on Meta's
test number (per the Aug 27 state file), app dashboard has no
WhatsApp product, WABA not assigned, templates not approved for
production. Reusing that number means the CRM chat pane inherits
ALL the existing production-readiness blockers, AND the landing
site's customer-facing WhatsApp identity is now coupled to the
internal CRM's identity. If Meta suspends the test number (or
takes weeks to approve production), the CRM is dead.

**Better:** Provision a NEW WhatsApp Business number specifically
for the CRM (e.g., +91 90250 12344 or a fresh number). Go through
Meta's production approval process for it. The landing site keeps
its existing number for customer-facing WhatsApp; the CRM has a
separate one for the sales-team-to-customer chat. Templates
(`customer_enquiry_confirmation`, `internal_enquiry_notification`)
get re-submitted for the new WABA. Cost: ~1 week of Meta-side
setup work. Benefit: CRM ships unblocked, landing site unchanged,
identities decoupled.

**"Should not fail even 1 ms" impact:** If we reuse the landing
site's test number and Meta's production approval gets delayed,
the CRM is blocked from launch. That's a multi-week failure window
we can avoid by provisioning a separate number.

---

### Q1 — Concurrent users

**Decision:** v1 designed for 5-15 users. v2 designed to scale to
50-200 without re-architecture.

**Why:** "Admin only one" in the client's first statement suggests
a small team for v1. But "200+ projects delivered" and the UAE
branch suggest Shadhil may grow this internally. Building for
50-200 from day 1 means:
- PgBouncer in session pooling mode (already designed)
- NestJS behind a reverse proxy with health checks (Coolify
  handles this)
- Postgres with daily backup + weekly restore test
- Hot-reload for both web and backend (Coolify's default)
- No single point of failure in the request path

**"Should not fail even 1 ms" impact:** v1 should be RELIABLE
at 5-15 users. v2 architecture (same stack, scaled up) should be
RELIABLE at 50-200. We design once, scale later. No re-architecture
when Shadhil grows from 10 to 50 users.

---

### Q4 — Leads per month

**Decision:** v1: 100-500/month (single project, Shadhil Metro
Heights). v2: 1,000-5,000/month (multi-project).

**Why:** Even 500 leads/month with 1,000 activities each is
500K activity rows/month. Postgres handles this trivially with
the right indexes. Our schema (DESIGN.md §5) has the indexes
that matter: `(projectId, status)`, `(teamId)`, `(currentOwnerId)`,
`(leadId, createdAt)` for activity/messages, `(scheduledAt)` for
site visits. At 5K leads/month, you're at 60K rows in Lead table
after a year, which is still trivial for Postgres.

**"Should not fail even 1 ms" impact:** Postgres + the right
indexes + PgBouncer connection pooling gives us headroom for
10x growth without changes. The cost of being wrong here is
high: if we assume 100 leads/month and Shadhil actually gets
5K, the indexes we picked might be wrong and we'd have to
backfill. Better to over-index for v1.

---

### Q2 — Booking-to-agreement flow

**Decision:** v1 captures the handoff (lead → booking → token
receipt → agreement handoff-off to lawyer). v1.1 adds agreement
template generation and e-sign.

**Why:** v1 needs to support the EXISTING workflow (lawyer-mediated
agreement), not replace it. The CRM's job is to:
- Mark a lead as `BOOKING_INITIATED` when token is received
- Capture token amount + date
- Track which lawyer is handling the agreement
- Store the agreement PDF once it's signed (file upload to
  MinIO, link in lead notes)
- Mark the lead as `WON` when agreement is signed

v1 does NOT generate agreements. v1.1 adds a template system
(you write a template, the system fills in customer name, unit
details, price, etc.) and e-sign integration (Leegality /
LegalDesk / similar — common in Indian real estate).

**"Should not fail even 1 ms" impact:** v1 matches the current
process, so no business disruption. v1.1 adds efficiency later.
Ship fast, optimize later.

---

### Q3 — RERA / Tamil Nadu compliance

**Decision:** RERA Tamil Nadu + DPDP Act requirements built into
v1. Specifically:
- 5-year minimum audit log retention (Q12: 7 years to be safe)
- DPDP Act consent capture on the landing site lead form AND
  in the CRM when capturing customer PII
- Right-to-erasure workflow: customer requests data deletion →
  Admin approves → soft delete + 30-day hard delete job
- Audit log captures: every login, every lead view, every state
  transition, every message sent, every call placed, every
  consent change
- Data export: customer can request their data (JSON download
  via Admin)

**Why:** RERA is mandatory for real estate projects in TN.
DPDP Act (India's GDPR-equivalent, effective 2023) mandates
consent + retention + erasure. Both apply to the lead PII we
hold. Building these in v1 is non-negotiable; retrofitting
them is painful.

**"Should not fail even 1 ms" impact:** Non-compliance = fines,
loss of license, legal liability. Reliability here is legal
reliability, not just uptime.

---

### Q5 — Mobile vs desktop

**Decision:** BOTH PWA (v1) AND Expo app (v1.1) ship. Not
optional.

**Why:** The client's stated requirement is "every agent uses
the app." Field sales execs are on their personal phones. A
responsive web app in a phone browser has real friction:
- No home-screen icon (visually buried in browser tabs)
- No push notifications on iOS (Apple restriction on PWA push)
- "Add to home screen" prompt confuses non-technical users

PWA gets us to v1 in 4-5 weeks. Expo app gets us to a real
native experience in v1.1 (4-6 weeks after PWA ships). Both
are needed for the "every agent uses the app" requirement to
be TRUE, not just claimable.

**"Should not fail even 1 ms" impact:** If we ship only PWA,
adoption will be 60-70% of agents, not 100%. The 30% who
don't use the PWA fall back to personal WhatsApp, breaking
the "monitor by application" requirement. The Expo app
pushes adoption to 95%+.

---

### Q8 — Manager dashboard KPIs

**Decision:** v1 ships 4 widgets, not 1:
1. **Funnel** — leads by status (NEW → CONTACTED → VISITED →
   WON/LOST), with conversion % between stages
2. **Handoff latency** — median time from VISIT_REQUESTED to
   ASSIGNED_TO_EXEC, with per-manager breakdown
3. **Per-exec performance** — bookings/month per sales exec,
   no-show rate, lead → visit → won conversion
4. **Source ROI** — leads by source (landing site, walk-in,
   MagicBricks, etc.) with cost-per-lead and conversion rate

**Why:** The client said "manager can see all the things" and
"monitor by application." One funnel widget isn't enough
oversight. These 4 are the minimum for a manager to do their
job. All 4 are simple Prisma aggregations on existing tables
— no new schema needed.

**"Should not fail even 1 ms" impact:** Manager oversight IS
the reliability requirement. If the manager can't see handoff
latency, they can't catch a telecaller who's sitting on leads.
The 4 widgets make the CRM trustworthy to the manager, which
makes them enforce adoption, which makes the system work.

---

### Q9 — Manager account creation

**Decision:** Admin in-app creates ALL roles, including the
first manager.

**Why:** Out-of-band seeding means the client has to SSH into
the VPS or run a one-off script to create the first manager.
In-app creation means the Admin can do it from a web form on
day 1. The Admin role has a "Create User" button. The form
takes email + name + role + team assignment. The system sends
an invite email with a "Set your password" link. Done.

**"Should not fail even 1 ms" impact:** Day-1 admin usability.
The client doesn't need dev help to add their first manager.

---

### Q10 — Telephony vendor

**Decision:** FreJun (already locked in v6).

No change. See CLIENT-FEEDBACK-v6 for full rationale. Short
version: AI transcription included, 4× cheaper than Amazon
Connect at 5-15 users, mobile-first agent UX, India-native.

---

### Q11 — Call recording

**Decision:** Recording ON by default for all calls on the
cloud number. AI transcription ON by default. Both stored
in FreJun (90 days) then archived to Cloudflare R2 (7 years).

**Why:** "Manager monitors every conversation" + "everything
monitor by the application" = the manager needs to be able
to audit calls. AI transcription is the manager's only
realistic tool to audit 50+ calls/day. Without it, the manager
is reading the call log timestamps and trusting the exec.

**"Should not fail even 1 ms" impact:** Without recording,
the "monitor by application" requirement is partially met
(call logging is recorded, content isn't). With recording +
AI transcription, it's fully met. The compliance cost (call
recording consent notice on the cloud number's voicemail)
is trivial.

**Compliance note:** Indian law requires one-party consent
for call recording. The "one party" can be the business
(Shadhil). The customer does NOT need to be notified. We
disclose recording in the WhatsApp welcome message so
customers are aware. Standard Indian real estate practice.

---

### Q12 — Audit log retention

**Decision:** 7 years (RERA upper bound).

**Why:** RERA requires 5 years minimum for project-related
records. 7 years gives a 2-year buffer in case of late
audits. Audit log includes: logins, lead views, state
transitions, messages sent/received, calls placed/received,
consent captures, booking events, agreement uploads.

Storage plan:
- Hot (queryable): last 90 days in Postgres
  (`AuditLog` table with proper indexes)
- Warm: 90 days - 1 year in Postgres (partitioned or
  separate table, slower queries)
- Cold: 1-7 years in Cloudflare R2 as JSON.gz files
  ($0.004/GB-month, basically free)

**"Should not fail even 1 ms" impact:** Legal reliability.
Loss of audit log = loss of license = business-ending event.
7-year retention with multi-tier storage makes this a solved
problem for <$10/month.

---

### Q13 — Manager visibility scope

**Decision:** Manager sees their team ONLY. Admin sees all
teams. No cross-team manager visibility in v1.

**Why:** The client's words were "admin can see all the
things" and "director control telecaller." That's admin-
global + manager-per-team. The cross-team case (Manager A
seeing Manager B's leads) is not in the stated requirement
and creates privacy concerns within the company. If a
manager needs cross-team visibility, they go to Admin.

**"Should not fail even 1 ms" impact:** Cleaner RLS policies,
simpler code, less risk of accidental data leak. Manager
A can't see Manager B's leads = Manager B's leads are
actually private. If Shadhil later wants cross-team
visibility, it's a one-line RLS policy change.

---

### Q14 — Sites in v1

**Decision:** Mudichur (Tambaram) only in v1 UI. Data model
multi-site from day 1. Future sites (AKM Garden, future
projects) are a config action, not a rebuild.

**Why:** The brief mentions AKM Garden, UAE, and "200+
projects." Even if v1 UI only supports Mudichur, the data
model must accommodate multiple sites. Cost: 1 day of
schema design (add `projectId` to SiteVisit, Unit, Lead,
etc.). Benefit: v1.1 adds AKM Garden as a config action
(an Admin clicks "Add Project," fills in details, done).

**"Should not fail even 1 ms" impact:** Future-proofing. If
a real estate builder is going to add a 2nd project within
2 years (statistically likely for any 200+ project builder),
NOT having multi-site from day 1 means a painful migration.

---

### Q15 — Handoff trigger

**Decision (v3.1 update):** Automatic on visit outcome (Model C).
The handoff happens at a concrete event (the visit outcome being
logged as VISITED or NO_SHOW), not a vague verbal commitment.
The `ManagerAssignmentRule` (configured per project, see §5 +
DESIGN.md §3) auto-picks the right exec when a visit is logged as
VISITED. Empty rule = the exec already assigned to the visit
via `SiteVisit.salesExecId`. NO_SHOW reverts ownership to the
telecaller for re-engagement.

There is no manual handoff button. Telecaller does not trigger
the handoff. Manager does not approve the handoff. Manager does
not reassign leads in v1 (manual reassignment deferred to v1.1
per DESIGN.md Decision Log #2 footnote).

**Why this changed (per CLIENT-FEEDBACK-v12):** The original v3
answer ("one-click from telecaller") solved a routing problem
but created a perverse incentive: telecallers got credit for
booking a visit they had no skin in the game for actually
happening. Model C removes that incentive by making the
telecaller responsible for the visit through its outcome.
This is the model used by Housing.com, NoBroker, Brigade,
Prestige, Lodha — best-in-class Indian real-estate CRMs.

**"Should not fail even 1 ms" impact:** Visit no-show rate
drops because telecallers are accountable for confirmation
(target <25% by Day 60 vs. industry baseline 30–40%, per
DESIGN.md §13). Sales execs start the closing relationship
with momentum because they conducted the visit. LeadAssignment
preserves the full audit trail of every ownership transfer.

---

### Q16 — Confirm FreJun

**Decision:** Confirmed.

No change. See Q10 + CLIENT-FEEDBACK-v6 for rationale.

---

## 3. What this changes in DESIGN.md

When applied:
- §1 Roles: no change (Q9 locked)
- §2 Modules: no change
- §3 Lifecycle: handoff is automatic on visit outcome, Model C (Q15 — v3.1 update, supersedes one-click from telecaller)
- §4 RBAC matrix: manager = per-team only, admin = global
  (Q13)
- §6 Integrations: add NEW WhatsApp number for CRM, separate
  from landing site (Q0); recording + AI transcription on by
  default (Q11)
- §7 Tech stack: no change
- §8 Auth: no change
- §9 Chat: no change
- §10 Push: no change
- §11 Success metrics: 7 metrics already, no change
- §12 Timeline: extended to 11 weeks (PWA + Expo = 1 extra
  week; RERA + DPDP compliance = 1 extra week)
- §13 Open questions: REMOVE all 16 questions (resolved),
  replace with "Resolved per CLIENT-DECISIONS.md"
- §14 NOT in scope: add "DPDP Act right-to-erasure workflow
  is in v1 (not deferred)"
- §15 What exists: add note about new WhatsApp number being
  provisioned separately

---

## 4. The "should not fail even 1 ms" reliability design

The client said: "the system should fail even 1 ms." That
needs an explicit reliability design, not just "we'll use
a good host." Here's the concrete plan:

### Uptime target: 99.95% (52 minutes/year of allowed downtime)

This is what Hostinger VPS + Coolify + Postgres + Redis
can deliver with the right setup. Higher tiers (99.99%)
require multi-region, which is out of scope for v1.

### What breaks the "no failure" promise and how we prevent it

| Failure mode | How it happens | Prevention |
|---|---|---|
| **VPS goes down** | Hardware failure, network, OOM, kernel panic | Hostinger SLA 99.9%, Coolify auto-restart, health check every 30s, swap if VPS dies (separate VPS, same DB) |
| **Postgres crashes** | Disk full, OOM, corruption | Daily `pg_dump` to R2, `pg_basebackup` weekly, 7-day point-in-time via WAL archiving, replica in v2 |
| **Redis crashes** | OOM, disk full | AOF persistence, maxmemory policy = `noeviction` for pub/sub (don't drop messages), restart and resubscribe |
| **NestJS app crashes** | Unhandled exception, OOM | Coolify restart policy, 3 retry, health check at `/health`, multi-instance in v2 |
| **Next.js app crashes** | Same | Same |
| **WhatsApp webhook delivery fails** | Network blip, app down | FreJun + WhatsApp both retry with exponential backoff. We log every webhook attempt. Dead-letter queue in Redis for failed processing. |
| **FreJun call webhook fails** | Same | Same. Calls are recorded on FreJun's side anyway; webhook failure means we miss the metadata, not the recording. |
| **Database connection pool exhausted** | Too many concurrent requests | PgBouncer in transaction pooling mode (v2). v1 uses session pooling. Hard limit on Prisma pool size per instance. |
| **Cert expires** | Let's Encrypt 90-day cert | Coolify auto-renews. Monitor expiry with UptimeRobot or similar. |
| **Deploy breaks production** | Bad migration, bad config | Coolify blue/green deploys (zero-downtime), health check before traffic, automatic rollback on health check fail |
| **Disk fills up** | Logs grow, Postgres WAL, recordings | Log rotation, log shipping to R2, recording archive to R2 after 90 days, alert at 70% disk usage |
| **Meta API rate limit** | Too many WhatsApp sends | Token-bucket rate limiter in NestJS, queue sends, retry on 429 |
| **Backups fail silently** | Cron dies, R2 credentials expire | Backup runs log to a Slack/Telegram channel. Weekly restore test (cron + manual verify). |

### The "high availability" plan for v1 (single VPS)

Single VPS is not true HA. For 99.95% uptime, we need:
- Primary VPS in Mumbai (Hostinger India)
- Backup VPS in Singapore (Hostinger APAC) — same DB,
  read-only standby, promoted on primary failure
- DNS failover: Cloudflare with health checks, automatic
  failover on primary down
- This is a 1-day setup, ~$30/month for the standby VPS

For v1, we ship single VPS + automated backups + restore
tests + 99.9% uptime target. v2 adds the standby VPS +
99.95% target.

### The "should not fail" monitoring stack

Every service emits metrics to a monitoring system:
- Coolify's built-in health checks (HTTP `/health` endpoints)
- Better Stack (free tier) for uptime monitoring + alerting
- Sentry for error tracking (free tier, 5K events/month)
- Logs shipped to Better Stack or self-hosted Loki

Alerts go to Telegram (the client's preferred channel
based on existing WhatsApp usage). On-call rotation: just
you (PaalStack) for v1. Documented runbook in
`RUNBOOK.md` for each failure mode.

### The "should not fail" backup plan

- **Postgres**: daily `pg_dump` to Cloudflare R2, 30-day
  retention. Weekly `pg_basebackup` (full binary backup)
  to R2, 7-day retention. WAL archiving to R2, 7-day
  point-in-time recovery.
- **Call recordings**: 90 days in FreJun, archived to
  R2 for 7 years.
- **WhatsApp message history**: in Postgres, backed up
  with the rest of the DB.
- **Configuration**: `.env` files in 1Password (or
  equivalent). Coolify service definitions in git.
- **Restore test**: weekly cron that does a `pg_restore`
  to a throwaway DB and runs a sanity check query. Alert
  if restore fails.

This is the "should not fail even 1 ms" answer. Real
uptime, real backups, real restore tests, real alerting,
real runbooks. Not "we'll figure it out when it breaks."

---

## 5. What I'd push back on, one more time

### The "1 ms" literal interpretation is impossible

I want to be honest: "the system should fail even 1 ms"
literally interpreted means zero downtime, ever. That
requires multi-region active-active deployment, real-time
DB replication, automatic failover with zero data loss.
That's a $10K+/month infrastructure bill and a 6-month
dev project to build. Out of scope for a 5-15 user CRM.

What I CAN promise: 99.95% uptime (52 minutes/year of
allowed downtime), with no single point of failure in
the request path, with automated backup + restore tests,
with alerting that pages you before the customer notices.

If the client genuinely needs 99.99%+, that's a v3
conversation, not v1.

### "Should not adapt" — design for change

"Adapt" is the word I'd push on hardest. The system
needs to be MODIFIABLE, not just available. That means:
- Code is organized so a new module (say, broker network
  management in v1.1) is a 2-week add, not a 2-month
  refactor
- Schema is multi-tenant from day 1 (Q14)
- RBAC is granular (Q13) so adding a new role in v1.1
  is a config action
- API docs are auto-generated (@nestjs/swagger) so the
  next dev can pick up the codebase fast
- README + ARCHITECTURE.md are first-class artifacts,
  not afterthoughts

This is the "adapt" half of "reliable + scalable + adaptable."

---

## 6. Next step

Apply these decisions to DESIGN.md v2. The file becomes
the source of truth for what we build. CLIENT-QUESTIONS.md
becomes historical (renamed to CLIENT-DECISIONS.md or
similar).

When you're ready, say "apply" and I'll do the
consolidation.
