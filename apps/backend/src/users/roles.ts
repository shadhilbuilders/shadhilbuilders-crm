// Role hierarchy for the user model (Rounds 17–21):
//   OWNER ⊇ ADMIN ⊇ MANAGER ⊇ TELECALLER / SALES_EXEC
// Exactly ONE OWNER exists (partial unique index one_owner,
// migration 20260831110200) - it exists via seed/migration only; the
// API can never create or assign it. It bootstraps ADMINs and can
// change any role. ADMIN creates/changes MANAGER/TELECALLER/SALES_EXEC.
// MANAGER creates/changes TELECALLER/SALES_EXEC within their own team.
// Staff roles change nobody (their own account included).
import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient, Role } from '@shadhil/database';

// Lower number = more authority. Total order over the create/change-user
// capability. Model C responsibility boundaries are NOT part of this
// order (exec cannot schedule visits; telecaller cannot log VISITED).
// ENGINEER (issue #7 slice 1) sits BELOW both staff roles: rank 1 keeps the
// outranks() gate allowing MANAGER+ to manage engineer ROWS they already
// own, but assertCanCreateRole/assertCanChangeRole additionally pin ENGINEER
// assignment to the admin class (site-staff provisioning is an admin act).
const RANK: Record<Role, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  TELECALLER: 1,
  SALES_EXEC: 1,
  ENGINEER: 1,
  // Issue #8 slice 2: buyer login. Rank 1 like the other non-managers, but
  // assertCanCreateRole/assertCanChangeRole pin CUSTOMER to the admin class
  // and MANAGER may never touch a CUSTOMER row.
  CUSTOMER: 1,
};

export const OWNER: Role = 'OWNER';

/**
 * T-REPORTS-TO-OWNER: MANAGER and ADMIN report to the org OWNER on the
 * Users detail + Teams surfaces (fixed - exactly one OWNER per org, never
 * assignable via the API, see the file header). Returns null for an org
 * with no OWNER row yet (should not happen post-seed, but this must never
 * throw - it backs a read-only display field). Caller is responsible for
 * running this inside an RLS transaction (User has no RLS, but this keeps
 * the lookup consistent with every other query in the same request).
 */
