// Role hierarchy for the user model (Rounds 17–21):
//   OWNER ⊇ ADMIN ⊇ MANAGER ⊇ TELECALLER / SALES_EXEC
// Exactly ONE OWNER exists (partial unique index one_owner,
// migration 20260831110200) - it exists via seed/migration only; the
// API can never create or assign it. It bootstraps ADMINs and can
// change any role. ADMIN creates/changes MANAGER/TELECALLER/SALES_EXEC.
// MANAGER creates/changes TELECALLER/SALES_EXEC within their own team.
// Staff roles change nobody (their own account included).
import { ForbiddenException } from '@nestjs/common';
import type { Role } from '@shadhil/database';

// Lower number = more authority. Total order over the create/change-user
// capability. Model C responsibility boundaries are NOT part of this
// order (exec cannot schedule visits; telecaller cannot log VISITED).
const RANK: Record<Role, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  TELECALLER: 1,
  SALES_EXEC: 1,
};

export const OWNER: Role = 'OWNER';

/** True when the actor's rank is strictly above the target role's rank. */
export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

/**
 * Assert the actor may CREATE a user with `targetRole` (Rounds 17/20/21).
 *   OWNER   → any role except OWNER
 *   ADMIN   → MANAGER / TELECALLER / SALES_EXEC
 *   MANAGER → TELECALLER / SALES_EXEC (team scope enforced in service)
 *   staff   → nothing
 * OWNER is never a creatable target (uniqueness invariant).
 */
export function assertCanCreateRole(actor: Role, targetRole: Role): void {
  if (targetRole === OWNER) {
    throw new ForbiddenException(
      'OWNER cannot be created via the API - exactly one exists via seed',
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
 */
export function assertCanChangeRole(
  actor: Role,
  targetRole: Role,
  newRole: Role,
): void {
  // Guard 0 (absolute): never into or out of OWNER.
  if (newRole === OWNER || targetRole === OWNER) {
    throw new ForbiddenException(
      'The OWNER role cannot be created, assigned, or changed via the API',
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
    throw new ForbiddenException(
      `${actor} cannot assign the ${newRole} role`,
    );
  }
}