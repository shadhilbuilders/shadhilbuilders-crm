# Client Feedback Delta — 2026-08-29 (Shadhil CRM)

This file captures the gap between the v1 brief in `DESIGN.md` (delegated to
Product Manager specialist, saved 19:41 UTC) and the client's verbal
expectations shared later the same evening. **It is a delta, not a replacement
for DESIGN.md.** Decide each item, then update DESIGN.md to match.

The client's message (paraphrased and structured):

- One **admin**, who controls directors.
- Multiple **directors**, who control telecallers.
- One director handles many telecallers + many sales executives. Director assigns
  telecallers to enquiries.
- Lifecycle: customer agrees to visit → telecaller hands the lead to a director
  → director hands it to a sales executive → sales executive follows the customer
  to the end.
- Client wants a **chat interface** that starts once the telecaller hands the
  lead to the director. Every action shows in the chat interface. After the
  director assigns the lead to a sales executive, the telecaller calls the
  customer to share the sales-executive's number; the sales executive takes
  over from there.
- Everyone uses the in-app chat and call. Telecallers and sales executives
  must NOT use their own phone for calls or chat. They may use the company
  business WhatsApp, but every conversation between customer and
  telecaller/sales executive is monitored by the director.
- Admin sees everything.
- Admin can create usernames and passwords for telecallers and executives.

---

## What's wrong / missing in DESIGN.md (must fix)

### 1. Roles are wrong — three changes, not one

DESIGN.md §1 lists 4 roles: Sales Agent, Sales Manager, Admin, Marketing.
The client has 4 too, but they map differently and the internal mechanics differ.

| My draft v1 | Client's actual | What changes |
|---|---|---|
| Sales Agent (one role, owns lead end-to-end) | **Telecaller** (first touch → customer agrees to visit) AND **Sales Executive** (visit → booking) | Two distinct roles. Lead ownership TRANSFERS between them at a hard gate. |
| Sales Manager (approves bookings, reassigns leads) | **Director** (handles many telecallers + executives, sees their pipelines, performs the handoff, monitors all conversations) | Same idea, but Director also reads every chat thread for their reports. Stronger monitoring role than my "Sales Manager." |
| Admin (manages users) | **Admin** (one person — single super-user; manages directors, creates telecaller + executive accounts) | "One" is explicit. Admin does NOT create director accounts. Director accounts are presumably seeded by Shadhil leadership. |
| Marketing (read-only) | (not mentioned) | Either drop, or confirm with client. My guess: not in v1. |

**Action:** rewrite §1. Add a fifth implicit role: **Director**'s read-only
"Admin-lite" oversight is not in scope because Admin already sees everything
(see §6 below).

### 2. Lead lifecycle has a hard handover gate — single-assign is wrong

DESIGN.md §3 has a single state machine with one implicit owner at every
state. The client's flow is a **two-stage ownership model**:

```
Telecaller owns:
  New → Contacted → Visit Requested → (CUSTOMER AGREED TO VISIT) → Handoff to Director

Director owns (briefly, just to route):
  Handoff Received → Assigned to Sales Executive

Sales Executive owns:
  Assigned → Visit Scheduled → Visited → Negotiation → Booking → Won | Lost
```

The "CUSTOMER AGREED TO VISIT" gate is the moment the telecaller hands the
lead to a director. Before that gate, the telecaller owns the lead. After,
ownership moves twice more. This is materially different from a single-owner
pipeline.

**Action:** rewrite §3. New state machine needs three ownership fields on
`Lead` (or a `LeadAssignment` history table — see §3 below) and a
`handoffAt` timestamp that triggers the "telecaller calls customer with the
executive's number" workflow.

### 3. The chat interface is a first-class MVP module, not an activity log

DESIGN.md §2 has "WhatsApp / Call activity log" as one of 8 modules. The
client wants a **chat pane** in the lead detail view — a real messaging UI
where every send/receive with the customer is captured inline, and the
director can passively read every thread. This is structurally different from
"log calls after the fact."

What it means for MVP:
- **Add a new module: In-app Chat** (per-lead, per-thread; sends through the
  WhatsApp Business API; receives via webhook; shows full message history
  with timestamps; visible to director in real time).
- **WhatsApp / Call activity log** is no longer enough on its own. The chat
  pane IS the activity log for messaging. Manual call logging stays
  (click-to-call + post-call note).
- **Compliance:** "everyone uses the app" + "no personal phone" means we
  need click-to-call deep links AND we need a way to prevent agents from
  sidestepping the app. The latter is a process issue (manager discipline +
  spot audits), not a code issue — call recording is not technically
  enforceable on personal mobile networks.

**Action:** rewrite §2. Move "In-app Chat" into the MVP module list, drop
the "WhatsApp / Call activity log" module, and absorb the log into the
chat pane + a small "Calls" sub-tab.

### 4. Permission matrix is missing — and now non-trivial

DESIGN.md never spelled out role-by-role permissions explicitly (the brief
proxies it via the "Cannot" clauses in §1). With four roles and two
handoffs, the matrix matters. Here's what I infer — needs client sign-off:

| Action | Admin | Director | Telecaller | Sales Exec |
|---|---|---|---|---|
| Create director account | seed (out of app) | — | — | — |
| Create telecaller / exec account | ✅ | ❌ | ❌ | ❌ |
| View any lead | ✅ | their reports only | own only | own only |
| Assign telecaller to lead | ✅ | ✅ | ❌ | ❌ |
| Receive handoff from telecaller | ✅ | ✅ (in their team) | n/a | n/a |
| Assign exec from director's pool | ✅ | ✅ | ❌ | ❌ |
| Book a unit | ✅ | ✅ (must approve) | ❌ | ✅ (initiates) |
| Read chat on any lead | ✅ | their team | own leads | own leads |
| View reports | ✅ | their team | own KPIs | own KPIs |

