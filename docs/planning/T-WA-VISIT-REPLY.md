# T-WA-VISIT-REPLY — make "Reply YES / RESCHEDULE" actually do something

Status: BUILT 2026-11-28 (Round 68). The two visit templates can carry their
"Reply YES / RESCHEDULE" copy honestly now - the reply does something. Three
corrections to this plan, all recorded at the end of the file; the biggest is
that §4's "two or more open visits" case cannot occur.

Date: 2026-11-11

---

## 1. The gap, with evidence

The visit templates ask the customer to reply:

- `shadhil_site_visit_followup` — "Are you still interested? Reply YES to chat."
- `shadhil_visit_reminder` — "Reply YES to confirm or RESCHEDULE."

Nothing on the receiving side reads that reply today.

`POST /api/webhooks/whatsapp` → `handleInboundMessage`
(`apps/backend/src/webhooks/webhooks.controller.ts:279`) does exactly four
things: dedupe on `WebhookEvent.externalId`, look up `Lead` by `phoneE164`,
insert a `Message` row (`direction='IN'`, `userId=NULL`), or upsert
`WhatsappUnknownContact` when the number is not a lead. Return.

Consequences, all verified by reading the code, not assumed:

| Expected                      | Actual                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Visit confirmed               | `SiteVisit.status` stays `SCHEDULED`; nothing writes it                                                                     |
| Customer gets an ack          | Inbound path sends nothing at all                                                                                           |
| Someone is told               | Webhook never calls `NotificationsService.emit`, never publishes realtime — no badge, no push                               |
| Lead moves to RESCHEDULED     | `leads.state-machine.ts` only runs from staff/visit writes                                                                  |
| Freeform reply possible after | **This one works** — the inbound IN row opens Meta's 24h window, `threadState` recomputes `lastInboundAt`, composer unlocks |

So the only automatic effect of a customer reply is unlocking the composer for
whoever happens to have that thread open.

## 2. Decision: confirmation is a column, not a sixth VisitStatus

`VisitStatus` = `SCHEDULED | RESCHEDULED | COMPLETED | NO_SHOW | CANCELLED`
(`packages/database/prisma/schema.prisma:112`).

Do **not** add `CONFIRMED`. Reasons:

- Confirmation is orthogonal to lifecycle: a confirmed visit can still complete,
  no-show, or be rescheduled. An enum value forces one to overwrite the other.
- `OPEN_VISIT_STATUSES = ['SCHEDULED']` (`packages/api-types/src/visit-lead-sync.ts:25`)
  is the set of visits that are still "live". A CONFIRMED status would silently
  fall out of it, and `visitFateForLeadState` (`:62`) would need a new case or
  leave confirmed visits unclosed forever.
  Import it from `@shadhil/api-types` only. There is a second, dead copy in
  `apps/backend/src/visits/close-visits-for-lead.ts:28` that reads
  `['SCHEDULED', 'RESCHEDULED']`; nothing imports that file any more (it was
  replaced by `sync-visits-to-lead-state.ts`), so importing it by hand would
  put a rescheduled visit back in the "open" set. Do not touch it in this
  ticket either — deleting dead code is its own commit.
- The UI label map and the visits list filters would need a sixth branch for a
  state that means "still on".

Instead, add two nullable columns to `SiteVisit`:

```prisma
  /// Set when the CUSTOMER acknowledged the visit (WhatsApp reply). Nullable:
  /// most visits are never confirmed by the customer, and absence is not "no".
  confirmedAt DateTime?
  /// How the acknowledgement arrived. Free text for now ('WHATSAPP'),
  /// same shape as AuditLog.reason - no enum until a second channel exists.
  confirmedVia String?
```

Migration (Prisma 7 — `migrate diff --to-schema-datamodel` does not exist):

```bash
cd packages/database
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma --script > prisma/migrations/<ts>_t_wa_visit_reply/migration.sql
```

No new table, so no GRANT/RLS work (§7a of the standing rules does not apply) —
column privileges ride on the table's existing grants, and RLS is row-level.

## 3. Decision: where the interpretation runs

A pure function in `apps/backend/src/whatsapp/`, e.g.
`visit-reply.ts` → `parseVisitReply(body: string): 'CONFIRM' | 'RESCHEDULE' | null`,
with `visit-reply.test.ts` next to it (standing rule 6: pure logic gets its own
file, no Nest/Prisma imports).

Rules:

- normalise: trim, collapse whitespace, uppercase, strip trailing punctuation
  and emoji (`YES!` / `yes` / `Yes 👍` all match)
- `YES`, `Y`, `CONFIRM` → `CONFIRM`
- `RESCHEDULE`, `RESCHED` → `RESCHEDULE`
- anything else → `null` (a sentence like "yes I will come by 5" is **not** a
  match: whole-message match only, never `includes()`. A stray "no" inside a
  sentence must never cancel a visit.)
