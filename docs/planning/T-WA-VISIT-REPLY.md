# T-WA-VISIT-REPLY — make "Reply YES / RESCHEDULE" actually do something

Status: planned, not started. Blocks nothing technically, but the two visit
templates should not go live with copy that promises behavior this ticket has
not shipped. Copy fix (§8) can ship alone, today.

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

Editing a template's body in WhatsApp Manager does not change its approval
category or its parameter count, so the following ships with **zero** code
change and removes the false promise immediately:

- `shadhil_site_visit_followup`: "Hi {{1}}, just following up on your site visit for
  {{2}}. Are you still interested? Reply YES and our team will call you."
- `shadhil_visit_reminder`: "Your site visit for {{1}} is on {{2}}. Reply YES and
  our team will confirm, or RESCHEDULE if you need another time."

Still 2 parameters each and still starts and ends on static text, so neither
edit needs a code change. Category is Meta's to advise on, and the operator
accepted Marketing for both (`shadhil_site_visit_followup` and `shadhil_chat_reply`
are Marketing as of 2026-11-11); the consequence is delivery, not approval —
from a Meta test sender a Marketing template is accepted and then dropped, so
expect nothing to arrive until a real sender is registered.
Both are honest whether or not this ticket ships.

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
