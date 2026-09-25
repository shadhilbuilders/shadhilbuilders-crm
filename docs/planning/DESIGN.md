# Shadhil Builders CRM - Application Design Brief (v3)

**Owner:** PaalStack delivery + Product · **Status:** Build-ready (v3.1, Model C handoff), awaiting client sign-off
**Audience:** Shadhil sales leadership + PaalStack engineering
**Source:** Consolidated from v1 (PM-agent brief) + 11 rounds of client feedback, 2026-08-29.
**Out of scope for this doc:** implementation tasks, code, mockups, design review.

This is the single source of truth. The 11 delta files in this
directory are the change log - read them if you want the reasoning
behind any decision.

---

## 1. Primary user roles

| Role | Count | What they do | What they cannot do |
|---|---|---|---|
| **Admin** | 1 | Manages all user accounts (managers, telecallers, sales executives), sees everything across the system, configures WhatsApp + telephony integrations, manages projects and inventory. | Act on leads directly unless also assigned Sales Executive role. Create other Admin accounts (seeded out-of-band by Shadhil leadership). |
| **Manager** | 1+ | Owns a team of telecallers + sales executives. Manages `ManagerAssignmentRule` to auto-route leads to the right exec when a visit is logged. Reviews team pipelines, reads chat threads for their team only, books / initiates bookings. | Cannot create user accounts. Cannot see other managers' teams. Cannot edit system config or projects. Cannot approve bookings (admin/owner only, 2026-09-24). Cannot manually override lead ownership in v1 (v1.1 adds manual reassignment if needed). |
| **Telecaller** | N | First-touch lead owner from "New" through "Visit Scheduled" AND through the visit confirmation (24h + 2h before). Sends WhatsApp messages, logs calls, schedules site visits, confirms visits with customer. After NO_SHOW, reverts to telecaller for re-engagement. | Cannot reassign leads. Cannot see other telecallers' pipelines. Cannot book units. Cannot see chat threads for leads they don't own. Cannot log a visit as VISITED (only the exec can do that - Model C). |
| **Sales Executive** | N | Conducts the site visit and owns the lead from "Visited" through "Won / Lost / Cold." Sends WhatsApp messages, logs calls, logs the visit outcome, handles reschedules, initiates bookings, follows the customer to closing. | Cannot reassign leads. Cannot see other executives' pipelines. Cannot approve their own bookings (admin/owner approves). Cannot see chat threads for leads they don't own. Cannot schedule a visit (only the telecaller does that - Model C). |

---

## 2. Core modules (9 modules)

| # | Module | Purpose | Primary user | Data touched |
|---|---|---|---|---|
| 1 | **Lead Inbox** | Sortable/filterable list, assign/reassign, bulk actions, status filters | Telecaller, Manager, Sales Exec | Lead |
| 2 | **Lead Detail** | Single lead view: contact, timeline, notes, status, next action, embedded chat pane, site visit widget, booking panel | All | Lead, Activity, SiteVisit, Message, Booking |
| 3 | **Site Visit Scheduler** | Calendar slots for sites, agent availability, confirmations, no-show/reschedule outcomes | Manager, Sales Exec | SiteVisit, Lead, User |
| 4 | **Inventory / Unit availability** | Villa grid (project/phase/BHK/facing/price/status) | Manager, Sales Exec, Admin | Unit, Project, Booking |
| 5 | **In-app Chat** | Per-lead chat pane. All customer messages flow through here. Manager reads threads live. SSE realtime updates. | All | Message, Lead |
| 6 | **Booking Pipeline (thin slice)** | Unit hold → token receipt capture → admin/owner approval. NOT agreement generation (deferred to v1.1). | Manager, Sales Exec | Booking, Lead, Unit |
| 7 | **Reminders** | Automated reminders: pre-visit staff, pre-visit customer, reschedule follow-up, no-show. In-app banner + push + email fallback. | All | Reminder, SiteVisit, Lead |
| 8 | **Audit Log** | Every login, every lead view, every state transition, every message, every call, every consent change. 7-year retention. Writes in v1, full UI in v1.1. | (system writes; Admin reads) | AuditLog |
| 9 | **Notification Center** | In-app inbox for all events from all 12 triggers. Bell icon + unread badge. Real-time SSE updates. 90-day visibility, 7-year retention. | All | Notification |

**Cross-cutting infrastructure (not a module):** Push notifications (Expo Push + Web Push), the in-app SSE channels, the backup/restore pipeline, the monitoring stack.

---

## 3. Lead lifecycle state machine (v3.1 - Model C hybrid handoff)

**The handoff is at the VISIT outcome, not at the verbal yes.** Telecaller owns the lead from New through "Visit Scheduled" (and conducts the confirmation work). Sales Exec actually conducts the site visit and takes over ownership after the visit is logged as "visited" or "no-show" reverts to the telecaller.

```
TELECALLER OWNS:
  NEW → CONTACTED → VISIT_REQUESTED → VISIT_SCHEDULED
                                                ↓
                                    (SHARED VISIBILITY WINDOW:
                                     BOTH telecaller and exec see
                                     the lead in their queues during
                                     this state; the exec is the
                                     one who actually conducts the
                                     visit)
                                                ↓
                                ┌───────────────┴───────────────┐
                                ↓                                ↓
SALES EXEC OWNS:                          NO_SHOW → telecaller owns
  VISIT_SCHEDULED → VISITED → NEGOTIATION   again (re-engagement,
                                ↓            reschedule)
                            BOOKING_INITIATED
                                ↓
                            WON | LOST

  (if no-show, lead returns to telecaller)
  NO_SHOW → RESCHEDULED (telecaller owns) | LOST
```

**Why this is the right handoff point (Model C rationale):**

- The telecaller's job is to book + confirm the visit. They
  have skin in the game for the visit actually happening
  (no-shows cost them credit, not the sales exec).
- The sales exec's job is to conduct the visit + close.
  They start the relationship at the visit, with momentum.
- The 30-40% no-show rate (industry baseline) is owned by
  the telecaller (who can be coached/optimized), not by
  the sales exec (who has no control over it).
- The handoff is at a CONCRETE event (the visit outcome),
  not a vague verbal commitment. Cleaner data, cleaner
  audit trail.
- This is the model used by best-in-class Indian real
  estate CRMs (Housing.com, NoBroker, Brigade, Prestige,
  Lodha). If it works for them at 100K+ leads/month, it
  works for Shadhil at 100-500.

**State semantics:**

