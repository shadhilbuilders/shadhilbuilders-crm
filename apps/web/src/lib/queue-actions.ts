// Queue row-action matrix (T-DASH-QUEUE, 2026-09-16).
//
// PURE and React-free on purpose. This is the most security-relevant logic on
// the dashboard - it decides which state transitions a role is even OFFERED -
// so it must be testable without rendering anything. The component layer takes
// these specs and attaches the mutation; this file never imports React or a
// hook, which is why `lib/queue-actions.test.ts` can pin the whole matrix in
// milliseconds.
//
// WHY THIS MATTERS (verified against the running server, not assumed): the
// server is the authority - a bad call still 403s - but a UI that OFFERS an
// action the API refuses is worse than one that omits it, because the user
// reads the refusal as the tool being broken. The clearest case: a TELECALLER
// is never offered "Visited". Only the assigned SALES_EXEC (or a
// manager/admin) records a visit, and that is the sole path to VISITED; the
// telecaller's own outcome from VISIT_SCHEDULED is No-show, which returns the
// lead to them for re-engagement.
//
// Labels are plain words ("Called", "Wants a visit"), never enum names. This
// population is using a CRM for the first time; "CONTACTED" is not a thing a
// telecaller says out loud.

import { LEAD_STATES_AWAITING_A_VISIT } from '@shadhil/api-types';

export type QueueRole = 'TELECALLER' | 'SALES_EXEC' | 'MANAGER' | 'ADMIN' | 'OWNER';

/**
 * The states where a queue ROW offers "Schedule visit".
 *
 * IMPORTED, not restated. This matrix decides which button the operator is
 * OFFERED; the server guard (`VisitsService.create`) decides which call it
 * ACCEPTS. They were two copies until 2026-09-30 and they disagreed - the queue
 * offered "Schedule visit" on a NO_SHOW lead while the API answered
 * `400 Lead state NO_SHOW cannot accept a visit`. A refusal the user reads as a
 * broken tool is the failure this module exists to prevent (see the header
 * note), so both sides read one list now.
 *
 * NO_SHOW belongs in it: the lead machine's re-engagement edge is
 * `NO_SHOW -> VISIT_SCHEDULED`, and booking the next visit is how it is taken.
 * `docs/designs/2026-09-16-work-dashboard-telecaller-queue.md` has specified
 * "Schedule visit" on NO_SHOW rows since the queue was designed.
 *
 * It is the server's `SCHEDULABLE_LEAD_STATES` MINUS `VISIT_SCHEDULED`, and that
 * one exclusion is the UI's business, not the server's: a lead with a live
 * appointment gets the OUTCOME button ("No show"), and a second, parallel
 * booking is the calendar's path. The server still accepts a create from
 * `VISIT_SCHEDULED`, so this list must never be used as a server guard. The
 * lead page (`LeadVisitPanel`) reads the same constant, so the two surfaces
 * cannot offer different buttons.
 */
const QUEUE_SCHEDULE_STATES: readonly string[] = LEAD_STATES_AWAITING_A_VISIT;

/** One action the row may offer, described declaratively. */
export type QueueActionSpec =
  | {
      kind: 'transition';
      /** The state machine target. */
      to: string;
      /** What the button says. */
      label: string;
      dataQa: string;
    }
  | {
      kind: 'scheduleVisit';
      label: string;
      dataQa: string;
    };

function transition(to: string, label: string): QueueActionSpec {
  return { kind: 'transition', to, label, dataQa: `queue-move-${to.toLowerCase()}` };
}

/**
 * Which roles may schedule a visit. Mirrors `canScheduleVisits` in
 * `@/lib/session` (which mirrors the server). Duplicated as a small local check
 * so this module stays dependency-free and unit-testable; the two lists are
 * pinned against each other by test.
 */
const CAN_SCHEDULE_VISIT: ReadonlyArray<QueueRole> = [
  'TELECALLER',
  'MANAGER',
  'ADMIN',
  'OWNER',
];

function canScheduleVisit(role: QueueRole): boolean {
  return CAN_SCHEDULE_VISIT.includes(role);
}

function isManagerOrAbove(role: QueueRole): boolean {
  return role === 'MANAGER' || role === 'ADMIN' || role === 'OWNER';
}

/**
 * The actions offered for a lead in a given state, for a given role.
 *
 * Ordered most-likely-action first, because the row renders the first two
 * inline and the rest behind "More". For a NEW lead that means "Called" and
 * "Wants a visit" - the two answers a telecaller actually gives.
 *
 * Returns [] when the role has no move here, and the row then shows only the
 * expand toggle. That is deliberate: an empty action list is honest, whereas a
 * disabled button invites the user to keep trying.
 */
