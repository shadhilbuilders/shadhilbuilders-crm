'use client';

// useUpdateEvent (adapted from lramos33/big-calendar). Updates an event
// optimistically in local state, then calls an optional `onUpdateEvent`
// callback so the parent can persist the reschedule to the real API.
import { useCalendar } from '../calendar-context';

import type { IEvent } from '../interfaces';

export function useUpdateEvent() {
  const { setLocalEvents, onUpdateEvent } = useCalendar();

  const updateEvent = (event: IEvent) => {
    const newEvent: IEvent = {
      ...event,
      startDate: new Date(event.startDate).toISOString(),
      endDate: new Date(event.endDate).toISOString(),
    };

    setLocalEvents((prev) => {
      const index = prev.findIndex((e) => e.id === event.id);
      if (index === -1) return prev;
      return [...prev.slice(0, index), newEvent, ...prev.slice(index + 1)];
    });

    // Persist the reschedule to the real API (parent refetches on success).
    onUpdateEvent?.(newEvent);
  };

  return { updateEvent };
}
