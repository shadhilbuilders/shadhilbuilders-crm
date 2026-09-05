// Lead state machine - Model C (IMPLEMENTATION-PLAN §3).
//
// Allowed transitions are role-aware per DESIGN.md §3:
//   - NEW → CONTACTED, VISIT_REQUESTED, COLD, LOST
//   - CONTACTED → VISIT_REQUESTED, VISIT_SCHEDULED, COLD, LOST
//   - VISIT_REQUESTED → VISIT_SCHEDULED, COLD, LOST
//   - VISIT_SCHEDULED → VISITED, NO_SHOW, RESCHEDULED, CANCELLED, COLD, LOST
//   - VISITED → NEGOTIATION, COLD, LOST
//   - NEGOTIATION → BOOKING_INITIATED, COLD, LOST
//   - BOOKING_INITIATED → WON, LOST
//   - WON, LOST, COLD - terminal (Admin-only override, see assertCanOverrideTerminal)
//   - RESCHEDULED, NO_SHOW → VISIT_SCHEDULED, COLD, LOST (re-engagement path)
//   - CANCELLED is a VisitStatus (per-visit outcome), not a LeadState - it
//     does NOT appear in TRANSITIONS. The cancel-visits flow lives in the
//     visits module and does NOT touch Lead.state.
//
// This module is PURE - no DB, no Nest, no Prisma. Every code path is
// covered by leads.state-machine.test.ts. The service calls into it; the
// service handles persistence, RLS, audit, and notifications.
import type { LeadState, Role } from '@shadhil/database';

export type { LeadState, Role } from '@shadhil/database';

/**
 * Every LeadState value the Prisma enum declares. The test asserts this
 * tuple matches the schema enum - drift surfaces immediately, not when a
 * forgotten transition silently 400s in production.
 */
export const LEAD_STATES = [
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
  'WON',
  'LOST',
  'COLD',
  'RESCHEDULED',
  'NO_SHOW',
] as const satisfies readonly LeadState[];

/**
 * States that are reachable FROM the given state. NO_SHOW and RESCHEDULED
 * route back to VISIT_SCHEDULED (the re-engagement loop in Model C); the
 * terminal trio (WON/LOST/COLD) has no outgoing edges for non-Admin roles.
 */
const TRANSITIONS: Readonly<Record<LeadState, readonly LeadState[]>> = {
  NEW: ['CONTACTED', 'VISIT_REQUESTED', 'COLD', 'LOST'],
  CONTACTED: ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'COLD', 'LOST'],
  VISIT_REQUESTED: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
  VISIT_SCHEDULED: ['VISITED', 'NO_SHOW', 'RESCHEDULED', 'COLD', 'LOST'],
  VISITED: ['NEGOTIATION', 'COLD', 'LOST'],
  NEGOTIATION: ['BOOKING_INITIATED', 'COLD', 'LOST'],
  BOOKING_INITIATED: ['WON', 'LOST'],
  WON: [], // terminal
  LOST: [], // terminal
  COLD: [], // terminal
  RESCHEDULED: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
  NO_SHOW: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
};

const TERMINAL_STATES: readonly LeadState[] = ['WON', 'LOST', 'COLD'];

/**
 * Role-scoping per DESIGN.md §3 ownership rules:
 *   - TELECALLER owns NEW through VISIT_SCHEDULED
 *   - SALES_EXEC owns VISITED onwards (handoff at visit outcome)
 *   - MANAGER + ADMIN can move any non-terminal lead
 *   - Only ADMIN can reopen a terminal state (WON/LOST/COLD → anything)
 */
function canRoleTransition(
  from: LeadState,
  to: LeadState,
  role: Role,
): boolean {
  // Self-transition is a no-op; allow it but the service treats it as a
  // write-free call (no audit row).
  if (from === to) return true;

  // ADMIN override on terminal states - re-open a WON/LOST/COLD lead.
  if (role === 'ADMIN' || role === 'OWNER') {
    return true;
  }

  // Manager can move any non-terminal state forward.
  if (role === 'MANAGER') {
    if (from === 'WON' || from === 'LOST' || from === 'COLD') return false;
    return TRANSITIONS[from].includes(to);
  }

  // Telecaller + Sales Exec are gated to their lane.
  if (role === 'TELECALLER') {
    const telecallerLane: readonly LeadState[] = [
      'NEW',
      'CONTACTED',
      'VISIT_REQUESTED',
      'VISIT_SCHEDULED',
      'RESCHEDULED',
      'NO_SHOW',
    ];
    if (!telecallerLane.includes(from)) return false;
    return TRANSITIONS[from].includes(to);
  }

  if (role === 'SALES_EXEC') {
    const execLane: readonly LeadState[] = [
      'VISITED',
      'NEGOTIATION',
      'BOOKING_INITIATED',
    ];
    if (!execLane.includes(from)) return false;
    return TRANSITIONS[from].includes(to);
  }

  return false;
}