| State | Owner | Meaning |
|---|---|---|
| `NEW` | Telecaller | Lead created (from landing site webhook, walk-in, or manual). Not yet contacted. |
| `CONTACTED` | Telecaller | First outbound message sent (WhatsApp or call logged). |
| `VISIT_REQUESTED` | Telecaller | Telecaller has asked "would you like to visit?" Customer replied yes. Telecaller now schedules the visit. |
| `VISIT_SCHEDULED` | **Shared (Telecaller + Exec)** | Site visit booked on the calendar. **Telecaller** continues to confirm with customer (24h, 2h reminders fire to the telecaller, not the exec). **Sales Exec** sees the lead in their queue, knows the visit is on their calendar, prepares for it. The exec is the one who actually conducts the visit on the day. |
| `VISITED` | Sales Exec | Customer showed up, outcome logged by exec. Lead officially hands off to exec. |
| `RESCHEDULED` | Sales Exec | Customer asked to reschedule during the visit (e.g., "let me think, can I come back next week?"). Old `SiteVisit` marked RESCHEDULED, new one created with `rescheduledFromId` set. Lead stays with exec. |
| `NO_SHOW` | Telecaller (reverts) | Customer didn't show up. Lead hands BACK to the telecaller for re-engagement and rescheduling. The exec didn't waste time on a no-show. Auto WhatsApp + push to customer + push to telecaller + notification to manager. |
| `COLD` | (review) | 2+ consecutive no-shows. Manager notified. Manager decides: re-engage (back to VISIT_SCHEDULED with telecaller) or `LOST`. |
| `NEGOTIATION` | Sales Exec | Price or terms being discussed. |
| `BOOKING_INITIATED` | Sales Exec | Token payment received. |
| `WON` | (closed) | Agreement signed, booking finalized. |
| `LOST` | (closed) | Customer dropped out, competitor won, or otherwise dead. Required: `lostReason`. |

**Assignment semantics (`Lead.currentOwnerId`):**

