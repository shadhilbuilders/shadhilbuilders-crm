// T-VISIT-LEAD-SYNC (2026-10-09) - keep a lead's open visits in step with its state.
//
// Replaces `close-visits-for-lead.ts`, which only ran for dead leads (LOST/RNR)
// and a revert to VISIT_REQUESTED. A lead moved by hand VISIT_SCHEDULED ->
// VISITED -> ... -> WON left its visit SCHEDULED forever, so a closed deal kept
// showing in Today's visits, the calendar and the dashboard counts.
//
// The rule lives in `@shadhil/api-types` (`visitFateForLeadState`) so the UI, the
// migration backfill and this cascade cannot drift apart. This helper only
// applies it: every OPEN visit (SCHEDULED) on the lead gets the status the rule
// names, with one audit row each, inside the CALLER's transaction so the visit
// change commits with the lead change that caused it.
//
// Every writer of `Lead.state` must call this after the write:
//   - LeadsService.applyTransition (covers visit-outcome driven moves too, since
//     VisitsService routes them through transitionInTransaction)
//   - BookingsService.syncLeadState (a booking can move the lead on its own)
import { ConflictException } from '@nestjs/common';
import { visitFateForLeadState, OPEN_VISIT_STATUSES } from '@shadhil/api-types';
import { type JwtPayload } from '@shadhil/auth';
import { type PrismaClient } from '@shadhil/database';

/** Visit rows this call changed, so callers/tests can assert the exact effect. */
export type SyncedVisit = {
  id: string;
  from: 'SCHEDULED';
  to: 'COMPLETED' | 'CANCELLED' | 'RESCHEDULED' | 'NO_SHOW';
  reason: string;
};

const REASON_TEXT: Record<string, string> = {
  'lead-visited': 'Lead moved to Visited; the visit took place',
  'lead-advanced':
    'Lead advanced past the visit stage; the visit is closed to match',
  'lead-terminal': 'Lead reached a terminal state; the visit can no longer be conducted',
  'visit-reverted':
    'Lead moved back from Visit booked to Visit requested; the booked visit is withdrawn',
  'lead-rescheduled': 'Lead moved to Rescheduled; the visit is marked rescheduled',
  'lead-no-show': 'Lead moved to No-show; the visit is marked no-show',
};

/**
 * Apply the lead-state -> visit-fate rule to every open visit on `leadId`.
 *
 * Throws `ConflictException` if a visit it just read cannot be updated: RLS can
 * hide or protect a row from this actor, and silently leaving it open is exactly
 * how the stale rows accumulated. Failing the whole transition makes the problem
 * visible instead of leaving the lead and its visit disagreeing.
 */
export async function syncVisitsToLeadState(
  tx: PrismaClient,
  actor: JwtPayload,
  leadId: string,
  leadState: string,
  now: Date = new Date(),
): Promise<SyncedVisit[]> {
  const open = await tx.siteVisit.findMany({
    where: { leadId, status: { in: [...OPEN_VISIT_STATUSES] } },
    select: { id: true, status: true, scheduledFor: true, userId: true },
  });
  if (open.length === 0) return [];

  const synced: SyncedVisit[] = [];
  for (const visit of open) {
    const fate = visitFateForLeadState(leadState, visit.scheduledFor, now);
    if (fate === null) continue;

    // Conditional on status so a concurrent writer that already closed the row
    // is not overwritten; count 0 here with a row we just read means RLS or a
    // race, and both must be loud.
    const result = await tx.siteVisit.updateMany({
      where: { id: visit.id, status: { in: [...OPEN_VISIT_STATUSES] } },
      data: { status: fate.status },
    });
    if (result.count !== 1) {
      throw new ConflictException(
        `Could not update visit ${visit.id} for lead ${leadId} (lead state ${leadState}): the row was changed concurrently or is not writable by ${actor.role}. The lead was not moved; retry, or ask a manager.`,
      );
    }

    await tx.auditLog.create({
      data: {
        userId: actor.sub,
        organizationId: actor.organizationId,
        action: `visit.${fate.status === 'CANCELLED' ? 'cancel' : 'sync'}`,
        entityType: 'SiteVisit',
        entityId: visit.id,
        before: { status: visit.status },
        after: {
          status: fate.status,
          leadId,
          leadState,
          closedBecause: fate.reason,
          wasScheduledFor: visit.scheduledFor.toISOString(),
          wasAssignedTo: visit.userId,
        },
        reason: REASON_TEXT[fate.reason] ?? fate.reason,
      },
    });
    synced.push({
      id: visit.id,
      from: 'SCHEDULED',
      to: fate.status,
      reason: fate.reason,
    });
  }
  return synced;
}
