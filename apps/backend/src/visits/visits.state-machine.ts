// Site visit state machine — pure module, no Nest/Prisma/DB imports
// beyond the VisitStatus enum type.
//
// Modeled after apps/backend/src/leads/leads.state-machine.ts:
//   - Discriminated-union TransitionResult (ok / not-ok)
//   - Order of checks: same-state → role gate → graph membership
//   - allowedNextStates() helper for the UI
//
// Terminal states (COMPLETED, CANCELLED) have no outgoing edges for
// non-Admin roles. ADMIN can re-open (per Model C handoff symmetry
// with the leads state machine).
import type { VisitStatus, Role } from '@shadhil/database';

export type { VisitStatus, Role };

export const VISIT_STATES = [
  'SCHEDULED',
  'RESCHEDULED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
] as const satisfies readonly VisitStatus[];

const TRANSITIONS: Readonly<Record<VisitStatus, readonly VisitStatus[]>> = {
  SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED'],
  RESCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  // Terminal trio — ADMIN/OWNER can re-open.
  COMPLETED: [],
  NO_SHOW: ['RESCHEDULED'],
  CANCELLED: [],
};

/**
 * Role lane gates. The visits module has a clearer separation than
 * leads: TELELCALLER schedules, SALES_EXEC carries it out, MANAGER
 * oversees. NO_SHOW re-engagement is allowed for telecaller (they
 * drive the next outreach) and sales exec (they follow up).
 *
 * Returned in a CANONICAL order so `allowedNextStates` and the UI
 * agree on the sequence — order matters because the dropdown renders
 * left-to-right. The order is documented per role below; the
 * TRANSITIONS table is the graph only (no UI ordering implication).
 */
const ROLE_LANES: Readonly<
  Record<Role, Readonly<Record<VisitStatus, readonly VisitStatus[]>>>
> = {
  MANAGER: {
    SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED'],
    RESCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
    COMPLETED: [],
    NO_SHOW: ['RESCHEDULED'],
    CANCELLED: [],
  },
  TELECALLER: {
    SCHEDULED: ['CANCELLED', 'NO_SHOW', 'RESCHEDULED'],
    RESCHEDULED: ['CANCELLED', 'NO_SHOW'],
    COMPLETED: [],
    NO_SHOW: ['RESCHEDULED', 'CANCELLED'],
    CANCELLED: [],
  },
  SALES_EXEC: {
    SCHEDULED: ['COMPLETED', 'NO_SHOW'],
    RESCHEDULED: ['COMPLETED', 'NO_SHOW'],
    COMPLETED: [],
    NO_SHOW: [],
    CANCELLED: [],
  },
  ADMIN: {
    SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED'],
    RESCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
    COMPLETED: [],
    NO_SHOW: ['RESCHEDULED'],
    CANCELLED: [],
  },
  OWNER: {
    SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED'],
    RESCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
    COMPLETED: [],
    NO_SHOW: ['RESCHEDULED'],
    CANCELLED: [],
  },
};

function canRoleTransition(
  from: VisitStatus,
  to: VisitStatus,
  role: Role,
): boolean {
  if (from === to) return true;
  if (role === 'ADMIN' || role === 'OWNER') {
    return true; // admin override
  }
  return ROLE_LANES[role][from].includes(to);
}

export interface TransitionRequest {
  from: VisitStatus;
  to: VisitStatus;
  role: Role;
}

export type TransitionResult =
  | { ok: true; reason: 'SAME_STATE' | 'ALLOWED' }
  | {
      ok: false;
      code: 'INVALID_TRANSITION' | 'ROLE_FORBIDDEN';
      from: VisitStatus;
      to: VisitStatus;
      role: Role;
    };

export function canTransition(req: TransitionRequest): TransitionResult {
  const { from, to, role } = req;

  if (from === to) {
    return { ok: true, reason: 'SAME_STATE' };
  }

  // Admin/OWNER override: skip both the role lane AND the graph check.
  // They can re-open terminals and transition to any VisitStatus — the
  // schema enum IS their reach. The role gate below returns true for
  // them; the graph check is skipped.
  if (role === 'ADMIN' || role === 'OWNER') {
    return { ok: true, reason: 'ALLOWED' };
  }

  // For non-admins: role gate first, then graph. Order matters — see
  // the test pinning `ROLE_FORBIDDEN` vs `INVALID_TRANSITION`.
  if (!canRoleTransition(from, to, role)) {
    return { ok: false, code: 'ROLE_FORBIDDEN', from, to, role };
  }

  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, code: 'INVALID_TRANSITION', from, to, role };
  }

  return { ok: true, reason: 'ALLOWED' };
}

export function allowedNextStates(
  from: VisitStatus,
  role: Role,
): readonly VisitStatus[] {
  if (role === 'ADMIN' || role === 'OWNER') {
    // Admin override: include the lane plus terminal re-open edges.
    const base = ROLE_LANES[role][from];
    const reopen =
      from === 'COMPLETED' || from === 'CANCELLED'
        ? (['SCHEDULED', 'RESCHEDULED', 'NO_SHOW'] as VisitStatus[])
        : ([] as VisitStatus[]);
    return [...base, ...reopen];
  }
  return ROLE_LANES[role][from];
}
