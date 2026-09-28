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
import { useMemo, useState } from 'react';

import { toast } from '@paalstack/react-ui';

import { CalendarProvider } from './calendar-context';
import { ClientContainer } from './client-container';
import { useRescheduleVisit, useVisits } from '@/hooks/queries/crm';

import type { IEvent, IUser } from './interfaces';
import type { TCalendarView } from './types';

// Stable color per exec so the calendar color-codes by the visit's exec
// (matches the original wireframe's "color-coded by exec"). Note this is
// `SiteVisit.userId`, NOT the lead's owner - the two differ on a scheduled
// visit, where the telecaller still owns the lead (plan §3). T-VISIT-OWNER-LABEL
// (2026-09-28) renamed the surrounding wording after the dashboard printed the
// exec under an unlabelled column that read as "owner".
const EXEC_COLORS = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'orange',
  'gray',
] as const;

type VisitRow = {
  id: string;
  leadId: string;
  leadName: string;
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
}: {
  projectId: string | undefined;
  /** The active week (Monday-start). Drives the fetch range + calendar view. */
  weekStart: Date;
  onWeekStartChange: (date: Date) => void;
  onSlotClick: (date: Date) => void;
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
  const visitsQuery = useVisits({ projectId, limit: 200 });
  const reschedule = useRescheduleVisit();

  // Project-scoped users: derive from the project's visits (each visit
  // carries userId/userName). This shows only execs actually linked to this
  // project, not every user in the org.
  const users = useMemo<IUser[]>(() => {
    const rows = visitsQuery.data;
    if (!Array.isArray(rows)) return [];
    const seen = new Map<string, IUser>();
    for (const visit of rows as VisitRow[]) {
      if (visit.userId.length === 0 || seen.has(visit.userId)) continue;
      seen.set(visit.userId, {
        id: visit.userId,
        name: visit.userName || 'Unassigned',
        picturePath: null,
      });
    }
    return [...seen.values()];
  }, [visitsQuery.data]);

  const colorByUserId = useMemo(() => {
    const map = new Map<string, (typeof EXEC_COLORS)[number]>();
    users.forEach((u, i) => {
      const color = EXEC_COLORS[i % EXEC_COLORS.length];
      if (color) map.set(u.id, color);
    });
    return map;
  }, [users]);

  const events = useMemo<IEvent[]>(() => {
    const rows = visitsQuery.data;
    if (!Array.isArray(rows)) return [];
    return (rows as VisitRow[]).map((visit) => {
      const start = new Date(visit.scheduledFor);
      const end = new Date(start.getTime() + VISIT_DURATION_MS);
      return {
        id: visit.id,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        title: visit.leadName || visit.leadId,
        color: colorByUserId.get(visit.userId) ?? 'gray',
        description: visit.notes ?? '',
        user: {
          id: visit.userId,
          name: visit.userName || 'Unassigned',
          picturePath: null,
        },
      };
    });
  }, [visitsQuery.data, colorByUserId]);

  const handleUpdateEvent = (event: IEvent) => {
    // Drag-and-drop reschedule. The server requires scheduledFor in the
    // future; dragging a past visit will 400 (correct behavior).
    reschedule.mutate(
      {
        visitId: event.id,
        scheduledFor: event.startDate,
      },
      {
        onError: (e) => {
          toast.error(e instanceof Error ? e.message : 'Reschedule failed');
        },
      },
    );
  };

  return (
    <CalendarProvider
      users={users}
      events={events}
      onUpdateEvent={handleUpdateEvent}
      onSlotClick={onSlotClick}
      selectedDate={weekStart}
      onSelectedDateChange={onWeekStartChange}
    >
      <ClientContainer view={view} onViewChange={setView} />
    </CalendarProvider>
  );
}
