# Shadhil CRM — Manual Lead Assignment Model (Design Decision)

**Source:** User request 2026-08-30: "admin/manager assign the lead to sales or telecaller; admin can access all the resources"
**Status:** Locked decisions (4)
**Affects:** DESIGN.md §1 (roles), §3 (state machine), §7 (RLS), §8 (auth/permissions); Implementation Plan §1, §3, §4, §7, §8

---

## Decisions locked

| # | Decision | Choice |
|---|---|---|
| D1 | Admin read scope | **Full read across all teams** (override RLS for support/oversight) |
| D2 | Manual reassign scope | **Cross-role move allowed** (Admin/Manager can move lead telecaller ↔ sales exec) |
| D3 | ManagerAssignmentRule interaction | **Manual reassign bypasses the rule** (rule fires only on NEW leads) |
| D4 | Documentation | **§18 added to implementation plan + this tracker** |

---

## What this changes vs DESIGN.md §1

### Before (DESIGN.md v3.1 §1, lines 18-21)

| Role | Cannot do |
|---|---|
| **Admin** | Act on leads directly unless also assigned Sales Executive role |
| **Manager** | Cannot manually override lead ownership in v1 (v1.1 adds manual reassignment if needed) |
| **Telecaller** | Cannot reassign leads |
| **Sales Executive** | Cannot reassign leads |

### After (v3.2 amendment)

| Role | Can do | Cannot do |
|---|---|---|
| **Admin** | **Reassign any lead to any Telecaller or any Sales Exec** (system-wide); **read every lead across all teams**; override RLS for support | Cannot self-claim ownership (Admin stays Admin — to act on a lead, Admin must also have a Telecaller or Sales Exec role, OR use the system action of assigning to self) |
| **Manager** | **Reassign any lead in their team** to any Telecaller or any Sales Exec in their team; manually reassign between telecaller ↔ exec within team | Cannot reassign leads across teams; cannot see other managers' teams |
| **Telecaller** | (unchanged) | Cannot reassign leads |
| **Sales Executive** | (unchanged) | Cannot reassign leads |

---

## Permission matrix (locked)

| Action | Admin | Manager | Telecaller | Sales Exec |
|---|---|---|---|---|
| View lead | ✅ All leads (cross-team) | ✅ Team leads only | ✅ Own leads only | ✅ Own leads only |
| Edit lead fields | ✅ | ✅ Team leads | ✅ Own leads | ✅ Own leads |
| **Reassign lead to Telecaller** | ✅ Any team | ✅ Team only | ❌ | ❌ |
| **Reassign lead to Sales Exec** | ✅ Any team | ✅ Team only | ❌ | ❌ |
| **Reassign lead cross-role (T↔Exec)** | ✅ Any team | ✅ Team only | ❌ | ❌ |
| View audit log | ✅ All | ✅ Team | ✅ Own actions | ✅ Own actions |
| Configure ManagerAssignmentRule | ❌ (Manager-only) | ✅ Team | ❌ | ❌ |
| Create user accounts | ✅ | ❌ | ❌ | ❌ |

---

## RLS policy changes (Postgres)

**Lead table RLS policies (current design):**
- `lead_select_telecaller`: `owner_id = current_user_id() AND role = 'telecaller'`
- `lead_select_sales_exec`: `owner_id = current_user_id() AND role = 'sales_exec'`
- `lead_select_manager`: `team_id = current_user_team_id() AND role = 'manager'`

**Add (v3.2):**
- `lead_select_admin`: `current_user_role() = 'admin'` — bypasses team/owner checks
- `lead_update_admin`: `current_user_role() = 'admin'` — can update owner_id on any lead
- `lead_update_manager`: `team_id = current_user_team_id() AND current_user_role() = 'manager'` — can update owner_id within team only

**Validation layer (NestJS, not just RLS):**
- Reassign action requires: `target_user.team_id = current_user.team_id` (Manager) OR `current_user.role = 'admin'`
- Reassign action sets `ownerId = target.id`, `ownerType = target.role`, writes to `AuditLog`

---

## API changes

**New endpoint:** `POST /leads/:id/reassign`