export function queueActionsFor({
  role,
  status,
}: {
  role: QueueRole;
  status: string;
}): QueueActionSpec[] {
  if (status === 'NEW') {
    return [transition('CONTACTED', 'Called'), transition('VISIT_REQUESTED', 'Wants a visit')];
  }

  if (status === 'CONTACTED') {
    return [transition('VISIT_REQUESTED', 'Wants a visit')];
  }

  // A lead waiting on a visit is the telecaller's to book. MANAGER/ADMIN can
  // book on their behalf; a SALES_EXEC cannot (they conduct visits, they do not
  // schedule them).
  //
  // QUEUE_SCHEDULE_STATES is the server's list minus VISIT_SCHEDULED - see its
  // comment for why that one state is handled by the branch below instead.
  if (QUEUE_SCHEDULE_STATES.includes(status)) {
    if (!canScheduleVisit(role)) return [];
    return [{ kind: 'scheduleVisit', label: 'Schedule visit', dataQa: 'queue-schedule-visit' }];
  }

  // VISIT_SCHEDULED: the telecaller's only outcome is No-show. There is NO
  // VISITED transition here for any role - recording the visit belongs to the
  // exec's own visit surface, not to a queue button.
  if (status === 'VISIT_SCHEDULED') {
    return [transition('NO_SHOW', 'No show')];
  }

  // The exec's lane.
  if (status === 'VISITED') {
    return [transition('NEGOTIATION', 'Negotiating')];
  }
  if (status === 'NEGOTIATION') {
    return [transition('BOOKING_INITIATED', 'Booking')];
  }

  // Closing a booking is a manager decision.
  if (status === 'BOOKING_INITIATED' && isManagerOrAbove(role)) {
    return [transition('WON', 'Won')];
  }

  // Terminal states and anything unmapped: no action, only the expand toggle.
  return [];
}

/**
 * Terminal states. A lead here is a RECORD, not work - no role has any action
 * from the queue (`queueActionsFor` returns [] for all of them), so showing them
 * is archive, not a queue. Excluded from every lane on purpose.
 */
export const TERMINAL_LEAD_STATES: readonly string[] = ['WON', 'LOST', 'RNR'];

/**
 * The states each role's queue should show, so the dashboard asks the server
 * for the right slice instead of filtering a wider set client-side. The server
 * still scopes WHICH leads a role may see; this scopes WHICH part of their own
 * pipeline is on screen.
 *
 * T-DASH-QUEUE-SCOPE (2026-09-16, owner decision): a queue shows WORK, not the
 * whole pipeline. The rule is "a lead is in this role's lane only if this role
 * has something to DO about it". A manager previously passed NO state filter, so
 * their queue was every lead in scope - 21 of 33 rows were VISITED, which a
 * manager cannot move (only the assigned exec can: VISITED -> NEGOTIATION).
 *
 * THE TRAP, recorded so nobody re-derives it wrongly: do NOT infer "actionable"
 * from "someone can act on it". BOOKING_INITIATED -> WON is offered to
 * MANAGER/ADMIN/OWNER ONLY. Dropping it as "not mine" would make a closing deal
 * unreachable from the one surface the closer actually uses. It is in the manager
 * lane and belongs in NO staff lane.
 *
 * VISITED and NEGOTIATION are the exec's lane: the exec owns both edges, so a
 * manager sees them only through the exec's queue, not their own.
 *
 * MANAGER lane = "needs my attention": unworked leads (incl. the overdue ones
 * that sort first), anything one of their reports has asked to book, visits to
 * confirm today, and bookings to close. ADMIN/OWNER share it.
 */
export const QUEUE_STATES_BY_ROLE = {
  TELECALLER: [
    'NEW',
    'CONTACTED',
    'VISIT_REQUESTED',
    'VISIT_SCHEDULED',
    'RESCHEDULED',
    'NO_SHOW',
  ],
  // NOTE: BOOKING_INITIATED is deliberately NOT here. An exec could not act on
  // it - closing to WON is MANAGER/ADMIN/OWNER only - so it was a row in the
  // exec's queue with no button, exactly the defect this scoping exists to
  // remove. The manager lane carries it, so the deal is still covered.
  SALES_EXEC: ['VISITED', 'NEGOTIATION'],
  MANAGER: [
    'NEW',
    'CONTACTED',
    'VISIT_REQUESTED',
    'VISIT_SCHEDULED',
    'RESCHEDULED',
    'NO_SHOW',
    'BOOKING_INITIATED',
  ],
} as const satisfies Record<string, readonly string[]>;
