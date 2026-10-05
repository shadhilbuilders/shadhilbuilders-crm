'use client';

// SiteVisitCalendar - the site-visit page's calendar, powered by the
// vendored big-calendar views (src/components/calendar). Maps real visit
// rows to the calendar's IEvent shape and wires drag-and-drop reschedule
// + slot-click to the real API.
//
// The page owns `weekStart` (its Prev/Next buttons shift it). That value is
// passed in here as the calendar's controlled `selectedDate`, so the page's
// Prev/Next drive BOTH the fetch range (from/to) AND the calendar view -
// otherwise the buttons would refetch data but the view wouldn't move.
import { addWeeks, endOfMonth, endOfYear, startOfMonth, startOfYear, subWeeks } from 'date-fns';
import { useMemo, useState } from 'react';

import { toast } from '@paalstack/react-ui';

import { Skeleton } from '@/components/shared/Skeleton';
import { CalendarProvider } from './calendar-context';
import { ClientContainer } from './client-container';
import { leadSyncNoteOf, useRescheduleVisit, useVisitsInRange } from '@/hooks/queries/crm';
import { isUpcomingVisitForLead, toVisitEventMeta, visitStatusColor } from '@/lib/visit-status';

import type { IEvent, IUser } from './interfaces';
import type { TCalendarView } from './types';

// Exec colours used to live here and tint each visit by WHICH exec owned it.
// Removed 2026-09-29: the exec's name is already printed on every card, so the
// colour was spent on the one property that was readable anyway, while the visit
// OUTCOME (the thing operators actually cannot see) had no visual at all. Colour
// now encodes status - see lib/visit-status.ts.

type VisitRow = {
  id: string;
  leadId: string;
  leadName: string;
  /** The lead's pipeline state, from the API - shown as the visit's status. */
  leadState: string;
  scheduledFor: string;
  userId: string;
  userName: string;
  status: string;
  outcome: string | null;
  notes: string | null;
  updatedAt: string;
};

const VISIT_DURATION_MS = 60 * 60 * 1000; // 1 hour default

