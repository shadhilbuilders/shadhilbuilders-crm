'use client';

// Calendar context (vendored from lramos33/big-calendar, adapted to the
// shadhil-crm stack). Holds the shared calendar UI state (selected date,
// user filter, badge variant, working/visible hours) plus the events list.
//
// Unlike the upstream demo (which mutates a throwaway `localEvents`), this
// version accepts an optional `onUpdateEvent` callback so drag-and-drop
// rescheduling can persist to the real API. When provided, a drop updates
// local state optimistically AND calls the callback; the parent refetches
// on success.
import { createContext, useContext, useEffect, useState } from 'react';

import type { Dispatch, SetStateAction } from 'react';
import type { IEvent, IUser } from './interfaces';
import type { TBadgeVariant, TVisibleHours, TWorkingHours } from './types';

interface ICalendarContext {
  selectedDate: Date;
  setSelectedDate: (date: Date | undefined) => void;
  selectedUserId: IUser['id'] | 'all';
  setSelectedUserId: (userId: IUser['id'] | 'all') => void;
  badgeVariant: TBadgeVariant;
  setBadgeVariant: (variant: TBadgeVariant) => void;
  users: IUser[];
  workingHours: TWorkingHours;
  setWorkingHours: Dispatch<SetStateAction<TWorkingHours>>;
  visibleHours: TVisibleHours;
  setVisibleHours: Dispatch<SetStateAction<TVisibleHours>>;
  events: IEvent[];
  setLocalEvents: Dispatch<SetStateAction<IEvent[]>>;
  /**
   * True when this calendar is showing HISTORY (the "Show past visits" mode).
   *
   * The cards render a closed visit's outcome as a solid coloured surface, which
   * is the right signal on a live calendar and noise on a wall of history. The
   * cards themselves are vendored and know nothing about past/upcoming, so the
   * mode is carried here and each card asks for it. See
   * `lib/past-event-style.ts`.
   */
  isPastView: boolean;
  /** Optional persistence hook for drag-and-drop reschedules. */
  onUpdateEvent?: (event: IEvent) => void;
  /** Optional handler for clicking an empty time slot (opens the schedule dialog). */
  onSlotClick?: (date: Date) => void;
}

const CalendarContext = createContext({} as ICalendarContext);

const WORKING_HOURS = {
  0: { from: 0, to: 0 },
  1: { from: 8, to: 17 },
  2: { from: 8, to: 17 },
  3: { from: 8, to: 17 },
  4: { from: 8, to: 17 },
  5: { from: 8, to: 17 },
  6: { from: 8, to: 12 },
};

const VISIBLE_HOURS = { from: 7, to: 18 };

export function CalendarProvider({
  children,
  users,
  events,
  isPastView = false,
  onUpdateEvent,
  onSlotClick,
  selectedDate: controlledSelectedDate,
  onSelectedDateChange,
}: {
  children: React.ReactNode;
  users: IUser[];
  events: IEvent[];
  /**
   * The calendar is in "Show past visits" mode. Defaults to false so the
   * vendored calendar's other consumers (and its own tests) keep the live
   * presentation without having to pass anything.
   */
  isPastView?: boolean;
  onUpdateEvent?: (event: IEvent) => void;
  onSlotClick?: (date: Date) => void;
  /** Controlled selected date (e.g. driven by the page's Prev/Next). */
  selectedDate?: Date;
  onSelectedDateChange?: (date: Date) => void;
}) {
  const [badgeVariant, setBadgeVariant] = useState<TBadgeVariant>('colored');
  const [visibleHours, setVisibleHours] = useState<TVisibleHours>(VISIBLE_HOURS);
  const [workingHours, setWorkingHours] = useState<TWorkingHours>(WORKING_HOURS);

  const [internalSelectedDate, setInternalSelectedDate] = useState(new Date());
  const selectedDate = controlledSelectedDate ?? internalSelectedDate;
  const [selectedUserId, setSelectedUserId] = useState<IUser['id'] | 'all'>('all');

  // Local copy so drag-and-drop can optimistically reorder before the
  // parent refetches. Re-syncs whenever the fetched `events` change.
  const [localEvents, setLocalEvents] = useState<IEvent[]>(events);

  // Keep the local (drag-optimistic) copy in sync with the fetched events.
  useEffect(() => {
    setLocalEvents(events);
  }, [events]);

  const handleSelectDate = (date: Date | undefined) => {
    if (!date) return;
    if (onSelectedDateChange) {
      onSelectedDateChange(date);
    } else {
      setInternalSelectedDate(date);
    }
  };

  return (
    <CalendarContext.Provider
      value={{
        selectedDate,
        setSelectedDate: handleSelectDate,
        selectedUserId,
        setSelectedUserId,
        badgeVariant,
        setBadgeVariant,
        users,
        visibleHours,
        setVisibleHours,
        workingHours,
        setWorkingHours,
        events: localEvents,
        setLocalEvents,
        isPastView,
        onUpdateEvent,
        onSlotClick,
      }}
    >
      {children}
    </CalendarContext.Provider>
  );
}

export function useCalendar(): ICalendarContext {
  const context = useContext(CalendarContext);
  if (!context) throw new Error('useCalendar must be used within a CalendarProvider.');
  return context;
}
