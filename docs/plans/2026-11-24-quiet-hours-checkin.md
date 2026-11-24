# Quiet hours for the completed-visit check-in

Date: 2026-11-24
Status: built 2026-11-24
Depends on: `b9df85a` (the check-in exists), `362f9fb` (E2E expects it)

## The defect

Marking a visit COMPLETED sends the check-in immediately, from
`VisitsService.updateOutcome`, on the caller's transaction. A visit closed at
22:30 therefore messages the buyer at 22:30. The template is approved as UTILITY,
so Meta will deliver it; nothing in the platform objects. It is simply the wrong
hour to ask somebody how their site visit went.

There is no scheduling column on `OutboundMessage` to defer it. The deferral has
to live on the visit.

## The shape of the fix

Completion records _when the check-in becomes due_, and the existing
visit-reminders cron sends it when that time arrives.

One send path, not two. `updateOutcome` stops talking to the outbox entirely, so
there is no "immediate" branch to keep in step with the deferred one.

### 1. Schema

    ALTER TABLE "SiteVisit" ADD COLUMN "checkinDueAt"   TIMESTAMP(3);
    ALTER TABLE "SiteVisit" ADD COLUMN "checkinQueuedAt" TIMESTAMP(3);

    CREATE INDEX "SiteVisit_checkin_due_idx"
      ON "SiteVisit" ("checkinDueAt")
      WHERE "checkinQueuedAt" IS NULL AND "status" = 'COMPLETED';

`checkinDueAt` is when it may go. `checkinQueuedAt` is the claim: non-null means
this visit has already produced an outbox row, or has been deliberately dropped.
`NULL` on both means nothing is owed, which is also the value every existing
COMPLETED visit gets. No retroactive burst.

No new RLS policies. `site_visit_select_cron_service` and
`site_visit_update_cron_service` already exist from
`20261009050000_visit_reminders`, `message_insert_cron_service` from
`20260905000100_t_e2b_inbound_rls_and_grants`, and `outbound_cron_service_insert`
from the same pair. Column privileges are table-level, so new columns need no
GRANT.

### 2. The rule

    nextCheckinSlot(now) -> now, if 08:00 <= IST clock < 20:00
                         -> the next 08:00 IST, otherwise

A pure function in its own module, taking a `Date` and returning a `Date`, so it
is testable without a clock. IST is a fixed +05:30 offset with no daylight
saving, so the arithmetic is a constant, not a timezone database lookup.

### 3. `updateOutcome`

Replace today's `enqueueVisitCheckin` call with one write:

    checkinDueAt: nextCheckinSlot(now)

The Message row, the outbox row, the `@Optional() OutboundService` injection and
the `RlsTx` cast all come out. The three tests added in `b9df85a` are replaced by
one that asserts the stamp and asserts the outbound stub was never called.

### 4. The sweep

A second branch inside `VisitRemindersService.tick`, after the reminder branch,
called `sweepCheckins(ctx, now)`. It reuses the Redis lock, the lease renewal,
`forEachOrganization`, the per-org batch cap and the per-row error isolation that
are already there and already tested.

Per row, inside one `withRlsContext` as CRON_SERVICE:

1. Claim: `updateMany({ where: { id, checkinQueuedAt: null }, data: { checkinQueuedAt: now } })`.
   A count of zero means another replica won or a previous tick closed it.
2. Read the lead: `phoneE164`, `phone`, `name`, and the project name.
3. No number: log, leave the claim set, write no rows. Nothing is owed to a
   buyer who cannot be reached.
4. Write the `Message` row (`direction: OUT`, `channel: WHATSAPP`,
   `kind: CUSTOMER`, `userId` = the exec who recorded the outcome), then
   `outbound.enqueue(obj, tx)`.
5. On a throw from step 4, release the claim (`checkinQueuedAt: null`) and log.
   The next tick retries. Same contract as the reminder claim.

### 5. Do not send a stale check-in

If `now > checkinDueAt + 48h`, do not send. Stamp the claim and log the skip with
the visit id. "How did your visit go" three days late reads as a machine, and a
row that is never claimed would be scanned on every tick forever.

## Hard calls

- **Up to a minute of delay in hours.** Staff who complete a visit at 11:00 see
  the thread row within 60 seconds rather than instantly. Accepted: it buys a
  single code path, and the alternative keeps two paths whose quiet-hours logic
  must agree forever.
- **08:00-20:00 hard-coded, not per organisation.** A second client with
  different working hours needs an `Organization.checkinWindow` pair of columns
  and a settings control. One client does not justify that yet, and the constant
  is in one function.
- **48-hour cap drops the message.** A check-in the cron could not send for two
  days never arrives. The log line is the only record, so somebody has to read it.
- **`checkinQueuedAt` does double duty** as "sent" and "deliberately dropped".
  A third column to distinguish them is not worth a migration; the log line
  carries the reason.
- **The outbox row failing later does not release the claim.** `enqueue` writing
  the row is the cron's only responsibility; delivery and its retries belong to
  `outbound.cron`. Releasing the claim on a later Meta rejection would queue a
  second message for a delivery the outbox is already retrying.

## Verification

- Unit: `nextCheckinSlot` at 07:59, 08:00, 19:59, 20:00, 20:01 IST and across a
  date rollover; `updateOutcome` stamps and never calls the outbox; sweep sends
  once, is idempotent on a second tick, releases the claim on an enqueue throw,
  skips a stale row, and skips a lead with no number.
- `hermes verify --skip-start --phase build --phase test --json`.
- Live, after deploy: complete a visit after 20:00 IST and confirm no outbox row
  until 09:00 IST the next morning, with `checkinDueAt` set to that minute.
  Then complete one at 11:00 and confirm the row appears within a minute.

## What this deliberately does not do

- It does not defer any other message. The welcome template and the site-update
  batch still go the moment staff trigger them. If quiet hours matter for those
  too, they need the same treatment, and the natural move at that point is a
  shared helper rather than a third copy of the rule.

## Built, and the two things the plan got wrong

1. **The Message row cannot be written with a typed `create()`.** `Message` has an
   INSERT policy for CRON_SERVICE but no SELECT arm, and Prisma appends a
   read-back to every insert, so `message.create()` fails with 42501. The row is
   written with `$executeRawUnsafe` and no RETURNING, which is also how the
   inbound webhook writes its rows. The id is `visit_checkin_<visitId>` so a
   retried transaction collides on the primary key instead of writing a second
   row.
2. **The E2E step now waits up to two minutes.** BONUS used to assert the thread
   entry appeared immediately; the entry is now written by the cron, so the spec
   waits for the tick instead of racing it.

The plan claimed no new RLS policies were needed. That was true for `SiteVisit`
and `OutboundMessage` and false for reading a `Message` back as CRON_SERVICE,
which is why the insert had to avoid the read-back rather than widen the policy.