export function SiteVisitCalendar({
  projectId,
  weekStart,
  onWeekStartChange,
  onSlotClick,
  showPast,
}: {
  projectId: string | undefined;
  /** The active week (Monday-start). Drives the fetch range + calendar view. */
  weekStart: Date;
  onWeekStartChange: (date: Date) => void;
  onSlotClick: (date: Date) => void;
  /** Include closed visits (history). Default false - upcoming work only. */
  showPast?: boolean;
}) {
  // T-VISITS-AGENDA-DEFAULT (2026-09-16, owner request): agenda is the default
  // view, not the week grid.
  //
  // WHY: this page answers "what visits do I have coming up?" - a question the
  // week grid answers badly. The grid needs a visit to fall inside the visible
  // 7-day window (the page fetches a week at a time), so a visit scheduled next
  // month is invisible on load and reads as "no visits". The agenda lists
  // upcoming visits across the range regardless of which week they land in.
  //
  // The grid is still one click away - the header's view switcher is unchanged -
  // so nothing is lost, and `view` remains local state, so a user's choice is not
  // persisted and each visit to the page starts on the agenda.
  const [view, setView] = useState<TCalendarView>('agenda');
  // Fetch exactly what the view can show, paged to completion (no row cap).
  // Year view needs the year; every other view fits in the selected month plus
  // a week either side (month-grid leading/trailing cells, weeks that straddle
  // a month boundary).
  // Anchor = start of the visible month/year, as a number: stable across days
  // within the period (no refetch per day) and not a fresh Date each render.
  const anchorTime = (view === 'year' ? startOfYear(weekStart) : startOfMonth(weekStart)).getTime();
  const range = useMemo(() => {
    const anchor = new Date(anchorTime);
    const start = view === 'year' ? anchor : subWeeks(anchor, 1);
    const end = view === 'year' ? endOfYear(anchor) : addWeeks(endOfMonth(anchor), 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [view, anchorTime]);
  const visitsQuery = useVisitsInRange({ ...range, projectId });
  const reschedule = useRescheduleVisit();

  /**
   * OWNER DIRECTION (2026-09-29): "In visits page only show scheduled visit and
   * rescheduled visit and upcoming visit data".
   *
   * The default view is therefore OPEN visits on NON-TERMINAL leads. The second
   * half of that is 2026-09-30: a settled deal (WON/LOST/RNR) keeps its visit OPEN
   * by design - the handover may still be owed - so `isUpcomingVisit` alone still
   * answered "yes" and a won deal's long-past visit rendered as live work
   * indefinitely. `isUpcomingVisitForLead` adds the lead's state; the row stays
   * reachable behind the Show-past toggle.
   *
   * Filtered HERE rather than by the API's `status` filter (or any new lead-state
   * filter) for two reasons:
   *   1. One fetch feeds both modes, so toggling must not refetch.
   *   2. `GET /api/visits` is SHARED with LeadVisitPanel, which needs a won deal's
   *      handover visit to stay visible on the lead page. Excluding it at the
   *      endpoint would break that page; this exclusion is a property of THIS
   *      view, not of the data.
   */
  const rows = useMemo<VisitRow[]>(() => {
    const data = visitsQuery.data;
    if (!Array.isArray(data)) return [];
    const all = data as VisitRow[];
    return showPast === true ? all : all.filter((v) => isUpcomingVisitForLead(v));
  }, [visitsQuery.data, showPast]);

  // Project-scoped users: derive from the project's visits (each visit
  // carries userId/userName). This shows only execs actually linked to this
  // project, not every user in the org.
  const users = useMemo<IUser[]>(() => {
    const seen = new Map<string, IUser>();
    for (const visit of rows) {
      if (visit.userId.length === 0 || seen.has(visit.userId)) continue;
      seen.set(visit.userId, {
        id: visit.userId,
        name: visit.userName || 'Unassigned',
        picturePath: null,
      });
    }
    return [...seen.values()];
  }, [visitsQuery.data]);

  const events = useMemo<IEvent[]>(() => {
    return rows.map((visit) => {
      const start = new Date(visit.scheduledFor);
      const end = new Date(start.getTime() + VISIT_DURATION_MS);
      return {
        id: visit.id,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        title: visit.leadName || visit.leadId,
        // COLOUR = OUTCOME, not exec (2026-09-29 owner request). The exec's name
        // is printed on the card, so colour spent on identity was spent twice;
        // status was the genuinely invisible property. See lib/visit-status.ts
        // for the full rationale and the mapping.
        color: visitStatusColor(visit.status, visit.outcome),
        description: visit.notes ?? '',
        user: {
          id: visit.userId,
          name: visit.userName || 'Unassigned',
          picturePath: null,
        },
        visit: toVisitEventMeta(visit),
      };
    });
    // Depends on `rows`, NOT `visitsQuery.data`. `rows` is the filtered view and
    // the whole point of the Show-past toggle: keying this memo on the raw query
    // data meant toggling the switch recomputed `rows` but NOT `events`, so the
    // calendar rendered events from whichever filter was active on first render
    // and the toggle appeared to do nothing (caught by the e2e probe: the API
    // returned all 3 visits while the grid showed "0 events" in both modes).
  }, [rows]);

  const handleUpdateEvent = (event: IEvent) => {
    // Drag-and-drop reschedule. The server requires scheduledFor in the
    // future; dragging a past visit will 400 (correct behavior).
    reschedule.mutate(
      {
        visitId: event.id,
        scheduledFor: event.startDate,
      },
      {
        onSuccess: (data) => {
          // T-LEAD-SYNC-COVERAGE (2026-09-30): the move can land on the visit
          // without the lead following. The drag itself gives no other feedback, so
          // say it here rather than leaving the two screens to disagree silently.
          const note = leadSyncNoteOf(data);
          if (note !== null) toast.info(note);
        },
        onError: (e) => {
          toast.error(e instanceof Error ? e.message : 'Reschedule failed');
        },
      },
    );
  };

  if (visitsQuery.isLoading) {
    return <Skeleton variant="card" />;
  }

  return (
    <CalendarProvider
      users={users}
      events={events}
      // T-PAST-VISIT-SURFACE (2026-09-30): the cards render a closed visit's
      // outcome as a solid coloured surface, which is the right signal on a live
      // calendar and noise across a wall of history. The mode is passed down so
      // each card can drop that surface and keep the outcome as a left border.
      isPastView={showPast === true}
      onUpdateEvent={handleUpdateEvent}
      onSlotClick={onSlotClick}
      selectedDate={weekStart}
      onSelectedDateChange={onWeekStartChange}
    >
      <ClientContainer view={view} onViewChange={setView} />
    </CalendarProvider>
  );
}
