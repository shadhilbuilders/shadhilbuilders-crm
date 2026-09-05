# Client Feedback Round 2 - 2026-08-29 (Shadhil CRM)

This is a delta on top of `DESIGN.md` (v1) and `CLIENT-FEEDBACK-2026-08-29.md` (v1.1).
Read those first. This file answers the seven new questions the client raised
and gives my honest opinion on each.

---

## 1. "Focus on WhatsApp chat and calls" - agree, with a scope clarification

v1 brief had 8 modules. Client wants to narrow the in-app messaging focus to
**WhatsApp chat + in-app calls (via cloud telephony)**. The implication:

- **In-app chat = WhatsApp Business API messages**, displayed in a chat pane
  inside the lead detail view. This is the primary messaging surface.
- **In-app calls = Exotel/Tata Tele cloud telephony** with click-to-call +
  recording. Not a separate voice channel - a wrapper around the agent's
  normal phone that the manager can read the call log + recording for.
- **Email** drops out of v1. (It was already deprioritised.) Outbound
  notifications go through WhatsApp only.
- **Manual call logging + click-to-call** (v1 brief default) gets upgraded to
  **click-to-call + auto-log + record** via the cloud number. This costs
  ~₹2,500/month on Exotel Pro.

**One thing to be clear with the client:** the "no personal phone for calls"
rule is fully enforceable for **WhatsApp** (we control the API) and only
**partially enforceable for voice** (we can record via Exotel but cannot
stop an agent from sharing their personal mobile with a customer). My
recommendation: ship WhatsApp + Exotel click-to-call with auto-recording on
by default for the cloud number. The customer-facing rule then becomes
"calls go through the company number, recordings are kept, manager can
audit any call." This is what most Indian real-estate CRMs do.

---

## 2. "If director name doesn't suit, use manager" - TAKE

`Manager` is the right word for this domain. In Indian real estate, "Director"
often means a senior salesperson (a job title), not an operations lead. Use
**Manager** everywhere. Renames:

| Old | New |
|---|---|
| Admin | **Admin** (unchanged) |
| Director | **Manager** |
| Sales Agent (single role) | **Telecaller** + **Sales Executive** (two roles) |
| Marketing (read-only) | (drop - not in v1) |

`DESIGN.md` §1 needs a full rewrite using these names.

---

## 3. Stack: Supabase + Prisma + better-auth - PARTIALLY take

The PaalStack `saas-mvp-architecture` skill already recommends
`Supabase + better-auth + RBAC+ABAC` as the canonical MVP stack. So this is
the right direction. But there's a tradeoff on the ORM.

### 3a. Supabase instead of Neon - TAKE (clearly)

**YES, take this.** Supabase:
- Gives us Postgres + free tier + Mumbai region + dashboard + RLS.
- RLS (Row-Level Security) is the right enforcement layer for ABAC. Neon
  doesn't ship it.
- The paalstack-nextjs-starter has Supabase boilerplate already.
- better-auth's plugin ecosystem assumes Postgres-with-RLS.

### 3b. Prisma instead of Drizzle - PUSH BACK (recommend Drizzle)

**My honest opinion: keep Drizzle. Don't switch to Prisma.** Reasons:

1. **Drizzle is the PaalStack default.** Every other PaalStack project
   uses Drizzle. Switching introduces a new ORM pattern across our
   internal skills and the `@paalstack/react-ui` consumer setup. Cognitive
   cost for the team.
2. **Drizzle is SQL-first and edge-friendly.** Prisma's query engine
   adds 4-8 MB to your bundle and 200-500 ms to cold starts on Vercel.
   For a 5-50-user internal tool that's fine, but it's dead weight.
3. **Drizzle plays nicer with Supabase RLS.** RLS policies use raw SQL
   anyway. Drizzle lets you write the policy SQL directly; Prisma has
   to drop into `$queryRaw` for anything non-trivial.
4. **Prisma is fine if you really want it.** If you have specific
   Prisma experience or there's a tool we need that only Prisma has,
   it's defensible. Otherwise, no good reason to switch.

**Counter-question for you:** is there a specific Prisma feature or
existing skill you want to reuse? If so I'll revise. If it's "I just
know Prisma better" - Drizzle is honestly easier to learn, and the
schema-first migration model is similar.

### 3c. better-auth instead of Supabase Auth - TAKE (clearly)

**YES, take this.** better-auth is:
- MIT, self-hosted, no per-user pricing (Supabase Auth charges per MAU
  past 50K).
- Users live in YOUR database, not Supabase's auth schema. Means you
  can JOIN `user` ↔ `lead` ↔ `team` directly in SQL.
