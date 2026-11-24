// Who may conduct a visit, and when naming someone new will be refused.
//
// WHY THIS EXISTS (2026-11-24): scheduling a visit on a lead that already carries
// a co-owner, naming a DIFFERENT person, comes back as a 409 from
// visits.service.grantExecLeadVisibility. The message is clear but it arrives after
// the form has been filled in, and the dialog had no idea the lead had a co-owner.
//
// The rule mirrored here, from that method:
//   the seat is only in play when the conductor is SALES_EXEC or MANAGER,
//   the conductor is not the lead's owner, and the conductor is not already the
//   co-owner. Then, if a co-owner exists, the create refuses.
//
// ONE DELIBERATE ASYMMETRY: the server lets a MANAGER through when they already
// lead the lead's team, because that manager reads the lead without the seat. This
// helper cannot see team leadership, so a caller must WARN with it and never block:
// a false block would forbid a legitimate hand-over to the team's own manager.

/** Roles the server accepts as a visit's conductor (VISIT_CONDUCTOR_ROLES). */
export const VISIT_CONDUCTOR_ROLES = ['SALES_EXEC', 'MANAGER', 'ADMIN', 'OWNER'] as const;

/** True when this role may conduct a visit themselves. */
export function canConductVisit(role: string | null | undefined): boolean {
  return (
    role !== null &&
    role !== undefined &&
    (VISIT_CONDUCTOR_ROLES as readonly string[]).includes(role)
  );
}

export interface CoOwnerClash {
  /** The person who currently holds the seat, from the lead row. */
  coOwnerId: string;
  /** Their display name, when the row carried one. */
  coOwnerName: string | null;
}

/**
 * The clash a create would hit, or null when naming `conductorId` is safe.
 *
 * `conductorId` is the resolved assignee: the picked exec, or the actor when the
 * field is left blank and they can conduct themselves.
 */
export function coOwnerClash(
  lead: { ownerId?: string | null; coOwnerId?: string | null; coOwnerName?: string | null },
  conductorId: string | null | undefined,
): CoOwnerClash | null {
  if (conductorId === null || conductorId === undefined || conductorId.length === 0) return null;
  const coOwnerId = lead.coOwnerId ?? null;
  if (coOwnerId === null || coOwnerId.length === 0) return null;
  if (coOwnerId === conductorId) return null;
  const ownerId = lead.ownerId ?? null;
  if (ownerId !== null && ownerId === conductorId) return null;
  return { coOwnerId, coOwnerName: lead.coOwnerName ?? null };
}