- Pre-`VISIT_SCHEDULED`: owner is the telecaller
- `VISIT_SCHEDULED`: lead appears in BOTH queues (shared visibility). The RLS policy allows both the assigned telecaller AND the assigned exec to read it.
- Post-`VISITED`: owner is the exec (`currentOwnerId` = exec's userId)
- Post-`NO_SHOW`: owner reverts to the telecaller (`currentOwnerId` = telecaller's userId) for re-engagement
- Post-`RESCHEDULED` (new visit, after re-engagement): owner returns to the exec when the re-scheduled visit completes

**The `LeadAssignment` table is critical** - it tracks every ownership change with timestamp + reason. The full audit trail for a lead looks like:

```
2026-09-15 10:00:00  →  Telecaller A  (created)
2026-09-15 14:00:00  →  Telecaller A  (VISIT_REQUESTED, no change)
2026-09-15 16:00:00  →  Telecaller A  (VISIT_SCHEDULED, no change)
2026-09-18 11:00:00  →  Sales Exec B  (VISITED, handoff complete)
2026-09-20 09:00:00  →  Sales Exec B  (NEGOTIATION)
2026-09-25 14:00:00  →  Sales Exec B  (BOOKING_INITIATED)
2026-09-28 11:00:00  →  Sales Exec B  (WON)
```

Or, with a no-show:
```
2026-09-15 10:00:00  →  Telecaller A  (created)
2026-09-15 14:00:00  →  Telecaller A  (VISIT_REQUESTED, no change)
2026-09-15 16:00:00  →  Telecaller A  (VISIT_SCHEDULED, no change)
2026-09-18 11:00:00  →  Telecaller A  (NO_SHOW, reverts to telecaller)
2026-09-19 10:00:00  →  Telecaller A  (VISIT_SCHEDULED, reschedule)
2026-09-22 11:00:00  →  Sales Exec B  (VISITED, handoff on second try)
2026-09-25 14:00:00  →  Sales Exec B  (NEGOTIATION)
```

**Handoff is automatic on visit outcome.** No manager gate. The system uses `ManagerAssignmentRule` (configured per project) to auto-pick the right exec when a visit is logged as visited. Empty rule = the exec who was already assigned to the visit (via the SiteVisit.salesExecId field set during VISIT_SCHEDULED).

**Auto-actions:**

- **T-24h and T-2h before visit:** Reminders to CUSTOMER (WhatsApp templates `visit_reminder_24h`, `visit_reminder_2h`) AND to the TELE CALLER (pre-visit staff reminder - the telecaller is the one who confirms with the customer). The sales exec gets a T-1h "your visit is in 1 hour" reminder (so they can prep).
- **2h after `VISIT_SCHEDULED` with no outcome:** WhatsApp template `missed_visit_followup` fires to customer. Push to telecaller + manager. Lead stays in VISIT_SCHEDULED with `noShowPending: true` until the exec logs the outcome OR the telecaller marks no-show.
- **Outcome = VISITED:** Lead auto-hands to exec. Push trigger #4 fires.
- **Outcome = NO_SHOW:** Lead auto-reverts to telecaller. New WhatsApp follow-up to customer. Push to telecaller + manager.
- **2nd consecutive no-show on a lead:** Lead moves to `COLD`. Manager gets notification.

---

## 4. Permission matrix (RBAC) - Model C handoff

| Operation | Super Admin | Admin | Manager | Telecaller | Sales Exec |
|---|---|---|---|---|---|
| Create user accounts | ✅ (any below) | ✅ (below admin) | ✅ (telecaller + exec, own team) | ❌ | ❌ |
| Change user roles | ✅ (anyone, any role) | ✅ (below admin) | ✅ (telecaller + exec, own team) | ❌ | ❌ |
| Create lead / enquiry | ✅ (any team) | ✅ (any team) | ✅ (own team) | ✅ (becomes owner) | ✅ (becomes owner) |
| View any lead | ✅ | ✅ | their team only | own OR shared (VISIT_SCHEDULED) | own OR shared (VISIT_SCHEDULED) |
| Assign telecaller to lead | ✅ | ✅ | ✅ (in team) | ❌ | ❌ |
| Schedule site visit | ✅ (any lead) | ✅ (any lead) | ✅ (in team) | ✅ (own leads) | ❌ (exec conducts, doesn't schedule) |
| Confirm visit with customer (24h, 2h before) | ✅ (any lead) | ✅ (any lead) | ✅ (in team) | ✅ (own leads) | ❌ |
| Log visit outcome (VISITED / NO_SHOW) | ✅ (any lead) | ✅ (any lead) | ✅ (in team - all outcomes) | ✅ (only NO_SHOW - marks as no-show) | ✅ (VISITED, RESCHEDULED, CANCELLED) |
| Re-engage after no-show | ✅ (any lead) | ✅ (any lead) | ✅ (in team) | ✅ (own leads) | ❌ |
| Log activity (call, note, WhatsApp) | ✅ (any lead) | ✅ (any lead) | ✅ (in team) | ✅ (own leads) | ✅ (own leads) |
| Initiate booking | ✅ | ✅ (any lead, post-visit) | ✅ (in team, post-visit) | ❌ | ✅ (post-visit only) |
| Approve booking | ✅ | ✅ | ❌ | ❌ | ❌ |
| Send WhatsApp message to customer | ✅ (any lead) | ✅ (any lead) | ✅ (in team) | ✅ (own leads) | ✅ (own leads) |
| Read chat on a lead | ✅ | ✅ | ✅ (in team) | ✅ (own leads + shared) | ✅ (own leads + shared) |
| View reports (own KPIs) | ✅ (org KPIs) | ✅ (org KPIs) | ✅ (team KPIs) | ✅ (own KPIs) | ✅ (own KPIs) |
| Edit projects / units / inventory | ✅ | ✅ | ❌ | ❌ | ❌ |
| View audit log | ✅ | ✅ | ❌ | ❌ | ❌ |
| Configure integrations (WhatsApp, FreJun, Expo Push) | ✅ | ✅ | ❌ | ❌ | ❌ |

**What the model C RBAC matrix means in practice:**

- **Role model v2 (Round 20, 2026-08-31):** five roles -
  OWNER ⊃ ADMIN ⊃ MANAGER ⊃ {TELECALLER, SALES_EXEC}.
  Exactly ONE OWNER exists (partial unique index
  `one_owner`; created by seed/migration only - the API
  can never create or assign it, not even the owner
  themself). OWNER bootstraps ADMINs and can change any
  role; ADMIN manages everything below admin; MANAGER manages
  staff within their team. Role changes are audited
  (before/after rows in AuditLog). The seeded
  admin@shadhilbuilders.in account IS the owner. (Round 20
  named this role SUPER_ADMIN; Round 21 renamed it OWNER
  - see DECISION-CHANGELOG.)

- **Authority inheritance (client-confirmed 2026-08-31):**
  Admin can do anything a Manager can; a Manager can do
  anything a Telecaller or Sales Exec can. Scope follows the
  actor, not the role: the manager inherits staff *actions*
  only within their own team's leads; the admin inherits them
  across all leads. Role-specific gates that do not flow up:
  the exec-only scheduling block (exec conducts, never
  schedules) and the telecaller-only NO_SHOW logging - those
  stay ❌ for admin/manager because they are role
  *responsibility* boundaries in Model C, not capability
  limits.
- Creation flows: telecaller/exec-created leads start with
  the creator as `ownerId` (ownerType from their role);
  manager-created leads land in the manager's team and get
  assigned; admin-created leads can be assigned to any team.

- A **Telecaller** is responsible for: booking, confirming,
  re-engaging after no-show. They lose credit when a no-show
  happens (visible in their KPI dashboard).
- A **Sales Exec** is responsible for: conducting the visit,
  logging the outcome, doing the closing, sending post-visit
  WhatsApp. They get credit for every booking that comes
  from a lead they visited.
- **Both** can see the lead during `VISIT_SCHEDULED` (shared
  visibility). The exec sees it to prep; the telecaller sees
  it to confirm.
- The **Manager** still owns the assignment rule
  (`ManagerAssignmentRule`) that auto-picks the right exec
  when a visit is logged.

**ABAC layer (fine-grained, per-resource):** Enforced at
Postgres RLS. Attributes checked at query time:
- `user_id` - the actor's ID
- `role` - the actor's role
- `team_id` - which manager's team the actor belongs to
- `project_id` - for multi-project scoping
- `lead.currentOwnerId` - for "own leads only"
- `lead.teamId` - for "team leads only"

**RLS policies (high-level):**

```sql
-- Manager can see leads in their team only (per Q13)
CREATE POLICY lead_manager_select ON lead
  FOR SELECT
  USING (
    current_setting('app.current_user_role') = 'MANAGER'
    AND "teamId" = current_setting('app.current_team_id')::text
  );

-- Sales exec can see leads they own OR leads in VISIT_SCHEDULED
-- (shared visibility during the scheduled window - Model C)
CREATE POLICY lead_exec_select ON lead
  FOR SELECT
  USING (
    current_setting('app.current_user_role') = 'SALES_EXECUTIVE'
    AND (
      "currentOwnerId" = current_setting('app.current_user_id')::text
      OR (
        status = 'VISIT_SCHEDULED'
        AND EXISTS (
          SELECT 1 FROM "siteVisit" sv
          WHERE sv."leadId" = lead.id
          AND sv."salesExecId" = current_setting('app.current_user_id')::text
        )
      )
    )
  );

-- Telecaller can see leads they own OR leads in VISIT_SCHEDULED
-- (shared visibility during the scheduled window - Model C)
CREATE POLICY lead_telecaller_select ON lead
  FOR SELECT
  USING (
    current_setting('app.current_user_role') = 'TELECALLER'
    AND (
      "currentOwnerId" = current_setting('app.current_user_id')::text
      OR (
        status = 'VISIT_SCHEDULED'
        AND EXISTS (
          SELECT 1 FROM "siteVisit" sv
          WHERE sv."leadId" = lead.id
          AND sv."salesExecId" = current_setting('app.current_user_id')::text
        )
      )
    )
  );

-- Admin sees everything
CREATE POLICY lead_admin_select ON lead
  FOR SELECT
  USING (current_setting('app.current_user_role') = 'ADMIN');
```

NestJS request-scoped middleware sets these session variables
per request from the JWT claims. RLS is defense-in-depth: even
a bug in app code can't leak rows across users. The shared
VISIT_SCHEDULED visibility is implemented via the EXISTS
subquery - the telecaller and exec BOTH see the lead during
this window, but the RLS makes it explicit so neither can
see leads they shouldn't.

---

## 5. Key entities and relationships

```
Project (1) ──< Unit
Project (1) ──< Lead
Team (1) ──< User
Team (1) ──< Lead
User (1) ──< Lead (currentOwner, createdBy)
User (1) ──< Session, Account, Verification (better-auth)
User (1) ──< PushSubscription
User (1) ──< PushNotification
User (1) ──< Notification
User (1) ──< AuditLog (actor)
User (1) ──< Reminder (recipient)
Lead (1) ──< LeadAssignment (history of ownership transfers)
Lead (1) ──< SiteVisit
Lead (1) ──< Activity
Lead (1) ──< Message
Lead (1) ──< Booking (0..1) >── (1) Unit
Lead (1) ──< Reminder
SiteVisit (1) ──< Reminder
ManagerAssignmentRule >── (1) User (manager), (1) Project
Notification (0..1) ──< PushNotification (audit log)
```

**Tenant strategy:** Multi-project from day 1. v1 UI gates to
Shadhil Metro Heights only. Adding a future project is a config
action, not a rebuild.

### Prisma schema (full)

**Auth tables (better-auth required):**
- `User` - `id, email, name, emailVerified, image, createdAt, updatedAt, phone, role, teamId, pushSettings`
- `Session` - `id, expiresAt, token, createdAt, ipAddress, userAgent, userId`
- `Account` - `id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt`
- `Verification` - `id, identifier, value, expiresAt, createdAt, updatedAt`

**Business tables (12):**
- `Team` - `id, name, managerId, createdAt`
- `Project` - `id, slug, name, location, createdAt`
- `Unit` - `id, projectId, unitNumber, phase, bhk, facing, sqft, basePrice, status, createdAt`
- `Lead` - `id, projectId, teamId, fullName, phone, email, source, status, currentOwnerId, handoffAt, handoffFromId, handoffToUserId, createdById, createdAt, updatedAt`
- `LeadAssignment` - `id, leadId, fromUserId, toUserId, reason, notes, createdAt`
- `SiteVisit` - `id, leadId, salesExecId, scheduledAt, actualVisitAt, outcome, outcomeNotes, rescheduledFromId, remindersSent, createdAt, updatedAt`
- `Booking` - `id, leadId, unitId, tokenAmount, tokenPaidAt, agreementSignedAt, approvedById, createdAt, updatedAt`
- `Activity` - `id, leadId, userId, type, payload, createdAt`
- `Message` - `id, leadId, senderId, direction, channel, body, externalId, createdAt` - `@@unique([externalId, channel])` for webhook dedup
- `AuditLog` - `id, userId, action, resource, metadata, ipAddress, userAgent, createdAt`
- `ManagerAssignmentRule` - `id, managerId, projectId, territory, priority, active, createdAt`

**Notifications + reminders (3):**
- `Reminder` - `id, type, status, siteVisitId, leadId, recipientUserId, recipientPhone, scheduledFor, firedAt, acknowledgedAt, channel, payload, attempts, lastError, createdAt, updatedAt`
- `PushSubscription` - `id, userId, expoPushToken, platform, deviceName, appVersion, isActive, lastSeenAt, createdAt, updatedAt`
- `PushNotification` - `id, triggerType, triggerRefId, userId, subscriptionId, notificationId, title, body, data, status, sentAt, deliveredAt, clickedAt, failedAt, errorMessage, suppressedByQuietHours, rescheduledFor, expoPushId, createdAt, updatedAt`

**Notification inbox (1):**
- `Notification` - `id, userId, type, category, title, body, icon, deepLink, refType, refId, readAt, dismissedAt, archivedAt, createdAt, updatedAt`

**Total: 19 Prisma models.**

### Enums

- `Role` - `ADMIN | MANAGER | TELECALLER | SALES_EXECUTIVE`
- `LeadStatus` - 13 states (NEW, CONTACTED, VISIT_REQUESTED, VISIT_SCHEDULED, VISITED, RESCHEDULED, NO_SHOW, NEGOTIATION, BOOKING_INITIATED, WON, LOST, COLD, plus the implicit shared visibility of VISIT_SCHEDULED)
- `VisitOutcome` - `SCHEDULED | VISITED | NO_SHOW | CANCELLED | RESCHEDULED`
- `MessageDirection` - `INBOUND | OUTBOUND`
- `MessageChannel` - `WHATSAPP | IN_APP | SMS`
- `UnitStatus` - `AVAILABLE | HOLD | TOKEN | SOLD` (derived - see below)
  - **Derived field (T-INV-SYNC, 2026-09-15).** `Unit.status` is not written by
    application code. A `SECURITY DEFINER` trigger on `Booking`
    (`unit_status_sync_booking`) recomputes it on every booking
    insert/update/delete: `APPROVED → SOLD`, else `TOKEN → TOKEN`, else
    `HOLD → HOLD`, else `AVAILABLE`. At most one `HOLD/TOKEN/APPROVED` booking
    per unit (partial unique index `one_active_booking_per_unit`). The only
    manual override is the off-pipeline mark `AVAILABLE | SOLD`, and the API
    returns 409 when it contradicts a live booking. Before this, the status was
    a hand-maintained duplicate written inside an ADMIN-only RLS policy, so it
    silently failed to update for MANAGER/SALES_EXEC/TELECALLER and the
    inventory grid drifted from the bookings list.
- `ActivityType` - `NOTE | CALL | WHATSAPP | EMAIL | STATUS_CHANGE | ASSIGNMENT | VISIT_OUTCOME`
- `ReminderType` - `PRE_VISIT_STAFF | PRE_VISIT_CUSTOMER | RESCHEDULE_FOLLOWUP | NO_SHOW_STAFF | POST_BOOKING`
- `ReminderStatus` - `SCHEDULED | FIRING | FIRED | ACKNOWLEDGED | CANCELLED | FAILED`
- `ReminderChannel` - `IN_APP | PUSH | EMAIL | WHATSAPP`
- `NotificationCategory` - `LEAD | VISIT | BOOKING | CHAT | SYSTEM`
- `PushStatus` - `PENDING | SENT | DELIVERED | CLICKED | FAILED | CANCELLED`
- `PushPlatform` - `IOS | ANDROID | WEB`

---

## 6. Integration touchpoints

### Landing site → CRM (server-to-server webhook)

- **New:** Replace Google Sheet POST with a webhook from
  `shadhilbuilders.in` to `https://crm.shadhilbuilders.in/api/webhooks/lead-ingest`.
- Google Sheet becomes **read-only archive**.
- Keep Sheet running in parallel for 2 weeks, then cut over.
- Webhook payload: `{ fullName, phone, email, requirement, source, enquiryId }`.
- Auth: HMAC-SHA256 signature in `X-Shadhil-Signature` header.

### WhatsApp Cloud API (NEW separate number for CRM)

- **Per Q0 decision:** Provision a NEW WhatsApp Business number
  for the CRM, separate from the landing site's +91 9025012311.
  Don't inherit the Meta test-number blockers.
- Numbers: TBD (provision fresh India DID, e.g., +91 90250 12344).
- **Send:** Templated messages via existing Meta setup. Both
  sides of the conversation go through the CRM number.
- **Receive:** Webhook to `https://crm-api.shadhilbuilders.in/webhooks/whatsapp`.
  Inbound message → log as `Message` row → push via SSE + push notification + inbox.
- **Templates needed:**
  - `customer_enquiry_confirmation` (existing)
  - `internal_enquiry_notification` (existing)
  - `missed_visit_followup` (new - for no-show 2h reminder to customer)
  - `visit_reminder_24h` (new - customer pre-visit reminder)
  - `visit_reminder_2h` (new - customer pre-visit reminder)
  - **All new templates submitted in week 1 of build for Meta approval.**
  - (Removed: `sales_exec_handoff_intro` - not needed in Model C because the handoff happens at the visit outcome, not at the verbal yes. The exec just shows up to a confirmed visit; no separate intro message needed.)

### Telephony: FreJun

- **Provider:** FreJun, ₹1,149/user/month (~₹5,750-17,250/month
  for 5-15 users). Real cost for 10 users: ~₹15,300/month
  (plan + usage + number).
- **Per Q11 decision:** Recording ON by default for all
  calls. AI transcription ON by default. Both stored in FreJun
  (90 days) then archived to Cloudflare R2 (7 years).
- **Why FreJun over Amazon Connect:** at 5-15 users, Connect
  costs ~4.4× more for the same workload. Connect's advantages
  (Amazon Q AI assist, enterprise compliance, UAE region) are
  real but not needed at Shadhil's current scale.
- **Features:** virtual India number, click-to-call, auto-
  recording, AI call transcription, real-time webhooks.
- **Webhook URL:** `https://crm-api.shadhilbuilders.in/webhooks/frejun`
- **Events:** `call.initiated`, `call.answered`, `call.ended`,
  `recording.ready`, `transcription.ready`

### Push notifications: Expo Push (universal)

- **Per v10 design:** Expo Push is the universal push service
  for iOS (APNs), Android (FCM), and Web (Web Push) - one API,
  one SDK, one payload format.
- **Service worker** for web (Next.js as PWA per Q5).
- **VAPID keys** for web push.
- 12 triggers fire pushes (see §10).

### Email (reminder fallback only)

- **Re-added per v11 design:** Email is OUT for general
  outbound (per v6), but IN as a fallback for reminders when
  push delivery fails. Transactional only, not marketing.

### Google Sheets

- Import historical leads on Day 1.
- Becomes read-only archive after the landing-site webhook cutover.

### Coolify self-host

- Hostinger VPS, 8GB plan, India region (Mumbai).
- Docker Compose: NestJS, Postgres, PgBouncer, Redis, Coolify.
- Coolify handles SSL (Let's Encrypt), backups (daily Postgres
  dump to Backblaze B2 / R2), deploys from Git.

---

## 7. Tech stack (locked v3)

```
Web:           Next.js 16 (App Router) + TypeScript + Tailwind v4
               + @paalstack/react-ui (consume, don't author)
               SAME Next.js app hosts the web UI AND better-auth BFF
Mobile:        Expo (React Native) + Expo Router
BFF:           Next.js Route Handlers hosting better-auth
               (in same apps/web codebase as the UI)
Backend:       NestJS 10 + REST controllers + Prisma
Database:      Postgres 16 in Docker, accessed via PgBouncer
Cache:         Redis 7 in Docker (sessions + SSE fan-out + reminders queue)
Auth:          better-auth in Next.js (BFF) + @better-auth/expo
               for mobile + JWT bridge to NestJS
Realtime:      Server-Sent Events (SSE) from NestJS for chat
               pane, notifications, reminders
State (web):   TanStack Query v5
State (mobile): TanStack Query v5
Push:          Expo Push (iOS + Android) + Web Push (VAPID)
               + email fallback for reminders only
API docs:      @nestjs/swagger (auto-generated OpenAPI)
Messaging:     WhatsApp Cloud API (webhook → NestJS controller)
Telephony:     FreJun (webhook → NestJS controller)
Deploy:        Coolify on Hostinger VPS (8GB, India region)
               + EAS for Expo mobile builds
```

**Why this stack (real-world rationale):**

- **Next.js full-stack is the BFF** for both web and mobile.
  Same app hosts the UI and the auth. No separate auth app.
- **NestJS + REST** for the backend. REST over GraphQL for
  THIS CRM (see v5 delta): TanStack Query + native `fetch`
  work equally well on web and mobile, 80% less codegen
  complexity, free HTTP caching, trivial file uploads in
  v1.1, fast `curl` debugging.
- **Postgres in Docker on Hostinger VPS** via PgBouncer (see
  v8 delta). Full control, India region, ~$30/month.
- **Prisma** (locked in v4) - schema in `packages/database/`,
  generated client shared between web (auth tables) and NestJS
  (business tables). See v8 delta for the data ownership
  rules.
- **better-auth** (not Supabase Auth) - MIT, self-hosted, no
  per-user pricing, has org + admin + API-key plugins.
- **SSE over graphql-ws subscriptions** for the chat realtime
  AND for the notification center AND for the reminder delivery.
  One way (server → client) is enough. Plain HTTP.
- **TanStack Query v5** on both web and mobile. Same hooks,
  same caching.
- **FreJun over Amazon Connect** - 4.4× cheaper for the
  actual workload, mobile-first agent UX, AI transcription
  included.
- **Expo Push** as the universal push service - handles iOS,
  Android, AND web behind one API. Saves 1-2 weeks of
  multi-platform push setup.

### Monorepo structure

```
shadhil-crm/
├── apps/
│   ├── web/              # Next.js 16 (BFF + web UI + notification inbox)
│   ├── mobile/           # Expo (React Native)
│   └── backend/          # NestJS 10 (REST API)
├── packages/
│   ├── database/         # Prisma schema + generated client
│   ├── api-types/        # Re-exports Prisma types + manual request/response types
│   ├── auth-client/      # Shared auth helpers (web + mobile)
│   └── ui-tokens/        # Brand tokens (#001a4c, #62b132, #f8f5ef)
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

### Database architecture (multi-app Prisma pattern, v8)

- ONE Postgres database in Docker, accessed via PgBouncer.
- ONE `schema.prisma` in `packages/database/`.
- ONE generated Prisma Client (custom `output` path:
  `node_modules/.prisma/client`).
- **Data ownership split:**
  - **Next.js BFF writes to auth tables only** (User, Session,
    Account, Verification) via better-auth's Prisma adapter.
  - **NestJS writes to ALL business tables** via REST controllers
    and webhook receivers.
  - **Mobile calls NestJS REST, never touches Prisma directly.**
  - **Next.js server components do NOT query business tables
    directly** - they call the NestJS REST API. (One exception:
    server components may read User to load profile.)
- Migrations run from `apps/backend` (`pnpm prisma migrate dev`).
- **PgBouncer in session pooling mode for v1** (RLS works
  simply with per-request session vars). Switch to transaction
  pooling in v2 when concurrent users exceed ~50.

### Subdomain structure (Option 1, split subdomains)

- BFF: `https://crm.shadhilbuilders.in` (Next.js)
- Backend: `https://crm-api.shadhilbuilders.in` (NestJS)
- Mobile: native, no domain
- Coolify handles both SSL certs (Let's Encrypt) automatically.

---

## 8. Auth flow (BFF + JWT bridge)

### Web (Next.js) login

1. User visits `/login`. Form posts to
   `app/api/auth/sign-in/email/route.ts` (better-auth catch-all).
2. better-auth validates credentials, creates a session row in
   the `session` table.
3. better-auth sets an httpOnly secure cookie.
4. Next.js middleware checks the cookie via `getSessionCookie()`.
5. Server components use `auth.api.getSession({ headers })`.
6. JWT obtained via `auth.api.getJWT()`, cached in memory.
7. TanStack Query adds `Authorization: Bearer <jwt>` to every
   REST call to NestJS.
8. NestJS verifies JWT, extracts claims, sets Postgres session vars.
9. RLS policies filter rows.

### Mobile (Expo) login

1. User opens Expo app, lands on login screen.
2. Form calls `authClient.signIn.email()` from `@better-auth/expo`.
3. better-auth creates a session, returns session token.
4. **@better-auth/expo uses `expo-secure-store`** to persist
   the token (Keychain on iOS, EncryptedSharedPreferences on Android).
5. Mobile reads session, calls `authClient.getJWT()`.
6. TanStack Query adds `Authorization: Bearer <jwt>` to every REST call.
7. NestJS receives, verifies JWT, sets session vars, RLS filters.

### Why this works

- JWT is the contract between BFF and backend. Backend doesn't
  care which client got it.
- better-auth signs JWTs with a secret/keys. NestJS verifies
  with the same secret/keys using `jose`.
- HS256 (symmetric) for v1 self-hosted. Switch to RS256 in v1.1
  for production-grade key rotation.
- JWT payload: `sub` (userId), `role`, `teamId`, `iat`, `exp`.

### better-auth in SAME Next.js app as the web UI

**Not a separate auth app.** Why:
- Next.js server components need `auth.api.getSession({ headers })`
  in the same process. A separate auth app = 50-100ms HTTP call
  per SSR page.
- It's the official pattern (Prisma docs, better-auth docs,
  every production deployment).
- "Separate auth app" = 2× deploys, 2× domains, 2× SSL certs,
  2× env files, 2× Prisma clients. Zero benefit for a 5-15
  user tool.

### CORS (the half-day of work BEFORE any feature code)

- better-auth config has `trustedOrigins: [...]` listing web
  + dev URLs.
- NestJS CORS middleware has the same allowlist.
- Mobile: native, no CORS in production.
- Expo in dev: CORS allowlist includes `http://localhost:8081`
  and LAN IP on BOTH Next.js and NestJS.

---

## 9. Realtime: SSE channels from NestJS

All SSE endpoints follow the same pattern. NestJS exposes
`/leads/:id/stream` (chat), `/notifications/stream` (inbox),
and a per-user reminder stream. The client uses native
`EventSource` (web) or `react-native-sse` (mobile).

### Channels

| Channel | Subscribe URL | Who subscribes | What flows |
|---|---|---|---|
| Chat (per lead) | `GET /leads/:id/stream` | Users with access to that lead | New messages for that lead |
| Notifications (per user) | `GET /notifications/stream` | The user | New notifications, mark-read, mark-all-read |
| Reminders (per user) | `GET /reminders/stream` | The user | Due reminders (for the in-app banner fallback) |

### Redis pub/sub channels (backend)

- `lead:{id}:messages` - chat
- `user:{id}:notifications` - inbox
- `user:{id}:notifications:read` - single mark-read
- `user:{id}:notifications:read-all` - all mark-read
- `user:{id}:reminders` - reminder banner

### Auth on SSE

- JWT in `Authorization: header` for HTTP requests
- JWT in `?token=` query param for SSE (because `EventSource`
  doesn't support custom headers). Same JWT verification on
  NestJS side.

---

## 10. Push notifications (out-of-app alerts)

### Stack: Expo Push as universal push service

- iOS: APNs via Expo
- Android: FCM via Expo
- Web: Web Push (VAPID) via Expo

One API, one payload format, one push token storage.

### 12 staff triggers

| # | Trigger | Recipients | Title | Body |
|---|---|---|---|---|
| 1 | New lead assigned | The assigned telecaller | "New lead: {{name}}" | "{{phone}} · {{source}}" |
| 2 | Lead handed off (manager) | The manager | "Handoff: {{lead.name}}" | "Telecaller {{user.name}} handed off a lead" |
| 3 | Lead handed off (team) | All managers in the team | "Team handoff" | "{{user.name}} handed off a lead to your team" |
| 4 | Lead assigned (exec) | The assigned exec | "New lead for you" | "Manager {{user.name}} assigned a lead" |
| 5 | Pre-visit staff (T-2h) | Sales exec | "Site visit soon" | "{{lead.name}} in 2 hours at {{time}}" |
| 6 | No-show staff (T+2h) | Sales exec + manager | "No-show: {{lead.name}}" | "Visit at {{time}} - no outcome logged" |
| 7 | Customer replied to chat (when staff away) | Lead's current owner | "{{lead.name}} replied" | "{{message preview}}" |
| 8 | Booking awaiting approval | Manager | "Booking: {{lead.name}}" | "{{unit.number}} · ₹{{token.amount}}" |
| 9 | Booking approved/rejected | Sales exec | "Booking approved" or "Booking needs changes" | "{{unit.number}} · {{reason}}" |
| 10 | Customer rescheduled | Sales exec | "Reschedule: {{lead.name}}" | "New time: {{newTime}}" |
| 11 | Mentioned in note/chat | The mentioned user | "{{user.name}} mentioned you" | "{{context}}" |
| 12 | Daily summary 8 AM (opt-in, default off) | Manager + admin | "Yesterday's summary" | "{{n}} new leads, {{m}} visits, {{k}} bookings" |

Triggers 1-10 ship in v1. Triggers 11-12 deferred to v1.1 / opt-in.

### Quiet hours (default 22:00-07:00 local)

- **Reminder triggers** (5, 6, 10): respect quiet hours, defer
  to start of next active window.
- **State-transition triggers** (1, 2, 3, 4, 7, 8, 9): fire
  anyway; user chooses to look.
- **Configurable per user** in Settings.

### Push token storage

`PushSubscription` table - one user can have multiple devices
(phone + tablet + browser). Tokens rotate; backend handles
re-registration. Invalid tokens marked `isActive: false`,
cleaned up after 30 days.

### Delivery confirmation

Poll Expo Push receipts every 5 minutes. Update `PushNotification`
status to `DELIVERED` / `FAILED`. Retry up to 3 times with
exponential backoff, then mark `FAILED` and alert via Telegram.

---

## 11. Notification center (in-app inbox)

### Bell icon + unread badge

- Web: top nav, right side, badge capped at "9+"
- Mobile: tab bar, badge on the tab
- Real-time update via SSE on `user:{id}:notifications` channel
- Unread count cached in Redis (5-min TTL)

### Dropdown panel (web) and full screen (mobile)

- List, newest first
- Filled circle `●` for unread, hollow for read
- Filter tabs: All / Unread / Leads / Visits / Bookings
- Date grouping: Today / Yesterday / This week / Older
- "Mark all as read" button
- "See all" link → `/notifications` full page
- Tap item → marks as read + navigates to deep link
- Empty state: "You're all caught up!" illustration

### Data model

`Notification` table - separate from `PushNotification` audit log.
Mutable state: `readAt`, `dismissedAt`, `archivedAt` (v1.1).

### Retention

- 90-day visibility in the inbox (configurable per user)
- 7-year retention in the database (matches audit log per Q12)

### REST API

- `GET /notifications?filter=unread&limit=20&offset=0`
- `POST /notifications/:id/read` (mark single)
- `POST /notifications/read-all` (mark all)
- `POST /notifications/:id/dismiss` (hide from list)
- `GET /notifications/stream` (SSE for real-time)

### Real-time delivery

All 12 triggers from §10 automatically create a `Notification`
row. The row is published to `user:{id}:notifications` Redis
channel. SSE subscribers receive it. Badge updates live.

---

## 12. Reminders module (4 reminder types)

| Type | When | Who | Channel | Template |
|---|---|---|---|---|
| Pre-visit staff | T-2h before visit | Sales exec | Push + in-app + email fallback | (no template, push content) |
| Pre-visit customer | T-24h + T-2h | Customer | WhatsApp | `visit_reminder_24h`, `visit_reminder_2h` |
| Reschedule follow-up | T+1h after reschedule | Sales exec | Push + in-app | (no template, push content) |
| No-show staff | T+2h after visit, no outcome | Sales exec + manager | Push + in-app | WhatsApp to customer: `missed_visit_followup` |

### Reminder processor (NestJS cron)

```typescript
@Cron('* * * * *')  // every minute
async processDueReminders() {
  const due = await prisma.reminder.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledFor: { lte: new Date() },
    },
    take: 100,
  });
  for (const reminder of due) {
    await this.fireReminder(reminder);
  }
}
```

### Reschedule flow

When a customer reschedules (Type 3 + supporting reminders):

1. New `SiteVisit` created with `rescheduledFromId` set
2. Old `SiteVisit` marked `RESCHEDULED`
3. ALL pending reminders on the old visit are `CANCELLED`
4. THREE new reminders for the new visit:
   - `PRE_VISIT_STAFF` (T-2h before new time)
   - `PRE_VISIT_CUSTOMER` (T-24h before new time)
   - `PRE_VISIT_CUSTOMER` (T-2h before new time)
5. ONE additional `RESCHEDULE_FOLLOWUP` reminder for the staff
   (T+1h after reschedule record time)

### Configuration per user

- Pre-visit staff timing: 15min / 30min / 1h / 2h / 4h (default 2h)
- Quiet hours: 22:00 - 07:00 local (default)
- Channel preference: push > email (default)

---

## 13. Success metrics (30 / 60 / 90 days)

- **Time-to-first-touch:** median minutes between lead created
  and first agent activity. Target: < 30 min by Day 30, < 15 min
  by Day 90.
- **Lead → Site Visit conversion rate:** % of New leads reaching
  Visited within 14 days. Target: +20% relative by Day 60.
- **Visit → Booking conversion rate:** % of Visited leads reaching
  Won. Target tracked weekly.
- **Activity completeness:** % of leads with ≥3 logged activities
  within first 7 days. Target: ≥ 80% by Day 60.
- **Daily active agent use:** agents with ≥5 meaningful actions/day,
  5 days/week. Target: ≥ 4 of 5 agents by Day 30.
- **Exec response time (Model C):** median minutes from
  "VISITED" to sales exec's first post-visit WhatsApp
  message. Target: < 30 min by Day 30, < 15 min by Day 60.
  (Replaces the v3 metric which measured verbal-yes-to-exec
  handoff; Model C makes that metric meaningless because
  there is no manual handoff. This metric measures the exec's
  speed at the new handoff moment - the visit outcome -
  rather than a manager-routing step.)
- **No-show rate (Model C):** % of `VISIT_SCHEDULED` leads
  that end in `NO_SHOW`. **This is the KEY metric for
  Model C.** Target: < 25% by Day 60 (industry baseline
  30-40%, telecaller-skin-in-the-game should reduce
  this). If we hit 20% by Day 90, Model C is working.
- **Reschedule follow-up compliance:** % of reschedules where
  staff acknowledged the follow-up reminder within 30 min.
  Target: ≥ 90% by Day 30.

---

## 14. Reliability design (per CLIENT-DECISIONS.md §4)

### Uptime target: 99.95% (52 min/year)

- v1 single VPS + automated backups + restore tests + monitoring
- v2 adds standby VPS + Cloudflare DNS failover → 99.95%+
- v3 multi-region → 99.99%+

### Failure modes and prevention

| Failure mode | Prevention |
|---|---|
| VPS down | Hostinger SLA 99.9%, Coolify auto-restart, health check 30s |
| Postgres crash | Daily `pg_dump` to R2, WAL archiving, 7-day PITR, weekly restore test |
| Redis crash | AOF persistence, maxmemory `noeviction`, auto-restart |
| App crash | Coolify restart policy (3 retries), health check at `/health` |
| Webhook delivery fail | Exponential backoff retry, dead-letter queue in Redis |
| Disk full | Log rotation, log shipping to R2, recording archive, alert at 70% |
| Meta API rate limit | Token-bucket rate limiter, queue sends, retry on 429 |
| Backup failure | Backup logs to Telegram, weekly restore test alerts |
| Cert expiry | Coolify auto-renews, UptimeRobot expiry monitor |
| Deploy breaks prod | Coolify blue/green, health check before traffic, auto-rollback |

### Backup plan

- **Postgres:** daily `pg_dump` to Cloudflare R2, 30-day retention.
  Weekly `pg_basebackup`, 7-day retention. WAL archiving, 7-day PITR.
- **Call recordings:** 90 days in FreJun, archived to R2 for 7 years.
- **WhatsApp history:** in Postgres, backed up with the rest of the DB.
- **Configuration:** `.env` files in 1Password. Coolify service
  definitions in git.
- **Restore test:** weekly cron restores a backup, runs sanity check.

### Monitoring stack

- Coolify built-in health checks
- Better Stack (free tier) for uptime + alerting
- Sentry (free tier) for error tracking
- Telegram for on-call alerts (matches client's WhatsApp-first comms)

### Documented runbook

`RUNBOOK.md` with one section per failure mode: symptoms, diagnosis,
fix, escalation.

---

## 15. Compliance: RERA + DPDP Act (per Q3)

### RERA Tamil Nadu

- 5-year minimum record retention; 7 years for safety
- Audit log captures: every login, every lead view, every state
  transition, every message sent, every call placed, every
  consent change
- All data exportable per project for RERA inspection

### DPDP Act (India's GDPR-equivalent, effective 2023)

- Consent capture on the landing site lead form AND in the CRM
  when capturing customer PII
- Right-to-erasure workflow: customer requests deletion → Admin
  approves → soft delete + 30-day hard delete job
- Data export: customer can request their data (JSON download
  via Admin)
- Audit log immutable (append-only)

### Storage plan for compliance

- Hot (queryable): last 90 days in Postgres
- Warm: 90 days - 1 year in Postgres (slower queries)
- Cold: 1-7 years in Cloudflare R2 as JSON.gz files

---

## 16. Timeline (13-week plan to v1)

| Week | Focus | Deliverable |
|---|---|---|
| 1 | VPS + Coolify + DNS + SSL. NestJS scaffold. Next.js scaffold. Monorepo setup. `packages/database` skeleton. **Submit 4 new WhatsApp templates to Meta for approval.** | Skeleton monorepo runs locally + on VPS |
| 2 | Postgres schema (Prisma), first migration, all 19 models. RLS policies written. NestJS REST controllers for `User`, `Team`, `Project`. better-auth integrated. | Schema live, RLS proven |
| 3 | better-auth login/logout working on web and mobile. JWT issuance + verification proven end-to-end. RLS test suite. | Auth works on both surfaces |
| 4 | Lead CRUD via REST, Lead Inbox page on web. TanStack Query hooks. Lead state machine + RLS enforcement. Site Visit basic CRUD. | Lead Inbox functional |
| 5 | Chat pane + SSE (NestJS endpoint, Redis pub/sub, client hook). WhatsApp webhook handler. Lead Detail page with embedded chat. | Chat works, WA inbound flows |
| 6 | Site Visit scheduler UI, no-show/reschedule outcomes. FreJun webhook handler. **Model C handoff flow** (exec conducts visit, ownership auto-transitions on outcome). Notification triggers 1-4 + 8-10 wired. | Site visits + handoffs work |
| 7 | Reminders module: schema, cron, 4 types. Notification Center UI on web. Inventory grid, booking slice, audit log writer. | Reminders + Inbox work on web |
| 8 | Notification Center UI on mobile. Push notification setup (Expo Push + VAPID). All 12 triggers wired. Manager handoff flow E2E. | Push + Inbox work on mobile |
| 9 | 4 KPI widgets on manager dashboard. RERA + DPDP compliance workflows. Consent capture + right-to-erasure. | Compliance + dashboard work |
| 10 | Expo mobile app: login + Lead Inbox + Lead Detail. App Store + Play Store submission. | Mobile app submitted |
| 11 | Real WhatsApp + FreJun testing (requires Meta production approval, pending since Aug 27). Bug fixes. | Real integrations working |
| 12 | Deployment to Hostinger via Coolify. Smoke test in production. Monitoring + alerting live. RUNBOOK.md written. | First production deployment |
| 13 | Bug fixes from production usage. Performance tuning. PWA install flow on iOS Safari. Final QA pass. | v1 done, ready for handoff |

**Total: 13 weeks to v1.** This is honest. The original 8-week
estimate was for the "fast" path; the "reusable infra + reliable
+ compliant" path takes 13. v1.1 starts immediately after.

---

## 17. NOT in scope (deferred, with reason)

- **Document Vault full version** - sales team uses Google Drive
  + link in lead notes for v1. Vault adds no measurable value
  until agreement template flow is defined (Q2 deferred to v1.1).
- **Reports beyond 4 KPI widgets** - instrument first, report later.
- **Native mobile app beyond PWA + Expo** - Expo in v1 covers
  App Store / Play Store. iOS-specific polish deferred to v1.1.
- **Tamil UI** - sales team English-comfortable. Defer to v1.2.
- **AI lead scoring** - no validated signal yet. Defer until
  90 days of conversion data exist.
- **Customer / buyer portal** - post-booking tracking lives with
  the sales exec, not in a customer-facing app.
- **Broker / channel-partner network** - out of scope for v1.
- **E-sign integration** - Q2 deferred to v1.1.
- **Per-trigger notification settings** - v1.1 (12 triggers all
  on by default; use Mark all as read / Dismiss for noise control).
- **Notification sound customization** - v1.1.

---

## 18. What already exists (carry forward, do not rebuild)

- `~/workspace/shadhil-projects/landing-page/` - Next.js 16 +
  Tailwind v4 marketing site at shadhilbuilders.in
- Brand tokens (`--color-brand-primary #001a4c`, `--color-brand-
  secondary #62b132`, `--color-surface #f8f5ef`) → `packages/ui-tokens`
- WhatsApp Cloud API integration in `lib/whatsapp.ts` with two
  approved templates (`customer_enquiry_confirmation`,
  `internal_enquiry_notification`)
- Landing-page lead form posts to Google Sheet - becomes the
  read-only archive, not the source of truth
- Existing Shadhil WhatsApp number: +91 9025012311 - STAYS on
  the landing site. CRM gets a NEW separate number (Q0).
- Existing fallback WhatsApp number: +91 94454 50410 - same.
- Hostinger VPS is a new procurement; not previously used for
  PaalStack infra.

---

## 19. What I'd push back on, one more time

1. **Stack is now NestJS + REST on a self-hosted VPS.** This
   is the "reusable infra" choice. Defensible but slower to
   ship than the Supabase + Next.js full-stack option. If at
   week 3 the friction is real, revisit - the data model
   and auth design transfer to the alternative stack with
   ~1 week of rework.

2. **Handoff is at the VISIT outcome, not the verbal yes (Model C).** Removes the perverse incentive that causes 30-40% no-show rates in Indian real estate. Telecaller stays accountable for the visit actually happening. Sales exec starts the closing relationship with momentum. See CLIENT-FEEDBACK-v12 for the full comparison of Models A, B, C, D.

3. **AI transcription is not optional** for the "monitor by
   application" requirement. That's why FreJun over TeleCMI.
   Manager oversight workflow depends on it.

4. **No-show / reschedule / cold states + Reminders module are
   v1, not vNext.** #1 source of lead loss in Indian real-
   estate CRMs.

5. **Coolify is a real product, but you are the on-call.**
   Budget 4-8 hours/month for VPS maintenance, Postgres
   backup verification, Coolify upgrades. If that's not
   realistic for your bandwidth, this stack isn't the right
   pick.

6. **Model C requires Shadhil to adopt a specific process**
   (telecaller books + confirms visit, exec conducts the
   visit, ownership transfers automatically on outcome).
   This is a process change for their sales team. Worth
   confirming with the client that they're willing to
   enforce it.

7. **"1 ms literally" is impossible.** We deliver 99.95%
   uptime (52 min/year) for v1. Multi-region HA for true
   zero-downtime is a v3 conversation.

8. **Customer-side pre-visit reminders are in v1, even though
   you only asked for staff reminders.** Industry data shows
   they halve the no-show rate. The marginal cost is 2
   WhatsApp templates; the value is large.

9. **Notification preferences per trigger are v1.1, not v1.**
   Ship 12 triggers all on by default. Use "Mark all as read"
   for noise control. v1.1 adds per-trigger settings if
   Shadhil complains.

10. **Daily summary push (trigger 12) is opt-in, default off.**
    Some managers love it; others find it annoying.

---

## 20. Decision log (locked decisions, with sources)

| # | Decision | Source |
|---|---|---|
| 1 | Architecture: NestJS + REST on Hostinger VPS via Coolify | v3 |
| 2 | Auth: better-auth in SAME Next.js app (BFF) | v3 (Q0 not relevant, but same-app pattern locked) |
| 3 | API style: REST + TanStack Query (not GraphQL) | v5 |
| 4 | Realtime: SSE from NestJS (chat + notifications + reminders) | v5, v11 |
| 5 | ORM: Prisma in `packages/database/`, multi-app shared client | v4, v8 |
| 6 | Database: Postgres 16 in Docker via PgBouncer (session pooling v1) | v3, v8 |
| 7 | Telephony: FreJun (not Amazon Connect) | v6, v7 |
| 8 | Hosting: Hostinger VPS 8GB plan via Coolify | v3 |
| 9 | Mobile: PWA (web) in v1 + Expo in v1.1 (both ship) | Q5 |
| 10 | Role naming: Manager (not Director) | v2 |
| 11 | Lifecycle: two-stage ownership with VISIT-outcome handoff, shared visibility during VISIT_SCHEDULED (Model C) | v3.1, Q15 |
| 12 | Reminders: 4 types in v1 (pre-visit staff/customer, reschedule follow-up, no-show) | v9 |
| 13 | Push: Expo Push as universal service, 12 triggers | v10 |
| 14 | Notification Center: in-app inbox, 90-day visibility, 7-year retention | v11 |
| 15 | RBAC + ABAC: both from day 1, RLS-enforced | v2 |
| 16 | Subdomain: split (crm + crm-api) | v4 |
| 17 | WhatsApp: NEW separate number for CRM (not landing site) | Q0 |
| 18 | Audit retention: 7 years (RERA upper bound) | Q12 |
| 19 | Manager scope: per-team ONLY; admin is global | Q13 |
| 20 | Sites: Mudichur only in v1 UI, multi-site data model | Q14 |
| 21 | Handoff: at VISIT outcome (not verbal yes); telecaller owns through the visit; reverts on NO_SHOW (Model C) | v3.1 |
| 22 | Call recording + AI transcription: ON by default, 7-year R2 archive | Q11 |
| 23 | Document Vault: vNext (Google Drive link in v1) | Q2 |
| 24 | Tamil UI: vNext (defer to v1.2) | v1 |
| 25 | E-sign: v1.1 | Q2 |
| 26 | Per-trigger notification settings: v1.1 | v11 |
| 27 | Daily summary push: opt-in, default off | v10 |
| 28 | Customer-side pre-visit reminders: IN v1 | v9 |

---

## 21. Where to read more

- `DECISION-CHANGELOG.md` - every decision round, in order
- `WORKFLOW-DIAGRAMS.md` - 6 ELI10 diagrams (system, web auth,
  mobile auth, lifecycle, handoff) - show to Shadhil.
  Diagram 4 regenerated to Model C state machine in v3.1.
  Diagram 6 regenerated to one-step automatic handoff on visit
  outcome (Model C).
- `CLIENT-DECISIONS.md` - the 16 resolved client questions
  + reliability design (Q15 updated to Model C in v3.1)
- `CLIENT-FEEDBACK-2026-08-29.md` through
  `CLIENT-FEEDBACK-v12-2026-08-29.md` - the reasoning trail for
  every decision above. **Numbering note:** the directory has 13
  delta files (R1 + v2–v11 + v12). The file named `v12` is
  internally labeled "Round 15" in its header (it discusses Model
  A/B/C/D comparison). All DESIGN.md references to "v12" for
  Model C rationale point to this file; the round-number
  discrepancy is cosmetic and tracked here for the next doc pass.
- `SIGN-OFF-SUMMARY-v3.1.md` - 1-page executive summary for
  Shadhil promoter + sales leadership + finance lead sign-off.
- `CLIENT-QUESTIONS.md.archived-2026-08-29` - the original
  open questions (now all resolved, kept for audit)
- `REVIEW-OF-DESIGN.md` - PM-mode critique of v3 (the v3.1
  addendum source)
