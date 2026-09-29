// Work-queue ordering for the dashboard (T-DASH-QUEUE, 2026-09-16).
//
// SINGLE PLACE TO TUNE. The owner's observation run (sit with a telecaller, no
// helping) decides whether this ordering matches how a telecaller actually works
// top-down. Everything structural lives in the page; only the ORDER lives here,
// so the answer to that observation is a change to this file and nothing else.
//
// WHY THE ORDERING IS MOSTLY CLIENT-SIDE, and why that is not a shortcut:
// the server sort (`LeadsService.sortOrderSql`) is fixed to overdue-NEW / NEW /
// everything-else, tie-broken `updatedAt DESC, createdAt DESC`, and the only
// client override it accepts is `sortBy` from
// ['updatedAt','createdAt','name']. There is no server-side bucket for visit
// state, and `LeadRow` carries no visit fields at all. So the refinement below
// is applied to the LOADED PAGE and is labelled as such rather than pretended
// to be server-side. If the queue ever outgrows one page, this is the function
// that has to move into SQL.
//
// The SLA (30 min to first touch) is the organizing principle: a lead is
// overdue when it is still NEW and older than OVERDUE_AFTER_MIN. That is the
// only hard deadline in the system, and it is why "needs a call now" sorts
// first.

import { isOverdue, leadAgeTier, OVERDUE_AFTER_MIN } from '@/lib/leads';

/**
 * The minimal row shape ordering needs. Deliberately structural rather than a
 * component's prop type: this module is pure ordering logic and should not
 * depend on a component. Anything with a state and a createdAt satisfies it.
 */
export type QueueRow = {
  status?: string | null;
  createdAt?: string | null;
};

/**
 * Where a lead sits in the telecaller's day. Lower sorts first.
 *
 *   0  OVERDUE NEW      - breached the 30-minute first-touch SLA. Drop everything.
 *   1  NEW              - fresh, clock running (the age staircase tints these).
 *   2  CONTACTED        - picked up but not yet moved on; nudge before it cools.
 *   3  VISIT_REQUESTED  - someone wants a visit; scheduling is the next action.
 *   4  VISIT_SCHEDULED  - booked; confirmation work, not yet the exec's.
 *   5  NO_SHOW / RESCHEDULED - re-engagement; the telecaller owns these again.
 *   6  everything else  - the exec lane and terminal states, if they appear.
 */
export const QUEUE_BUCKET = {
  OVERDUE_NEW: 0,
  NEW: 1,
  CONTACTED: 2,
  VISIT_REQUESTED: 3,
  VISIT_SCHEDULED: 4,
  RE_ENGAGE: 5,
  OTHER: 6,
} as const;

/** The bucket a lead belongs to, from its state and age alone. */
export function queueBucket(row: QueueRow): number {
  const status = typeof row.status === 'string' ? row.status : '';
  if (status === 'NEW') {
    return isOverdue(row) ? QUEUE_BUCKET.OVERDUE_NEW : QUEUE_BUCKET.NEW;
  }
  if (status === 'CONTACTED') return QUEUE_BUCKET.CONTACTED;
  if (status === 'VISIT_REQUESTED') return QUEUE_BUCKET.VISIT_REQUESTED;
  if (status === 'VISIT_SCHEDULED') return QUEUE_BUCKET.VISIT_SCHEDULED;
  if (status === 'NO_SHOW' || status === 'RESCHEDULED') return QUEUE_BUCKET.RE_ENGAGE;
  return QUEUE_BUCKET.OTHER;
}

/** Oldest first inside a bucket: the longest-waiting lead is the most urgent. */
function ageAscending(a: QueueRow, b: QueueRow): number {
  const at = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) : NaN;
  const bt = typeof b.createdAt === 'string' ? Date.parse(b.createdAt) : NaN;
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return at - bt;
}

/**
 * Order the queue: bucket first, then longest-waiting first inside each bucket.
 *
 * Returns a NEW array - callers must not rely on this mutating in place.
 *
 * No injectable clock, deliberately. `isOverdue` (lib/leads.ts) reads
 * `Date.now()` itself, so a `now` parameter here could not actually reach the
 * overdue check - it would look injectable while silently bypassing it, and
 * would switch off age sorting as well. Tests control the clock with
 * `vi.setSystemTime` instead, which moves the real source of truth. Adding a
 * `now` parameter later means threading it through `isOverdue` and
 * `leadAgeTier` first.
 */
export function orderQueue<T extends { status?: string | null; createdAt?: string | null }>(
  rows: readonly T[],
): T[] {
  const withBucket = rows.map((row, index) => ({ row, index }));
  withBucket.sort((a, b) => {
    const ba = queueBucket(a.row);
    const bb = queueBucket(b.row);
    if (ba !== bb) return ba - bb;
    // Stable within a bucket: oldest first, then keep server order for exact ties.
    const age = ageAscending(a.row, b.row);
    if (age !== 0) return age;
    return a.index - b.index;
  });
  return withBucket.map((entry) => entry.row);
}

/**
 * The SLA status of a NEW lead, for the row's visible clock. Reuses the tested
 * staircase in lib/leads.ts so the dashboard, the inbox table, and the badge can
 * never disagree about what "overdue" means.
 *
 * NOTE (Decision 4 in the design doc): `leadAgeTier` and `isOverdue` are
 * deliberately NEW-only. They return null/false for every other state, because
 * measuring "age since creation" for a lead already in VISIT_SCHEDULED would be
 * a fabricated deadline. Non-NEW rows therefore show plain staleness, and this
 * helper returns null so the caller renders the staleness instead.
 */
export function slaTier(row: QueueRow): ReturnType<typeof leadAgeTier> {
  return leadAgeTier(row);
}

/** Human label for why a row is where it is. Used as the row's subtitle. */
export function queueReason(row: QueueRow): string {
  const status = typeof row.status === 'string' ? row.status : '';
  if (status === 'NEW') {
    const tier = leadAgeTier(row);
    if (tier === 'overdue') return `Overdue - no call within ${OVERDUE_AFTER_MIN} min`;
    if (tier === 'warn') return 'Call soon - clock running';
    if (tier === 'age') return 'New - call within 30 min';
    return 'Just arrived';
  }
  if (status === 'CONTACTED') return 'Picked up - move it forward';
  if (status === 'VISIT_REQUESTED') return 'Wants a visit - book it';
  if (status === 'VISIT_SCHEDULED') return 'Visit booked - confirm with them';
  if (status === 'NO_SHOW') return 'Missed the visit - re-engage';
  if (status === 'RESCHEDULED') return 'Rescheduled - book a new slot';
  return '';
}
