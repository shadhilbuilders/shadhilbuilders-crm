// T-VISIT-NOTIFY (2026-10-09): who must hear about a visit.
//
// ONE definition shared by the "visit scheduled" notification and the
// pre-visit reminder, so the two can never disagree about the audience:
//
//   - the assigned sales exec (conducts the visit)
//   - the lead owner (the telecaller who booked it; Lead.ownerId)
//   - the manager of the lead's team (Team.managerId)
//   - the organization owner(s) (role OWNER)
//
// Read as CRON_SERVICE so the audience is a property of the visit, not of who
// triggered it. Soft-deleted users are never notified.
import { withRlsContext, type PrismaClient } from '@shadhil/database';

import { cronContextFor } from '../common/cron-orgs';

export type VisitStakeholderInput = {
  organizationId: string;
  leadId: string;
  /** SiteVisit.userId - the exec conducting the visit. */
  assigneeId: string;
};

/** Collect the audience using an already-open client (de-duplicated). */
export async function collectVisitStakeholders(
  db: PrismaClient,
  input: VisitStakeholderInput,
): Promise<string[]> {
  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { ownerId: true, teamId: true },
  });

  const ids = new Set<string>([input.assigneeId]);
  if (lead?.ownerId) ids.add(lead.ownerId);

  if (lead?.teamId) {
    const team = await db.team.findFirst({
      where: { id: lead.teamId, organizationId: input.organizationId, deletedAt: null },
      select: { managerId: true },
    });
    if (team?.managerId) ids.add(team.managerId);
  }

  const owners = await db.user.findMany({
    where: { organizationId: input.organizationId, role: 'OWNER', deletedAt: null },
    select: { id: true },
  });
  for (const o of owners) ids.add(o.id);

  // Never notify a deactivated account.
  const live = await db.user.findMany({
    where: { id: { in: [...ids] }, organizationId: input.organizationId, deletedAt: null },
    select: { id: true },
  });
  return live.map((u: { id: string }) => u.id);
}

/** Resolve the audience in a CRON_SERVICE context for the visit's org. */
export async function resolveVisitStakeholders(
  client: PrismaClient,
  input: VisitStakeholderInput,
): Promise<string[]> {
  return withRlsContext(client, cronContextFor(input.organizationId), async (tx) =>
    collectVisitStakeholders(tx as unknown as PrismaClient, input),
  );
}