```typescript
// apps/backend/src/leads/reassign.controller.ts
@Post(':id/reassign')
@UseGuards(JwtAuthGuard, RolesGuard)
async reassign(
  @Param('id') leadId: string,
  @Body() body: { targetUserId: string; reason: string },
  @CurrentUser() user: JwtPayload,
) {
  // 1. Fetch lead + target user
  // 2. Permission check: Admin OR (Manager AND same team)
  // 3. Update Lead.ownerId, ownerType
  // 4. Audit log entry: WHO reassigned, FROM whom, TO whom, REASON
  // 5. Notification: bell + push to new owner ("You were assigned lead X")
  // 6. Notification: bell + push to old owner ("Lead X reassigned to Y by Z")
  // 7. SSE: publish on user:{newOwner.id}:notifications + user:{oldOwner.id}:notifications
}
```

**Permission response codes:**
- `200` — success
- `403` — permission denied (Manager trying to reassign across teams, or non-Admin/Manager attempting)
- `404` — lead or target user not found
- `422` — invalid state transition (e.g. reassigning a WON lead back to telecaller)

---

## UI changes

### Lead Inbox (web + mobile)

**For Admin/Manager only — new "Reassign" bulk action + per-row action:**

```
┌──────────────────────────────────────────────────────────────┐
│ Lead Inbox                            [+ New] [Bulk ▼] [⋯]   │
├──────────────────────────────────────────────────────────────┤
│ ☐ Name         Status    Source   Last activity     Owner    │
│ ☐ Rajesh K.    NEW       Google   2m ago           Asha T   │
│ ☐ Priya M.     CONTACTED Meta     5m ago           Vikram E  │
│                                                              │
│ [Bulk ▼] → Reassign...                                       │
└──────────────────────────────────────────────────────────────┘
```

**Reassign dialog:**

```
┌─────────────────────────────────────────┐
│ Reassign lead                           │
├─────────────────────────────────────────┤
│ Lead: Rajesh K. (NEW)                   │
│ Current owner: Asha T. (Telecaller)     │
│                                         │
│ Reassign to:                            │
│ ○ Telecaller: [Asha T. ▼]               │
│   → choose from list (filtered to       │
│     Admin: all teams;                   │
│     Manager: own team only)             │
│ ○ Sales exec: [Vikram E. ▼]             │
│                                         │
│ Reason (required):                      │
│ ┌─────────────────────────────────────┐ │
│ │ Sales exec requested handoff early  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel]            [Reassign lead]     │
└─────────────────────────────────────────┘
```

### Mobile (Lead Detail)

**Native context menu on long-press lead row (per Vercel RN skill §15):**
- "Reassign..." (Admin/Manager only — hidden for Telecaller/Sales Exec)
- Opens native modal with same fields as web

### Admin Dashboard (new)

**Admin gets a system-wide view:**

```
┌────────────────────────────────────────────────────────────┐
│ Admin Dashboard                                            │
├────────────────────────────────────────────────────────────┤
│ [Leads by team]  [Users by role]  [Active reminders]  [Audit│
│                                                            │
│ Team Lead Counts:                                          │
│   Sales Team A: 47 leads (12 NEW, 8 VISIT_SCHEDULED)       │
│   Sales Team B: 38 leads (9 NEW, 5 VISIT_SCHEDULED)        │
│                                                            │
│ [View all leads →]                                         │
└────────────────────────────────────────────────────────────┘
```

---

## Notification triggers (new)

**Trigger #13 — Lead manually reassigned** (Admin/Manager assignment actions):

| Recipient | Title | Body |
|---|---|---|
| New owner | "Lead assigned to you" | "{{lead.name}} was assigned to you by {{assigner.name}}. Reason: {{reason}}" |
| Old owner | "Lead reassigned" | "{{lead.name}} was reassigned from you to {{newOwner.name}}" |
| Manager (if reassigner is Admin) | "Lead reassigned by Admin" | "Admin {{name}} reassigned {{lead.name}} to {{newOwner.name}}" |

**Trigger #14 — Cross-team reassign attempted + denied** (security audit):
- Admin gets notification if a Manager tries to reassign across teams and is blocked
- Audit log entry is mandatory

---

## Audit log entries (mandatory)

Every reassign writes a `LeadReassigned` audit entry:

```typescript
{
  userId: adminOrManagerId,
  action: 'LEAD_REASSIGNED',
  entityType: 'Lead',
  entityId: leadId,
  before: { ownerId: oldOwnerId, ownerType: oldOwnerType },
  after: { ownerId: newOwnerId, ownerType: newOwnerType },
  reason: string, // required
  ipAddress: string,
  userAgent: string,
  timestamp: Date,
}
```

Retention: 7 years (RERA upper bound — matches existing audit retention).

---

## State machine interaction