**Action:** add §11 "Permission Matrix" to DESIGN.md.

### 5. Two integration gaps the brief underestimated

- **Phone calls (not WhatsApp):** "no personal phone for calls" is
  partially enforceable. Cloud telephony (Exotel / Tata Tele / Knowlarity)
  gives click-to-call + recording on a virtual number routed to the agent's
  mobile. The customer's outbound calls go to the virtual number; the
  agent's mobile receives them through the Exotel app. Recording is
  possible. v1 was "manual call logging" — the client is now saying
  "click-to-call + log + ideally record." This **promotes telephony from
  defer to must-have in MVP**. Cost: ₹0–₹5,000/month for an Exotel Pro plan
  for a single virtual number.
- **WhatsApp Business onboarding blocker (already known):** the existing
  WhatsApp setup on the landing site is still on the Meta test number, the
  app dashboard has no WhatsApp product yet, and templates are not approved
  for production. **This is a real shipping risk** for the chat pane — if
  the WhatsApp number can't receive customer-initiated conversations, the
  "in-app chat" has nothing to display for inbound. Confirm with the
  client whether they have a separate approved production WhatsApp number
  we should use, OR whether they're okay with the Meta test number for the
  pilot.

**Action:** update §6. Add Exotel/Tata Tele/Knowlarity to must-have
integrations (decide vendor with client). Surface the WhatsApp production-
readiness question to the client.

### 6. "Admin can see all the things" — confirm and add audit

The client explicitly said admin sees everything across directors. This is
trivially true if directors only see their own team's data and admin has
a "view as any director" mode. Worth adding: **immutable audit log** for
compliance — every login, every lead view, every state transition, every
message sent. RERA (Tamil Nadu) will require it. v1 should at least write
audit rows; surfacing them can wait.

**Action:** add an Audit Log row to §2. Pin it as must-have in v1 (writes
are cheap; surfacing is what gets deferred).

---

## What's correct in DESIGN.md (keep)

- §4 MVP module list shape (5 modules + thin Booking) is still right — just
  swap "WhatsApp/Call activity log" for "In-app Chat" and add "Audit Log."
- §5 multi-tenant data model and entities. Add a `LeadAssignment` table
  (or `assignmentHistory` jsonb column) to track ownership transitions.
- §7 stack recommendation — Next.js 16 + Drizzle + Neon + Vercel — still
  correct. The chat pane adds no stack change.
- §8 success metrics — still valid; "time-to-first-touch" now means
  "time-to-first-telecaller-touch" (lead created → first outbound message
  from assigned telecaller), and we add one new metric: "time from
  customer-agreed-to-visit to sales executive first message" (handoff
  latency).

---

## What I recommend

Six concrete changes before we touch DESIGN.md again:

1. **Rewrite §1 (Roles) and §3 (Lifecycle)** to match the client's
   telecaller → director → sales executive flow. This is non-negotiable
   because the data model and permissions both depend on it.
2. **Add "In-app Chat" to §2** as an MVP module. Drop "WhatsApp / Call
   activity log" — it's subsumed. The chat pane IS the log for messages.
3. **Promote cloud telephony (Exotel/Tata Tele) to MVP.** Manual call
   logging no longer fits "no personal phone for calls." Recommend Exotel
   Pro (~₹2,500/month for one virtual number + click-to-call + recording).
4. **Add a §11 Permission Matrix** to the brief.
5. **Add Audit Log writes to MVP** (defer the audit UI).
6. **Update §6 with the WhatsApp production-readiness question** AND
   add it to `CLIENT-QUESTIONS.md` as a Q0 (blocker before any chat work
   can start).

And one risk I want to flag clearly: **the "no personal phone" rule is
realistic for WhatsApp (we control the API), only partially enforceable for
voice (we can route through Exotel, but we can't stop an agent from sharing
their personal number with a customer).** Surface this to the client — it
might change their mind about v1 scope, or it might just be an HR/process
issue they accept.

---

## Open questions for the client (additions to CLIENT-QUESTIONS.md)

- **Q0 (blocker).** Is the WhatsApp Business number for the CRM the SAME
  one currently used on the landing site (+91 9025012311), or do you have
  a separate production-approved number we should use? If same — what's
  the status of Meta template approval and WABA assignment?
- **Q9.** Director account creation: who does it? The admin user in this
  app, or does Shadhil leadership seed them out-of-band? My recommendation:
  admin creates them too, but the first director is seeded by you.
- **Q10.** Confirm cloud telephony: Exotel, Tata Tele, Knowlarity, or
  other? If "we have no telephony provider," we need to pick one and add
  ~₹2,500/month to the ops budget.
- **Q11.** For the "no personal phone" rule on voice calls: do you want
  call recording on the cloud telephony (Exotel supports it), or just
  call logging? Recording is helpful for director oversight but adds
  compliance overhead.
- **Q12.** Audit log retention period? RERA typically requires 5–7 years
  for transaction records. Confirm.
- **Q13.** "Director sees all conversations" — across ALL directors, or
  only within their team? My matrix above assumes "their reports only,"
  but the client's "admin can see all" is clear; directors may also be
  global. Confirm.
- **Q14.** Site visit happens at Mudichur (Tambaram). Are there other
  sites in v1 (e.g., AKM Garden, future projects) or is Shadhil Metro
  Heights the only site to schedule against? Affects the Site Visit
  Scheduler data model.
- **Q15.** "Once customer agrees to visit" — is this a button the
  telecaller clicks ("Customer agreed to visit" → triggers handoff), or
  does the director have to confirm the customer's intent? My model
  assumes a one-click handoff from telecaller.