- v1 deliberately has no `NO` / `CANCEL`. Cancelling a visit from a one-word
  WhatsApp reply is a bigger product decision than this ticket.

Called from `handleInboundMessage`, but **outside** the `withRlsContext`
transaction. Inside it, collect `{ leadId, visitId, intent }` and act after the
tx resolves. Reason: `NotificationsService.emit` opens its own
`withRlsContext` → `$transaction`, and Prisma 7 rejects a nested transaction on
the same client (standing rule 7g). Getting this wrong throws at runtime only
for the messages that matter.

## 4. Decision: which visit a reply is about

Only act when the lead has exactly **one** open visit (`status = 'SCHEDULED'`)
with `scheduledFor >= now`. Three cases:

| Situation                     | Behavior                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly one open future visit | act on it                                                                                                                                         |
| No open visit                 | ignore the keyword; the reply is still a Message (visible in the thread). Do not notify — this is the ordinary "customer replies mid-thread" case |
| Two or more open visits       | **do not guess.** Notify the owner: "customer replied YES but has N open visits — confirm by hand"                                                |

Meta's retry dedupe already prevents the same `wamid` being handled twice.
Additionally, if `confirmedAt` is already set, a second `CONFIRM` is a no-op that
still writes the Message row (never error).

## 5. CONFIRM path

1. `SiteVisit.update` where `id` = matched visit and `confirmedAt IS NULL`:
   set `confirmedAt = now`, `confirmedVia = 'WHATSAPP'` (conditional update, so a
   concurrent staff confirmation wins exactly once).
2. One `AuditLog` row: `action: 'visit.confirm'`, `entityType: 'SiteVisit'`,
   `before: { confirmedAt: null }`, `after: { confirmedAt, confirmedVia }`,
   `reason: 'customer replied YES on WhatsApp'`.
3. Optionally one `Activity` row on the lead (`STATUS_CHANGE`/note) so the
   timeline shows it next to the message. Same shape as the visit-scheduled row.
4. Notify, after the transaction, using the existing audience helper
   `resolveVisitStakeholders` (`apps/backend/src/visits/visit-recipients.ts`) so
   this lands with the same people as "visit scheduled":
   `notifications.emit(sub, { type: 'visit.confirmed', title: '<lead> confirmed the visit', body: '<project/date>', leadId })`.
   Recipient loop with bounded concurrency, as `visit-reminders.service.ts` does.

Lead state is **not** changed: the customer confirming does not move the lead out
of `VISIT_SCHEDULED`.

## 6. RESCHEDULE path

The customer wants a new time; the CRM cannot offer slots over WhatsApp, so this
is a routing action, not an automated one.

1. Move the lead to `RESCHEDULED` through `LeadsService.transitionInTransaction`
   so the state machine's legality check applies — **not** a direct `lead.update`.
   This automatically cascades: `syncVisitsToLeadState` marks the open visit
   `RESCHEDULED` (`visit-lead-sync.ts:81`), which is the existing, tested path.
2. Actor for the transition: the webhook has no JWT. Build a synthetic
   `JwtPayload` — note the real shape is `{ sub, role, organizationId, email,
iat, exp, iss }` (`packages/auth-client/src/jwt.ts:36`), not the four-field
   schema in `packages/api-types/src/auth.ts`, and the audit `reason` strings
   interpolate `actor.email` and `actor.role`. So read the visit's assignee
   (`SiteVisit.userId`) once to get `email` and `organizationId`, and use role
   `TELECALLER` — matching how the webhook already runs as `CRON_SERVICE` for
   RLS. If the state machine rejects the transition (e.g. lead is `WON`),
   log and fall through to notify-only — never throw back at Meta (answer 200).
3. Notify the same stakeholder set with `type: 'visit.reschedule_requested'`, and
   say explicitly that the customer asked to move it and nobody has called yet.
   This is the row that must not be missed; it is the difference between a
   rescheduled visit and a no-show.
4. No `SiteVisit` write of our own — the cascade owns it.

## 7. Files

