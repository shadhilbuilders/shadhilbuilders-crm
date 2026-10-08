// T-VISIT-CLOSE (2026-09-28) - close a lead's open visits when the deal settles.
//
// WHY THIS EXISTS. A `SiteVisit` was closed only by `VisitsService.updateOutcome`,
// which the UI offers while the visit is SCHEDULED/RESCHEDULED. Nothing tied a
// visit's life to its lead's, so a deal that DIED left its open visit behind:
//
//   lead -> LOST / RNR (cancel, dead lead)          -> visit stayed open
//   booking -> APPROVED (the unit is booked)        -> visit stayed open
//   booking -> REJECTED / CANCELLED                 -> visit stayed open
//
// Nothing was broken enough to throw, so the orphan rows just accumulated with a
// `scheduledFor` in the past. They surfaced as work that is not work:
//   - the admin "Visits at risk" card listed settled deals (now filtered by
//     lead state, but the rows were still there);
//   - `GET /api/visits` applies NO lead-state filter, so they render in the
//     visit list and the calendar too;
//   - they consume the list's 100-row LIMIT, pushing live work out;
//   - worst, `updateOutcome` on an orphan would advance the PARENT LEAD from a
//     terminal state (e.g. LOST -> VISITED), which the state machine forbids and
//     the old guard did not catch.
//
// The fix is one shared helper so every caller agrees on what "settled" means,
// rather than each writing its own cascade.
import { type JwtPayload } from '@shadhil/auth';
import { type PrismaClient } from '@shadhil/database';

/** Visit statuses that still represent live, unresolved work. */
export const OPEN_VISIT_STATUSES = ['SCHEDULED', 'RESCHEDULED'] as const;

/**
 * Mark every open visit on a lead CANCELLED, with one audit row each.
 *
 * `reason` is a short machine string recorded in the audit `after` payload
 * (`lead-terminal`, `booking-settled`) so a reader can tell WHY the visit was
 * closed rather than just that it was.
 *
 * Deliberately NOT applied on `WON`: a won deal may still have a handover or
 * site meeting pending, and silently cancelling those would destroy real work.
 * That is the one judgement call in this change - see the scope doc.
 *
 * Runs inside the CALLER's transaction (`tx`), so the visit closure commits with
 * the status change that caused it. A separate transaction could leave a settled
 * deal with open visits if the process died between them.
 *
 * Returns the ids it closed, so callers/tests can assert on the exact effect
 * instead of re-querying.
 */
export async function closeOpenVisitsForLead(
  tx: PrismaClient,
  actor: JwtPayload,
  leadId: string,
  reason: 'lead-terminal' | 'booking-settled' | 'visit-reverted',
): Promise<string[]> {
  const open = await tx.siteVisit.findMany({
    where: { leadId, status: { in: [...OPEN_VISIT_STATUSES] } },
    select: { id: true, status: true, scheduledFor: true, userId: true },
  });
  if (open.length === 0) return [];

  const ids: string[] = [];
  for (const visit of open) {
    await tx.siteVisit.update({
      where: { id: visit.id },
      data: { status: 'CANCELLED' },
    });
    await tx.auditLog.create({
      data: {
        userId: actor.sub,
        organizationId: actor.organizationId,
        action: 'visit.cancel',
        entityType: 'SiteVisit',
        entityId: visit.id,
        before: { status: visit.status },
        after: {
          status: 'CANCELLED',
          leadId,
          // Why, in the log itself - the lead/booking that settled is the
          // context a reader needs to judge whether cancelling was right.
          closedBecause: reason,
          wasScheduledFor: visit.scheduledFor.toISOString(),
          wasAssignedTo: visit.userId,
        },
        reason:
          reason === 'lead-terminal'
            ? 'Lead reached a terminal state; the visit can no longer be conducted'
            : reason === 'visit-reverted'
              ? 'Lead moved back from Visit booked to Visit requested; the booked visit is withdrawn'
              : 'Booking settled (approved or cancelled); the visit is no longer pending',
      },
    });
    ids.push(visit.id);
  }
  return ids;
}