**Manual reassign vs Model C handoff:**

| Action | Trigger | Outcome |
|---|---|---|
| **Model C handoff** (auto) | Visit outcome logged | Ownership transfers per §3 state machine; coOwnerId may set; handoff toast fires |
| **Manual reassign** (Admin/Manager) | User clicks "Reassign..." | Ownership transfers immediately; bypasses ManagerAssignmentRule; reassign toast fires |

These are independent flows. A manual reassign does NOT log a "visit outcome", so Model C handoff still fires when the visit happens later. A lead that was manually reassigned to a sales exec while in NEW state will still get Model C handoff toasts at visit time (because the state machine doesn't care who set the owner — it cares about state transitions).

**Edge case:** Lead in WON state. Reassigning a WON lead to a new owner is unusual but allowed (Admin only). Use case: post-booking customer satisfaction calls get moved to a customer-success exec.

**Edge case:** Lead in COLD state. Reassigning to "re-engage" is the normal flow.

---

## ManagerAssignmentRule interaction

**Per D3: manual reassign bypasses the rule.**

- **NEW lead created:** Fires `ManagerAssignmentRule` → auto-picks Telecaller (rule picks by team + workload).
- **Manual reassign:** Does NOT re-evaluate the rule. Whatever target the Admin/Manager picks wins.
- **Subsequent auto-routing:** If the manually-reassigned lead later hits a state where the rule would fire (e.g. visit outcome triggers Model C), the rule fires for THAT event (not retroactively for the manual reassign).

**Rationale:** The user wants Admin/Manager control to override the rule. If a Manager manually puts a lead on Exec X's plate, that's because Exec X has a relationship with the customer or specific expertise. Forcing the rule to re-pick would defeat the purpose.

---

## Impact on existing 9 modules

| Module | Impact |
|---|---|
| Lead Inbox | Add "Reassign" bulk action + per-row; show owner column prominently |
| Lead Detail | Add "Reassign" action in overflow menu (Admin/Manager only) |
| Chat | When lead ownership changes, both old and new owners see the chat; old owner keeps history read access for audit |
| Site Visit | Visit's `salesExecId` is set on VISIT_SCHEDULED; if lead is later reassigned, visit's exec stays (Model C handoff still fires on outcome) |
| Booking | Bookings inherit lead owner; reassign doesn't break booking flow |
| Reminders | Reminders on lead transfer to new owner (old owner's reminders are cancelled, new owner's created) |
| Notifications | New triggers #13 (manual reassign) + #14 (denied attempt) |
| Audit Log | New `LEAD_REASSIGNED` action type |
| Notification Center | Shows reassign notifications alongside the existing 12 triggers |

---

## Out of scope for this change (still deferred)

- **Bulk reassign with auto-rule application** (e.g. "reassign all NEW leads in Team A per round-robin") — defer to v1.1
- **Auto-rebalance** when a Telecaller is overloaded — defer to v1.1
- **Lead sharing** (multiple owners on one lead simultaneously outside Model C) — defer to v1.1
- **Manager override of Admin reassign** — N/A, Admin is the top of the chain

---

## Build impact (timeline)

**New work to add to Phase 2 (Weeks 3-4):**

| Task | Effort (human / CC) | Week |
|---|---|---|
| Update Lead RLS policies (add admin + manager reassign policies) | 2h / 15min | Week 4 |
| Add `POST /leads/:id/reassign` endpoint | 3h / 30min | Week 4 |
| Add audit log entry type `LEAD_REASSIGNED` | 30min / 5min | Week 4 |
| Add notification triggers #13 + #14 | 1h / 15min | Week 7 |
| Add "Reassign" UI in Lead Inbox (web) | 4h / 1h | Week 4 |
| Add "Reassign" context menu in Lead Detail (web) | 2h / 30min | Week 4 |
| Add "Reassign" native modal in mobile | 3h / 1h | Week 10 |
| Admin Dashboard (cross-team view) | 6h / 2h | Week 9 |
| Permission tests (Manager cannot cross teams, Telecaller cannot reassign, etc.) | 2h / 30min | Week 4 |
| **Total** | **23.5h human / 5h CC** | spread Weeks 4-10 |

**Net change to 13-week timeline:** +0 weeks. All work fits within existing Week 4 (Lead Inbox/Detail) and Week 9 (Manager dashboard) build windows. Mobile work folds into Week 10.

---

**Locked. Ready for implementation. Adding §18 to IMPLEMENTATION-PLAN-v1.md now.**