| File                                                                      | Change                                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/database/prisma/schema.prisma`                                  | two columns on `SiteVisit`                                                                                            |
| `packages/database/prisma/migrations/<ts>_t_wa_visit_reply/migration.sql` | `ALTER TABLE "SiteVisit" ADD COLUMN ...`                                                                              |
| `apps/backend/src/whatsapp/visit-reply.ts` (new)                          | pure parser                                                                                                           |
| `apps/backend/src/whatsapp/visit-reply.test.ts` (new)                     | table-driven cases incl. "yes I will come by 5" → null, "YES!!" → CONFIRM                                             |
| `apps/backend/src/webhooks/webhooks.controller.ts`                        | collect intent in tx, act after; call parser only for `type === 'text'` and known-lead branch                         |
| `apps/backend/src/webhooks/webhooks.controller.test.ts`                   | new cases (below)                                                                                                     |
| `apps/web/src/...` visits surface                                         | show a "confirmed by customer" marker where the visit row renders; keep it a `Badge` (`success`) per standing rule 4b |
| `docs/planning/STATE-MATRIX.md`                                           | record that CONFIRM does not move lead state and RESCHEDULE does                                                      |

## 8. Copy fix (independent, do this first)

**Corrected 2026-11-28: this section was wrong about the mechanism.** Meta
refuses to edit an approved template at all. `POST /{template_id}` with new
components returns 400, code 100, subcode **2388039**: "The status for this
message template can't be changed. You can only delete or add templates." So a
copy fix is a NEW name (`shadhil_visit_reminder_v2`), a resubmission, and a
deletion of the old template - not an in-place edit. The category is unaffected
by the change; the send path just has to name the new template.

The rest of this section is kept for the record:

- `shadhil_site_visit_followup`: "Hi {{1}}, just following up on your site visit for
  {{2}}. Are you still interested? Reply YES and our team will call you."
- `shadhil_visit_reminder`: "Your site visit for {{1}} is on {{2}}. Reply YES and
  our team will confirm, or RESCHEDULE if you need another time."

Still 2 parameters each and still starts and ends on static text.

**Done 2026-11-28, in the account (WABA 1575406993159, verified live):**

    created   shadhil_visit_reminder_v2  UTILITY, en, PENDING review
              "Your site visit for *{{1}}* is on {{2}}. / Just reply YES to
              confirm, or RESCHEDULE if you need a different time."
    deleted   shadhil_visit_reminder      superseded by _v2 (its copy promised
                                          "our team will confirm")
    deleted   shadhil_chat_reply           retired 2026-11-24, no sender
    deleted   shadhil_site_visit_followup  retired, no sender, and its copy
                                          ("are you still interested") is a
                                          sales nudge
    deleted   shadhil_site_update_image    retired, superseded by villa_update_image
    deleted   shadhil_site_update_video    retired, superseded by villa_update_video

Left alone on purpose: 3p_direct_integration_test_template (Meta's own
onboarding test), the landing page's internal_enquiry_notification and
customer_enquiry_confirmation (a different repo sends those), and
shadhil_site_visit_checkin, which is the only visit template actually sent.

The `shadhil_visit_reminder` name is now in RETIRED_TEMPLATE_NAMES, so a queued
row that still names it resolves to _v2 instead of failing 132001.

## 9. Tests (acceptance)

Webhook integration cases, mirroring the existing
`webhooks.controller.test.ts` harness:

1. known lead + one open future visit + `YES` → `confirmedAt` set, one audit row,
   one notification to each stakeholder, response 200
2. same again → second `YES` leaves `confirmedAt` unchanged, no duplicate audit
   or notification
3. known lead + two open visits + `YES` → no visit write, notification says
   ambiguous
4. known lead + no open visit + `YES` → no write, no notification, Message row
   still created
5. `RESCHEDULE` → lead `RESCHEDULED`, visit `RESCHEDULED` via the cascade, audit
   rows from both writes, notification emitted
6. lead already `WON` + `RESCHEDULE` → transition rejected, no throw outward,
   notify-only, webhook still 200
7. unknown number + `YES` → unknown-contact path only, no visit touched
8. `yes I will come by 5` → treated as plain text, no write
9. media message with caption text → parser not invoked (`type !== 'text'`)
10. notify throws → visit write survives, webhook still 200, error logged

Plus the existing suites: `webhooks.controller.test.ts`,
`visits.state-machine.test.ts`, `visits.lead-sync.test.ts`, and the RLS matrix is
untouched (no new table).

## 10. Out of scope

- Booking slots or times offered over WhatsApp (no availability API in the
  templates, and Meta would reject a 5-param body).
- `NO` / cancel semantics.
- Auto-replying to the customer. An ack template would be a third template and a
  third approval; the reply that matters is the staff call, not a robot "ok".
- Wiring `shadhil_site_visit_followup` / `shadhil_visit_reminder` to an actual sender
  (separate gap: nothing enqueues either today, so neither is sent by this app).

---

## Built 2026-11-28, and the three things this plan got wrong

**1. §4's ambiguity case is unreachable.** `SiteVisit_one_open_per_lead` is a
partial unique index on `"leadId" WHERE "status" = 'SCHEDULED'`
(migration `20261009040000_visit_lead_state_backfill`), so a lead can never have
two open visits and "customer replied YES but has N open visits" cannot happen.
The handler reads the single open future visit, or nothing. Not writing the
branch was the honest choice: a defensive path no fixture can reach is a path no
test can hold.

**2. §7's "record it in STATE-MATRIX.md" pointed at the wrong file.**
`docs/planning/STATE-MATRIX.md` is the page x load-state matrix (loading / empty /
error / partial); it has never carried lead-state rules. The decision it was
meant to capture - a CONFIRM leaves the lead at `VISIT_SCHEDULED`, a RESCHEDULE
moves it to `RESCHEDULED` - is recorded in DECISION-CHANGELOG.md (Round 68) and
in the handler's own comment.

**3. A CRON_SERVICE context could not write an audit row at all.** The INSERT
policy allowed it, but any insert that asked for the row back failed 42501:
`RETURNING` is checked against the SELECT policy, and `auditlog_select_admin_or_owner`
admits only ADMIN or the row's own `userId`. Prisma's typed `create()` always
returns the row, so the failure was universal for system actors and had never been
seen because nothing in a cron context had written an audit row before. Fixed by
migration `20261128074500_auditlog_cron_service_read`, mirroring
`lead_select_cron_service`.

**What shipped, file by file**

    packages/database/prisma/schema.prisma                                confirmedAt, confirmedVia
    prisma/migrations/20261128071000_t_wa_visit_reply                     ALTER TABLE, no RLS work
    prisma/migrations/20261128074500_auditlog_cron_service_read           the policy above
    apps/backend/src/whatsapp/visit-reply.ts                              pure parser, 27 cases
    apps/backend/src/webhooks/webhooks.controller.ts                      handleVisitReply + notify
    prisma/migrations/20261128081500_activity_system_actor                nullable actor + insert arm
    prisma/migrations/20261128082000_activity_cron_service_read           SELECT arm (RETURNING)
    apps/backend/src/leads/lead-activity.ts                               recordSystemActivity
    apps/backend/src/webhooks/visit-reply.webhook.test.ts                 8 DB-backed cases
    apps/backend/src/visits/visits.service.ts                             confirmedAt on the list row
    apps/web/src/components/dashboard/TodayVisitsCard.tsx                 Confirmed badge
    apps/web/src/components/shared/LeadVisitPanel.tsx                     Confirmed badge

**The timeline row, and a second RETURNING discovery.** The confirmation and the
reschedule request both write an `Activity` row now, with `userId` NULL to mean
"the system did this, not a person" - the column became nullable in migration
`20261128081500_activity_system_actor`, because the only way to satisfy the
existing insert policies would have been to name a staff member who did not do it.
The insert still failed 42501 after the arm was added, because RETURNING is
checked against the SELECT policy and `activity_select_team` resolves visibility
from a role and a lead relationship a cron actor does not have. Fixed with
`activity_select_cron_service` (`20261128082000`). The same trap as AuditLog
above - a cron-context INSERT that asks for its row back needs a SELECT arm.

**One deliberate omission.** No `NO`/cancel keyword, as §10 says.

**What is verified.** Parser: 27 cases. Webhook: 8 DB-backed cases covering
confirm (stamp, audit row, timeline row, three notifications), the second YES,
no open visit, a sentence, a photo, RESCHEDULE (lead moved, visit cascaded,
timeline row), a terminal lead, and a notification failure. Visits list carries
the stamp. Both badges have their own UI tests. Backend type-check and lint
clean; the full backend suite (126 files, 2293 tests), the database package
(15 files, 311 tests, RLS matrix included) and the web suite (196 files, 2085
tests) are green, and a Nest bootstrap probe resolves `WebhooksController` with
its new dependencies.

**What is not verified.** Nothing has been sent through a real Meta webhook in
production: the reply path is exercised against the database, not against Meta.

**The reminder now sends (2026-11-28, same day).** The cron that was supposed to
prompt the customer was notifying staff only, so the reply path had no prompt in
front of it. `VisitRemindersService.remind` now queues
`shadhil_visit_reminder_v2` to the lead and writes the `Message` row the reply
will land against, inside one transaction, before the staff notification. Three
consequences worth knowing:

- `reminderSentAt` finally means what it says. It used to be stamped while no
  customer message existed anywhere.
- If the queue write fails the claim is released, so the next tick retries the
  whole reminder. Once the CUSTOMER has the message the claim stays even if a
  staff emit fails; sending the customer a second copy would be worse than a
  missed internal notification, and the visit is on the dashboard anyway.
- A lead with no number still gets the staff reminder and the claim is kept, so
  nothing retries forever for a number that will never appear.

`Lead.projectId` is a required column, so the `?? 'your site visit'` fallback in
the check-in path is unreachable and the "for your site visit" sentence I recorded
earlier cannot render. The new reminder passes `the site` in that impossible slot
rather than an empty string.
