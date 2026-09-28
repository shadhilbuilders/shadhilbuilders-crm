# Visit lifecycle on a settled deal + token-received validation

Status: SCOPED 2026-09-28. Owner-approved scope below; work items T-VISIT-CLOSE and
T-TOKEN-GATE.

Two findings from the "Visits at risk" report, one of which is a correctness bug in
the money path.

---

## Finding 1 - a booked-out deal leaves orphan visits (T-VISIT-CLOSE)

### What happens today

A `SiteVisit` is closed only by `VisitsService.updateOutcome`, which the calendar
and the visit list offer while the visit is `SCHEDULED`/`RESCHEDULED`. Nothing ties
a visit's life to its lead's. So a deal that dies leaves its open visit behind:

| path | closes the visit? |
|---|---|
| visit outcome `COMPLETED` / `NO_SHOW` / `CANCELLED` | yes (the visit itself) |
| lead → `LOST` / `RNR` (cancel, dead lead) | **no** |
| booking → `APPROVED` (deal is done) | **no** |
| booking → `REJECTED` / `CANCELLED` | **no** |
| `reassign` / `setCoOwner` | **no** (not their concern) |

Confirmed by grep: `CANCELLED` exists in `VisitStatus` and in both state-machine
tables, but **no production code ever writes it**.

### Why it matters (not only cosmetic)

- The admin "Visits at risk" card listed settled deals (fixed by filtering, but the
  rows are still there).
- `GET /api/visits` has **no lead-state filter** (verified), so those rows also
  render in the visit list and the visit calendar. A user reported the same class
  of confusion on the card; the calendar is the same data.
- `VisitsService.updateOutcome` will happily advance the PARENT LEAD when a stale
  visit is completed. On a `LOST` lead, moving it to `VISITED` is a state-machine
  violation that the current guard does not catch (it only checks the visit's own
  status).
- They count toward the 100-row `LIMIT` in the visits list, pushing live work out.

### Scope: close open visits when their lead can no longer need them

**In scope**

1. New hook `closeOpenVisitsForLead(tx, actor, leadId, reason)` - marks every
   `SCHEDULED`/`RESCHEDULED` visit on the lead `CANCELLED`, writes one audit row
   per visit. Single shared helper so every caller agrees.
2. Call it on the two paths where the lead becomes terminal by design:
   - `LeadsService.transition()` → `LOST` / `RNR` (not `WON`, see below)
   - `BookingsService.transition()` → `APPROVED` / `REJECTED` / `CANCELLED`
     (the deal is settled - booked or dead)
3. `VisitsService.updateOutcome` refuses to advance a lead that is already
   terminal (defence in depth; the rows should no longer exist, but a direct
   service call or a race must not corrupt lead state).
4. Tests at each call site + a tamper check.

**Deliberately OUT of scope - needs an owner decision**

- **`WON` does NOT close visits.** A won deal can legitimately still have a
  handover/site meeting pending, and closing those silently would lose real work.
  This is the one judgement call in the scope; flagging it rather than assuming.
- **Booking `TOKEN` does not close visits.** The token is paid but approval is
  still pending, so the deal is live.
- Backfilling existing orphan rows. Production data is not in this repo; a
  one-off script is a separate (easy) task once the write path is correct.
- Auto-advancing a lead from its visits (`NO_SHOW` → lead `NO_SHOW`) is untouched.

---

## Finding 2 - a booking can be marked TOKEN-received with no token (T-TOKEN-GATE)

### The bug (money path)

`PATCH /api/bookings/:id` (`transition` → `TOKEN`) sets `status = 'TOKEN'` and
**never reads or writes `tokenAmount`**. The transition DTO has no `tokenAmount`
field at all. So:

- `HOLD → TOKEN` succeeds with `tokenAmount = NULL` - the booking is recorded as
  token-received with **no amount recorded**, which is unverifiable.
- The admin/overview "Booking money" card derives its meaning from exactly that
  field: `tokenPaid = tokenAmount !== null && Number(tokenAmount) > 0` (verified).
  A NULL token therefore renders as **"HOLD - no token"**, i.e. the card says
  "money still with the customer" for a booking the operator just marked as paid.
- The booking detail page shows `Token amount: -` (`formatMoney` fallback).

So the status and the amount disagree in both directions, and the report that a
booking was marked received without entering a value is reproducible from the API
today - not a UI-only slip.

Note the asymmetry: `CreateBookingDto` ALLOWS `tokenAmount` at creation (the
service persists it while landing in `HOLD`), so the value can exist before the
transition. That is why the rule is conditional, not "always required".

### Scope: `tokenAmount` becomes a first-class part of the HOLD → TOKEN move

**In scope**

1. `BookingTransitionDto` gains `tokenAmount?: number` (positive, capped like
   `CreateBookingDto`), and a `superRefine` rule: **required when
   `toStatus === 'TOKEN'`**, rejected as a validation error on the `tokenAmount`
   field so the form highlights the right control (same pattern as the existing
   `reason` rule).
2. `BookingsService.transition()` - defence in depth, since a direct service call
   or an older client bypasses the DTO: refuse `TOKEN` when the incoming amount is
   absent AND the stored one is null/non-positive. Persist the amount in the same
   update as the status, so the two can never drift.
3. UI: the HOLD → TOKEN confirm step collects a required "Token received" amount
   (prefilled from the stored `tokenAmount` when one exists, so re-confirming
   cannot silently blank it).
4. Tests: API-level (DTO rejects, message lands on `tokenAmount`), service-level
   (the existing stored amount is accepted; a null one is refused; the amount is
   written together with the status), and UI-level. Tamper-checked.
5. A migration is **not** required: `tokenAmount` is already an optional column.

**Deliberately OUT of scope**

- Repairing existing `TOKEN` bookings whose `tokenAmount` is NULL. Same reason as
  the backfill above: production data, needs a separate one-off. Worth listing the
  count first.
- Changing what `TOKEN` means or adding a payment-reference field.

---

## Verification plan

- Unit + DB suites for both areas, run sequentially (the DB suites share one test
  database and must not overlap).
- A tamper check per fix: revert the guard and confirm the specific assertion goes
  red, per the repo's standing rule that a regression test must be able to fail.
- The token rule is additionally exercised through the real HTTP DTO shape, so a
  "fixed in the service only" outcome cannot pass.
- Full gates: api-types, backend, database, web suites, type-check, lint.
- CI cannot run (GitHub Actions billing, since 2026-09-04) - local runs are the
  evidence, and the commit says so.