- Has org + admin + API-key plugins out of the box.
- Plays cleanly with Supabase Postgres (you use Supabase for the DB,
  better-auth for the auth layer).

**The mental model:** Supabase = database + storage + RLS.
better-auth = who you are + login sessions. They do different jobs.

### 3d. Final stack for v2

```
Frontend (web):     Next.js 16 + TypeScript + Tailwind v4 + @paalstack/react-ui
Frontend (mobile):  Expo (React Native) + Expo Router - share lib/ with web
Backend:            Next.js 16 Route Handlers (single codebase, modular monolith)
Database:           Supabase (Postgres, Mumbai region, RLS enabled)
ORM:                Drizzle (if you agree) or Prisma (if you insist)
Auth:               better-auth (self-hosted, Supabase-compatible)
Messaging:          WhatsApp Cloud API (existing setup, needs Meta prod approval)
Telephony:          Exotel Pro (click-to-call + recording, ~₹2,500/mo)
Deployment:         Vercel (web) + EAS (Expo mobile builds)
```

---

## 4. "Web + Android + iPhone apps" - recommend Expo + phased

This is a big scope expansion. Three real options:

### Option A: Expo (React Native) - RECOMMENDED

- One codebase for Android + iOS, share business logic with web via a
  `packages/lib` monorepo.
- Free EAS Build tier for personal accounts; team plan ~$99/mo when you
  scale.
- App Store + Play Store review process: 1-2 weeks for first submission.
  Plan for that in your timeline.
- Native features (push notifications, deep links, contacts) work
  out of the box.

### Option B: PWA only - fastest to ship

- "Add to home screen" on both platforms, no App Store review.
- No iOS push notifications (Apple restricts PWA push).
- Reuses 100% of your Next.js codebase.
- Best for "we need this NOW" timelines. Field agents get a home-screen
  icon that opens the same web app.

### Option C: Three separate codebases - DON'T

- Triple the work. Maintenance nightmare. Not worth it for an internal
  tool with 5-50 users.

**My recommendation:** ship **PWA first** (4 weeks, same Next.js codebase
you'd build anyway), then build **Expo app for v1.1** once the field
agents actually use the PWA. If they don't, you saved yourself
$99/month + 4 weeks of work. If they do, you've validated the
workflow before investing in native polish.

If you disagree and want Expo in v1, that's fine - it's the more
"complete" answer. Just be aware of the App Store review hit.

---

## 5. "Can telecaller directly assign to available sales executive?" - NO, with a path to YES in vNext

**My strong recommendation: keep the manager handoff as the default in v1.**

Reasons:

1. **Manager visibility is a stated client requirement.** "Director/manager
   can see all the things" is broken if telecallers route around them.
2. **The "which exec is best" decision is non-trivial.** Territory,
   language, workload, exec's track record with similar leads. A manager
   does this; a telecaller doesn't have the data.
3. **Audit trail.** Manager handoffs create clean audit rows. Telecaller
   self-assign creates noisy ones ("why did this lead go to Exec B?").

**But: design the data model so v1.1 "smart routing" is cheap.**

- `ManagerAssignmentRule` table: `{ manager_id, territory, project_id,
  priority }`. Empty in v1, populated in v1.1.
- When telecaller clicks "Ready for handoff," the system looks up the
  rule and **suggests** a sales exec. Manager can confirm or override.
- v1.1: if the rule is set + manager approves auto-assign, the
  suggestion becomes the assignment with no manager click.

**Net:** telecallers get faster routing (no "wait for manager"
perception), managers keep oversight (they confirm or set the rules).

---

## 6. "Customer no-show or reschedule follow-up" - design into v1

You're right to call this out - it's the #1 source of lead loss in
Indian real-estate CRMs. The site visit needs a real outcome model:

### SiteVisit entity - extended

```
SiteVisit {
  id, leadId, salesExecId,
  scheduledAt           timestamp,
  actualVisitAt         timestamp nullable,
  outcome               enum: scheduled | visited | no_show | cancelled | rescheduled,
  outcomeNotes          text,
  rescheduledFromId     SiteVisit? nullable,   // links to the visit this replaces
  rescheduledToId       SiteVisit? nullable,   // links to the replacement visit
  remindersSent         jsonb,                 // array of { sentAt, channel, templateId }
  createdAt, updatedAt
}
```

### Lead state machine - extended

```
... → Visit Scheduled
       ├── visited → ... → Negotiation
       ├── no_show → Rescheduled (re-enters Visit Scheduled) or Cold
       ├── cancelled (customer said no) → Cold | Lost
       └── rescheduled (one-click) → Visit Scheduled (new visit, old one marked rescheduled)
```

### Auto-actions (in v1)

- **2 hours after a scheduled visit with no outcome logged:** WhatsApp
  template fires: "Hi {{name}}, we missed you at the site today. Would
  you like to reschedule? Reply YES to pick a new time." (Template
  needs Meta approval.)