export interface TransitionRequest {
  from: LeadState;
  to: LeadState;
  role: Role;
}

export type TransitionResult =
  | { ok: true; reason: 'SAME_STATE' }
  | { ok: true; reason: 'ALLOWED' }
  | { ok: false; code: 'INVALID_TRANSITION'; from: LeadState; to: LeadState }
  | {
      ok: false;
      code: 'ROLE_FORBIDDEN';
      from: LeadState;
      to: LeadState;
      role: Role;
    };

/**
 * Decide whether a state transition is legal. Pure function - no side
 * effects. The service catches the discriminated-union non-ok variants
 * and turns them into 400/403 responses.
 *
 * Order of checks matters:
 *   1. Same-state short-circuit (no-op).
 *   2. Admin/OWNER override - they can re-open terminal states, which
 *      sit OUTSIDE the canonical TRANSITIONS graph. If the role is
 *      ADMIN/OWNER and the `from` is terminal, treat the edge as
 *      legal. (Same-state and within-graph are obviously legal too.)
 *   3. Graph membership - the edge must exist in TRANSITIONS.
 *   4. Role lane - even if the edge exists, only certain roles traverse it.
 */
export function canTransition(req: TransitionRequest): TransitionResult {
  const { from, to, role } = req;

  if (from === to) {
    return { ok: true, reason: 'SAME_STATE' };
  }

  // Admin/OWNER override: drive any graph edge + re-open any terminal.
  if (role === 'ADMIN' || role === 'OWNER') {
    const edgeInGraph = TRANSITIONS[from].includes(to);
    const reopeningTerminal =
      TERMINAL_STATES.includes(from) && !TERMINAL_STATES.includes(to);
    if (edgeInGraph || reopeningTerminal) {
      return { ok: true, reason: 'ALLOWED' };
    }
    // Even admin can't drive a non-existent, non-reopen edge
    // (e.g. NEW → WON, NEW → RESCHEDULED). Graph says no.
    return { ok: false, code: 'INVALID_TRANSITION', from, to };
  }

  // Non-admin: graph must contain the edge.
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, code: 'INVALID_TRANSITION', from, to };
  }

  if (!canRoleTransition(from, to, role)) {
    return { ok: false, code: 'ROLE_FORBIDDEN', from, to, role };
  }

  return { ok: true, reason: 'ALLOWED' };
}

/**
 * Returns the set of states reachable from `from` for `role`. Useful for
 * the UI: the dropdown of allowed next-states for a lead is exactly this
 * set, no round-trip to the server.
 */
export function allowedNextStates(
  from: LeadState,
  role: Role,
): readonly LeadState[] {
  if (role === 'ADMIN' || role === 'OWNER') {
    // Admin override on terminal states - re-open allowed.
    return [
      ...TRANSITIONS[from],
      ...(from === 'WON' || from === 'LOST' || from === 'COLD'
        ? (['NEW', 'CONTACTED', 'VISIT_REQUESTED', 'VISIT_SCHEDULED', 'VISITED', 'NEGOTIATION', 'BOOKING_INITIATED'] as LeadState[])
        : []),
    ];
  }
  return TRANSITIONS[from].filter((to) => canRoleTransition(from, to, role));
}

/**
 * Can a user with `role` OWN a lead currently in state `state`?
 *
 * Distinct from canRoleTransition: that function gates the
 * `from → to` edge; this one gates the *static* fact of whether
 * the role is allowed to be the lead's owner in that state. Used
 * by the manual-reassign flow (Plan §18 D2/D3) - when an admin
 * or manager moves a lead to a new owner, the target user's role
 * must permit owning the lead at its current state. (The
 * transition is "self → self" in the state graph, so the regular
 * canTransition check is trivially OK; the missing constraint is
 * whether the target role is even a valid owner of that state.)
 *
 *   - TELECALLER: NEW / CONTACTED / VISIT_REQUESTED / VISIT_SCHEDULED
 *     / RESCHEDULED / NO_SHOW (the lane Model C assigns to telecallers)
 *   - SALES_EXEC: VISITED / NEGOTIATION / BOOKING_INITIATED (the
 *     exec lane; the handoff at visit outcome is the boundary)
 *   - MANAGER / ADMIN / OWNER: any state, including terminal
 *     (managers run team pipelines end-to-end; admin + owner
 *     own everything by definition).
 */
export function canRoleOwnState(state: LeadState, role: Role): boolean {
  if (role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER') {
    return true;
  }
  if (role === 'TELECALLER') {
    return (
      state === 'NEW' ||
      state === 'CONTACTED' ||
      state === 'VISIT_REQUESTED' ||
      state === 'VISIT_SCHEDULED' ||
      state === 'RESCHEDULED' ||
      state === 'NO_SHOW'
    );
  }
  if (role === 'SALES_EXEC') {
    return (
      state === 'VISITED' ||
      state === 'NEGOTIATION' ||
      state === 'BOOKING_INITIATED'
    );
  }
  return false;
}