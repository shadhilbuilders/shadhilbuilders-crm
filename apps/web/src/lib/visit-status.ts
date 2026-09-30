// Visit status → calendar colour, and the calendar's event shape.
//
// WHY THIS FILE EXISTS (2026-09-29, owner request: "if visit happened use green
// color and if visit not happened show red color and if visit is reschedule show
// yellow").
//
// The calendar used to colour every event by WHICH EXEC owned it
// (`EXEC_COLORS[i % 7]` in site-visit-calendar.tsx). That is the one property an
// operator does NOT need colour for: the exec's name is printed on the card
// anyway. What was genuinely invisible was the OUTCOME - a completed visit, a
// no-show and a cancelled visit all rendered as an identical blue block, so the
// page could not answer "what actually happened?" without opening every row.
//
// So colour now means OUTCOME, and exec identity stays where it already is (the
// user chip on the card). This mirrors LeadStatusBadge, which is the repo's
// existing "status → colour class" lookup.
//
// It lives in lib/ rather than inside the component for two reasons:
//   1. site-visit-calendar.tsx is a client component that cannot be rendered in
//      the unit suite without its query hooks, so anything defined there is
//      effectively untested. These two functions are the whole of the new
//      behaviour and they ARE testable.
//   2. The mapping is a contract with the backend enum (`VisitStatus` in
//      packages/api-types/src/enums.ts). One place to change, one place to pin.
import type { TEventColor } from '@/components/calendar/types';

/**
 * The calendar's palette, mapped from the visit status. Deliberately exhaustive
 * over the five `VisitStatus` values - a new enum member must be added here
 * rather than silently falling through to a default that hides it.
 *
 *   COMPLETED   green   - the visit happened
 *   NO_SHOW     red     - it did not happen
 *   CANCELLED   red     - it did not happen (owner named green/red/yellow; a
 *                         cancelled visit belongs on the red side of that split,
 *                         and it is a closed row like NO_SHOW)
 *   RESCHEDULED yellow  - it moved; the row is closed but work continues
 *   SCHEDULED   blue    - NOT YET DUE. Deliberately not red: a future visit has
 *                         not failed, and painting every upcoming visit red
 *                         would make the calendar look permanently broken.
 *
 * `gray` is unreachable from a real status and exists only as the fallback for
 * an unknown value (a newer backend enum the web app has not shipped for yet) -
 * an unknown status should look neutral, never like a confident colour claim.
 */
const VISIT_STATUS_COLOR: Readonly<Record<string, TEventColor>> = {
  COMPLETED: 'green',
  NO_SHOW: 'red',
  CANCELLED: 'red',
  RESCHEDULED: 'yellow',
  SCHEDULED: 'blue',
};

/**
 * The colour for a visit row. `status` is the OPEN/CLOSED lifecycle state
 * (`SiteVisit.status`); `outcome` is what happened on site. The service sets
 * both on a recorded outcome (`status = dto.outcome` in visits.service.ts), so
 * status alone is authoritative - but an older row can carry an outcome while
 * still reading SCHEDULED, and in that case the outcome is the true story, so
 * it wins.
 */
export function visitStatusColor(
  status: string | null | undefined,
  outcome?: string | null,
): TEventColor {
  const key = typeof outcome === 'string' && outcome.length > 0 ? outcome : status;
  if (typeof key !== 'string' || key.length === 0) return 'gray';
  return VISIT_STATUS_COLOR[key] ?? 'gray';
}

/** True when this row is finished (no further on-site outcome can be recorded). */
export function isVisitClosed(status: string | null | undefined): boolean {
  return status === 'COMPLETED' || status === 'NO_SHOW' || status === 'CANCELLED';
}

/**
 * A visit row exactly as `GET /api/visits` returns it (the fields the calendar
 * consumes). Kept here so the mapper below and its test share one shape instead
 * of the component declaring a private copy.
 */
export type VisitApiRow = {
  id: string;
  leadId: string;
  leadName: string;
  /** The lead's pipeline state, sent by the API so both pages agree. */
  leadState: string;
  scheduledFor: string;
  userId: string;
  userName: string;
  status: string;
  outcome: string | null;
  notes: string | null;
  updatedAt: string;
};

/** The extra, visit-specific fields the calendar carries on each event. */
export type VisitEventMeta = {
  status: string;
  outcome: string | null;
  leadId: string;
  /**
   * The LEAD's pipeline state, carried so the visits page and the lead page show
   * the SAME status word for the same event (owner requirement, 2026-09-29). The
   * backend sends it on every visit row as `leadState`.
   */
  leadState: string;
};

/**
 * Map a visit row to the calendar's event shape.
 *
 * `leadId` is carried through because the detail dialog deep-links to the lead,
 * and it needs the id (not just the name it already prints). Before this the
 * event dropped `leadId`, `status` and `outcome` entirely, which is exactly why
 * the dialog could not show an outcome or offer a reschedule.
 */
export function toVisitEventMeta(visit: VisitApiRow): VisitEventMeta {
  return {
    status: visit.status,
    outcome: visit.outcome,
    leadId: visit.leadId,
    leadState: visit.leadState,
  };
}

/**
 * True when a visit should appear in the page's DEFAULT (upcoming) view.
 *
 * OWNER DIRECTION (2026-09-29): "In visits page only show scheduled visit and
 * rescheduled visit and upcoming visit data." So an open visit that has not yet
 * happened is in; anything closed is history and appears only when the "Show
 * past" toggle is on.
 *
 * The status is what decides, NOT the clock: a SCHEDULED visit whose slot has
 * already passed is still open work (nobody recorded an outcome), and hiding it
 * would make genuine un-actioned work disappear from the one page built to show
 * it. That is also how the admin "Visits at risk" card treats them - overdue, not
 * gone.
 */
export function isUpcomingVisit(status: string | null | undefined): boolean {
  return status === 'SCHEDULED' || status === 'RESCHEDULED';
}

