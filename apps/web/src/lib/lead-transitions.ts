// Pure mirror of the backend lead state machine for the web UI (no React).
// Kept out of LeadActionPanel so lightweight consumers (LeadVisitPanel) can ask
// "which moves may this role make?" without importing the panel's dialogs/hooks.

/**
 * Local mirror of the backend Model C transition table. Mirrored here
 * (not imported from the backend) because the backend file lives in
 * `apps/backend/src/leads/leads.state-machine.ts` and is NOT a published
 * package - importing across workspace boundaries would violate the
 * monorepo direction (apps/backend may not be consumed by apps/web).
 *
 * Source of truth: TRANSITIONS in apps/backend/src/leads/leads.state-machine.ts.
 * Drift here means the user sees a button the server will reject - the
 * server still wins. Re-verify on every backend state-machine change.
 */
export const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  NEW: ['CONTACTED', 'VISIT_REQUESTED', 'RNR', 'LOST'],
  CONTACTED: ['NEW', 'VISIT_REQUESTED', 'VISIT_SCHEDULED', 'RNR', 'LOST'],
  VISIT_REQUESTED: ['CONTACTED', 'VISIT_SCHEDULED', 'RNR', 'LOST'],
  VISIT_SCHEDULED: ['VISIT_REQUESTED', 'VISITED', 'NO_SHOW', 'RESCHEDULED', 'RNR', 'LOST'],
  VISITED: ['NEGOTIATION', 'VISIT_REQUESTED', 'RNR', 'LOST'],
  NEGOTIATION: ['VISITED', 'VISIT_REQUESTED', 'BOOKING_INITIATED', 'RNR', 'LOST'],
  BOOKING_INITIATED: ['NEGOTIATION', 'WON', 'LOST'],
  WON: [],
  LOST: [],
  RNR: [],
  NO_SHOW: ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'RNR', 'LOST'],
  RESCHEDULED: ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'RNR', 'LOST'],
};


/**
 * The one edge the visit handoff reserves (2026-09-16 owner ruling).
 *
 * The handoff happens while the lead is still VISIT_SCHEDULED: the assigned
 * SALES_EXEC records the visit as COMPLETED and the server drives
 * VISIT_SCHEDULED → VISITED (visits.service.ts, "Drive the parent lead state
 * on COMPLETED"). So this edge belongs to the exec, NOT to the telecaller -
 * even though VISIT_SCHEDULED is otherwise the telecaller's state.
 *
 * The mirror has to encode this because the telecaller lane reuses the raw
 * TRANSITIONS list for its states, so simply rendering `TRANSITIONS[status]`
 * would offer a telecaller a "Visited" button the server answers 403 for.
 * Mirrors HANDOFF_FROM/HANDOFF_TO in the backend state machine.
 */
const HANDOFF_FROM = 'VISIT_SCHEDULED';
const HANDOFF_TO = 'VISITED';

/** Exec's second reserved edge: scheduling the repeat visit (see backend note). */
const REPEAT_FROM = 'VISIT_REQUESTED';
const REPEAT_TO = 'VISIT_SCHEDULED';

/**
 * One step BACK per status, rendered as a separate "Move back" group so a
 * rollback is never mistaken for progress. Every non-first, non-terminal state
 * has one:
 *  - VISITED goes back to Visit requested (its predecessor, Visit booked, is
 *    only reachable by scheduling a visit).
 *  - NO_SHOW / RESCHEDULED go back to Visit requested (the visit is due again).
 *  - BOOKING_INITIATED goes back to Negotiation (server refuses while a token
 *    booking is active).
 * NEW is the first state and WON/LOST/RNR are terminal (admin reopen only), so
 * they have no back step.
 */
export const BACKWARD_ONE_STEP: Readonly<Record<string, string>> = {
  CONTACTED: 'NEW',
  VISIT_REQUESTED: 'CONTACTED',
  VISIT_SCHEDULED: 'VISIT_REQUESTED',
  NEGOTIATION: 'VISITED',
  BOOKING_INITIATED: 'NEGOTIATION',
  VISITED: 'VISIT_REQUESTED',
  NO_SHOW: 'VISIT_REQUESTED',
  RESCHEDULED: 'VISIT_REQUESTED',
};

/**
 * Split a state's outgoing edges into the buttons the Transition form shows.
 *
 *  - `VISIT_SCHEDULED` is never a manual target: Visit booked is set only by
 *    scheduling a visit (the Visit panel), so no visit-less "booked" lead exists
 *    and "Visit requested" and "Visit booked" never appear as rival buttons.
 *  - `VISIT_REQUESTED` out of VISITED/NEGOTIATION is "Request visit again", owned
 *    by the Visit panel, so it is dropped here to avoid a duplicate.
 *  - The one-step-back target moves to its own group.
 */
export function splitTransitions(
  status: string,
  outgoing: readonly string[],
): { forward: readonly string[]; back: readonly string[] } {
  const backTarget = BACKWARD_ONE_STEP[status];
  const requestAgainOnVisitPanel = status === 'VISITED' || status === 'NEGOTIATION';
  const forward = outgoing.filter(
    (to) =>
      to !== 'VISIT_SCHEDULED' &&
      to !== backTarget &&
      !(requestAgainOnVisitPanel && to === 'VISIT_REQUESTED'),
  );
  const back = backTarget !== undefined && outgoing.includes(backTarget) ? [backTarget] : [];
  return { forward, back };
}

/** Outgoing edges for `role` at `status`, per the server's role gates. */
export function allowedTransitionsFor(status: string, role: string): readonly string[] {
  const outgoing: readonly string[] = TRANSITIONS[status] ?? [];
  const isTelecallerLane = TELECALLER_LANE.includes(status);
  const isExecLane = EXEC_LANE.includes(status);
  const isHandoffEdge = (to: string) => status === HANDOFF_FROM && to === HANDOFF_TO;

  if (role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER') {
    // Managers and admins drive any non-terminal edge; terminal states have
    // no outgoing edges for them.
    return outgoing;
  }
  if (role === 'TELECALLER') {
    if (!isTelecallerLane) return [];
    return outgoing.filter((to) => !isHandoffEdge(to));
  }
  if (role === 'SALES_EXEC') {
    if (isExecLane) return outgoing;
    // The exec's one out-of-lane edge: completing the visit they conducted.
    return outgoing.filter(
      (to) => isHandoffEdge(to) || (status === REPEAT_FROM && to === REPEAT_TO),
    );
  }
  return [];
}

const TELECALLER_LANE: readonly string[] = [
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'RESCHEDULED',
  'NO_SHOW',
];

const EXEC_LANE: readonly string[] = ['VISITED', 'NEGOTIATION', 'BOOKING_INITIATED'];


/** Terminal states: no outgoing edges; only an admin can reopen them. */
export const TERMINAL_STATES: readonly string[] = ['WON', 'LOST', 'RNR'];

/**
 * Where an admin may reopen a terminal lead. VISIT_SCHEDULED is left out on
 * purpose (Visit booked only comes from scheduling a visit), and so is
 * BOOKING_INITIATED (driven by a booking record).
 */
export const REOPEN_TARGETS: readonly string[] = [
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISITED',
  'NEGOTIATION',
];

/** Reopen choices for `role` at `status`; empty unless an admin on a terminal lead. */
export function reopenTargetsFor(status: string, role: string | undefined): readonly string[] {
  const isAdmin = role === 'ADMIN' || role === 'OWNER';
  return isAdmin && TERMINAL_STATES.includes(status) ? REOPEN_TARGETS : [];
}