- **2nd consecutive no-show:** Lead moves to `Cold`. Manager gets a
  notification. Manager decides: re-engage (back to `Visit Scheduled`)
  or `Lost`.
- **Reschedule (customer-initiated):** Sales exec reschedules from
  the lead detail. One click picks a new date. Old visit is marked
  `rescheduled`, new visit is created with `rescheduledFromId` set.
  No state change on the lead.

**Why in v1:** the client mentioned it; the data model is small; the
auto-actions are one WhatsApp template + one cron job. Cheap to add,
expensive to retrofit.

---

## 7. "Both RBAC and ABAC" - take, this is the PaalStack default

The `saas-mvp-architecture` skill is explicit: **always do both layers
from day one.** RBAC alone can't handle workspace isolation, resource
ownership, or plan limits. For Shadhil CRM:

### RBAC (coarse-grained: who can do what operation)

| Operation | Admin | Manager | Telecaller | Sales Exec |
|---|---|---|---|---|
| Create manager account | seed | ❌ | ❌ | ❌ |
| Create telecaller/exec | ✅ | ❌ | ❌ | ❌ |
| View any lead | ✅ | their team | own only | own only |
| Assign telecaller to lead | ✅ | ✅ | ❌ | ❌ |
| Receive handoff | ✅ | ✅ | n/a | n/a |
| Assign exec | ✅ | ✅ | ❌ | ❌ |
| Book a unit | ✅ | ✅ (approve) | ❌ | ✅ (initiate) |
| Read chat on any lead | ✅ | their team | own leads | own leads |
| View reports | ✅ | their team | own KPIs | own KPIs |

### ABAC (fine-grained: who can access THIS specific resource)

Attributes that get checked at query time:
- `user_id` - the actor's ID
- `role` - the actor's role
- `team_id` - which manager's team the actor belongs to
- `project_id` - for multi-project (we only have Shadhil Metro Heights
  in v1 but the data model is multi-project)
- `lead.currentOwnerId` - for "own leads only" rules
- `lead.teamId` - for "their team" rules
- `lead.projectId` - for "this project" rules

### Enforcement: Postgres RLS (Supabase)

Set session variables in middleware:
```sql
SET LOCAL app.current_user_id = '...';
SET LOCAL app.current_user_role = 'manager';
SET LOCAL app.current_team_id = '...';
```

RLS policies on every table filter rows automatically. This is
**defense in depth** - even if the application code has a bug, the
DB refuses to return rows the user shouldn't see.

### better-auth

better-auth handles the "who are you" part: login, sessions, password
reset, MFA (if you want it), account linking. It does NOT handle
"what can you do" - that's our RLS + application-level guards.

**One thing to plan for:** RLS is hard to debug. Budget 2-3 days of
extra eng time to write tests for the RLS policies. The PaalStack
skill flags this as the #1 retrofit pain.

---

## What changes in DESIGN.md when you accept this

§1 Roles: rename Director → Manager, split Sales Agent into Telecaller
+ Sales Executive, drop Marketing.

§2 Modules: 5 modules change. New list:
1. Lead Inbox
2. Lead Detail (with embedded Chat Pane + Site Visit widget)
3. Site Visit Scheduler (with no-show/reschedule outcomes)
4. Inventory / Unit availability
5. In-app Chat (new - replaces WhatsApp/Call activity log)
+ Audit Log (writes in v1, UI in vNext)
+ Thin Booking slice

§3 Lifecycle: rewrite for two-stage ownership + no-show/reschedule
states.

§5 Entities: add `SiteVisit.outcome` and `SiteVisit.rescheduledFromId`,
add `ManagerAssignmentRule` (empty in v1), add `LeadAssignment` history.

§6 Integrations: rewrite to focus on WhatsApp + Exotel. Drop email.
Update landing-site ingestion. Add the Meta production-readiness
blocker prominently.

§7 Stack: Supabase + Drizzle (or Prisma) + better-auth + Expo. Replace
the existing paragraph wholesale.

§8 Metrics: add "Time from handoff to exec first message" and
"No-show rate per sales exec" to the existing 5.

§9 Open questions: keep all 16 from v1.1, add 4 more (mobile push
notification strategy, RLS test plan, Exotel recording retention,
PWA vs Expo decision for v1).