export async function findOrgOwner(
  client: PrismaClient,
  organizationId: string,
): Promise<{ id: string; name: string; email: string } | null> {
  return client.user.findFirst({
    where: { role: OWNER, organizationId, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
}

/** ADMIN or OWNER (the "admin class"). Soft-deletes + project deletes use this. */
export function isAdminClass(role: Role): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/**
 * Roles whose work is entirely SITE documentation (2026-11-08).
 *
 * Mirrors `isSiteOnlyRole` in `apps/web/src/lib/session.ts` - kept in lockstep
 * on purpose, exactly like `canUseWhatsappInbox`, because the web blocks
 * `/inventory` for this role and the API must not hand it the data anyway.
 * A UI block is a courtesy; the projection below is the wall.
 *
 * ENGINEER is the only member: it documents construction progress on site and
 * has no CRM authority. TELECALLER is deliberately NOT included - they own
 * leads from NEW through VISIT_SCHEDULED and read inventory as part of that
 * job (with the rupee columns hidden in the UI).
 */
export function isSiteOnlyRole(role: Role): boolean {
  return role === 'ENGINEER';
}

/**
 * True when the actor may see villa MONEY: per-sq.ft price, total price, and
 * the deal on a booking.
 *
 * This gates the API projection (`unitRowSelectFor` / `toUnitRow`), not just a
 * column in the grid. A site engineer's browser is not a trusted place to hold
 * a project's pricing: hiding a column still shipped the number, and a hidden
 * element is one devtools panel away from being read.
 */
export function canSeeUnitMoney(role: Role): boolean {
  return !isSiteOnlyRole(role);
}

/**
 * Roles with a Site updates page (2026-11-10): the engineer who captures, plus
 * MANAGER/ADMIN/OWNER who review (read-only). TELECALLER is deliberately out.
 * Mirrors `canViewSiteUpdates` in apps/web/src/lib/session.ts.
 */
export function canViewSiteUpdates(role: Role): boolean {
  return role === 'ENGINEER' || role === 'MANAGER' || isAdminClass(role);
}

/** Only the ENGINEER captures site photos; the other viewers are read-only. */
export function canCaptureSitePhotos(role: Role): boolean {
  return role === 'ENGINEER';
}

/** MANAGER, ADMIN, or OWNER - can manage a project's staff members. */
/**
 * T-WA-INBOX (2026-09-25): the WhatsApp chat system is manager-and-above.
 * Mirrors the RLS policies on Message/OutboundMessage/ChatReadState
 * (ADMIN/OWNER/MANAGER only for non-lead threads) and the web helper
 * `canUseWhatsappInbox` in apps/web/src/lib/session.ts. Kept in lockstep on
 * purpose: if these disagree, the UI offers a surface the API refuses.
 */
export function canUseWhatsappInbox(role: Role): boolean {
  return isAdminClass(role) || role === 'MANAGER';
}

export function canManageProjectMembers(role: Role): boolean {
  return isAdminClass(role) || role === 'MANAGER';
}

/** True when the actor's rank is strictly above the target role's rank. */
export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

/**
 * Assert the actor may CREATE a user with `targetRole` (Rounds 17/20/21).
 *   OWNER   → any role except OWNER
 *   ADMIN   → MANAGER / TELECALLER / SALES_EXEC / ENGINEER
 *   MANAGER → TELECALLER / SALES_EXEC (team scope enforced in service)
 *   staff   → nothing
 * OWNER is never a creatable target (uniqueness invariant).
 * Issue #7 slice 1: ENGINEER is OWNER/ADMIN-only (site-staff provisioning
 * is an admin act; a MANAGER must never provision site crew).
 */
export function assertCanCreateRole(actor: Role, targetRole: Role): void {
  if (targetRole === OWNER) {
    throw new ForbiddenException(
      'OWNER cannot be created via the API - exactly one exists via seed',
    );
  }
  if (targetRole === 'ENGINEER' && !isAdminClass(actor)) {
    throw new ForbiddenException(
      `${actor} cannot create ${targetRole} users - ENGINEER provisioning is OWNER/ADMIN only`,
    );
  }
  if (targetRole === 'CUSTOMER' && !isAdminClass(actor)) {
    throw new ForbiddenException(
      `${actor} cannot create ${targetRole} users - CUSTOMER provisioning is OWNER/ADMIN only`,
    );
  }
  if (RANK[actor] <= RANK[targetRole]) {
    throw new ForbiddenException(`${actor} cannot create ${targetRole} users`);
  }
}

/**
 * Assert the actor may CHANGE a user's role to `newRole` (Round 20, rename 21).
 *   OWNER   → any role except OWNER, on anyone
 *   ADMIN   → MANAGER/TELECALLER/SALES_EXEC on MANAGER/TELECALLER/SALES_EXEC
 *   staff   → nobody
 * Guards (all three client-confirmed): no self-changes, only OWNER
 * touches ADMIN rows, OWNER role itself is unassignable.
 * Issue #7 slice 1: ENGINEER target/assignment is OWNER/ADMIN-only.
 */
export function assertCanChangeRole(actor: Role, targetRole: Role, newRole: Role): void {
  // Guard 0 (absolute): never into or out of OWNER.
  if (newRole === OWNER || targetRole === OWNER) {
    throw new ForbiddenException(
      'The OWNER role cannot be created, assigned, or changed via the API',
    );
  }
  // Guard 0b (issue #7): ENGINEER assignments are an admin act.
  if (newRole === 'ENGINEER' && !isAdminClass(actor)) {
    throw new ForbiddenException(
      `${actor} cannot assign the ${newRole} role - ENGINEER provisioning is OWNER/ADMIN only`,
    );
  }
  // Guard 0c (issue #8): CUSTOMER is an admin-class act in BOTH directions -
  // assigning the role, and moving a CUSTOMER row to any other role.
  if ((newRole === 'CUSTOMER' || targetRole === 'CUSTOMER') && !isAdminClass(actor)) {
    throw new ForbiddenException(
      `${actor} cannot change CUSTOMER roles - CUSTOMER provisioning is OWNER/ADMIN only`,
    );
  }
  // Guard 1: nobody changes their own role.
  // (target-user identity check happens in the service; role-level rule:
  //  an actor can only change strictly-lower-ranked users, which already
  //  excludes self - a role can never outrank itself.)
  if (RANK[actor] <= RANK[targetRole]) {
    throw new ForbiddenException(`${actor} cannot change the role of a ${targetRole}`);
  }
  if (RANK[actor] <= RANK[newRole]) {
    throw new ForbiddenException(`${actor} cannot assign the ${newRole} role`);
  }
}
