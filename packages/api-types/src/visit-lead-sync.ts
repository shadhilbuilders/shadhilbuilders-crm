// ────────────────────────────────────────────────────────────────────────────
// Lead state <-> visit status sync - THE single source of truth.
// ────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS (2026-10-09).
//
// A lead could be moved by hand VISIT_SCHEDULED -> VISITED -> ... -> WON while
// its SiteVisit stayed SCHEDULED forever. The visit then kept appearing in
// "Today's visits", the visits calendar and the dashboard counts of a deal that
// was already closed. The two records had no shared rule, so each writer (lead
// transition, booking sync, visit outcome) did its own thing or nothing.
//
// This module states the rule once. It is pure (no Nest, no Prisma, no React) so
// the backend cascade, the migration backfill's SQL mirror and the UI can all
// agree on it, and so it is testable in milliseconds.

/**
 * Visit statuses that are LIVE work.
 *
 * Only `SCHEDULED`. `RESCHEDULED` is NOT open: `VisitsService.reschedule` marks
 * the OLD row `RESCHEDULED` and creates a NEW `SCHEDULED` row, so a RESCHEDULED
 * row is a replaced appointment, never a pending one. Treating it as open made
 * every reschedule look like a duplicate.
 */
export const OPEN_VISIT_STATUSES = ['SCHEDULED'] as const;

/** True when a visit is live work (still to be conducted). */
export function isOpenVisitStatus(status: string | null | undefined): boolean {
  return (
    typeof status === 'string' &&
    (OPEN_VISIT_STATUSES as readonly string[]).includes(status)
  );
}

/** What an open visit becomes when its lead's state changes. */
export type VisitFate = {
  status: 'COMPLETED' | 'CANCELLED' | 'RESCHEDULED' | 'NO_SHOW';
  /** Short machine string recorded in the audit row, so a reader can see WHY. */
  reason:
    | 'lead-visited'
    | 'lead-advanced'
    | 'lead-terminal'
    | 'visit-reverted'
    | 'lead-rescheduled'
    | 'lead-no-show';
};

/**
 * Decide what an OPEN visit becomes once its lead is in `leadState`.
 * Returns `null` when the lead state says nothing about the visit.
 *
 * Only `VISITED` proves the customer came. For the deal states
 * (`NEGOTIATION`, `BOOKING_INITIATED`, `WON`) a lead can advance without the
 * visit happening (a booking taken over the phone), so marking a FUTURE visit
 * `COMPLETED` would manufacture attendance. The slot's clock decides instead:
 * already passed -> COMPLETED, still ahead -> CANCELLED (no longer needed).
 *
 * `LOST`/`RNR` are dead deals: cancel. A lead backed out to `VISIT_REQUESTED`
 * is asking for a NEW visit, so the booked one is withdrawn. `RESCHEDULED` and
 * `NO_SHOW` lead states mirror onto the visit so the two records agree.
 */
export function visitFateForLeadState(
  leadState: string | null | undefined,
  scheduledFor: Date,
  now: Date = new Date(),
): VisitFate | null {
  switch (leadState) {
    case 'VISITED':
      return { status: 'COMPLETED', reason: 'lead-visited' };
    case 'NEGOTIATION':
    case 'BOOKING_INITIATED':
    case 'WON':
      return scheduledFor.getTime() <= now.getTime()
        ? { status: 'COMPLETED', reason: 'lead-advanced' }
        : { status: 'CANCELLED', reason: 'lead-advanced' };
    case 'LOST':
    case 'RNR':
      return { status: 'CANCELLED', reason: 'lead-terminal' };
    case 'VISIT_REQUESTED':
      return { status: 'CANCELLED', reason: 'visit-reverted' };
    case 'RESCHEDULED':
      return { status: 'RESCHEDULED', reason: 'lead-rescheduled' };
    case 'NO_SHOW':
      return { status: 'NO_SHOW', reason: 'lead-no-show' };
    default:
      return null;
  }
}
