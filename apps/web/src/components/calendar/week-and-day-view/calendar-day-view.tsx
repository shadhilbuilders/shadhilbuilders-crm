// CalendarDayView (vendored from lramos33/big-calendar, adapted to
// @paalstack/react-ui + relative imports). The single-day view with a
// side date picker + "happening now" panel.
import { useEffect, useState } from 'react';
import { LuCalendar, LuClock, LuUser } from '@paalstack/react-icons/lu';
import { parseISO, areIntervalsOverlapping, format } from 'date-fns';

import { Calendar, ScrollArea } from '@paalstack/react-ui';
import { cn } from '@paalstack/react-ui/lib';

import { useCalendar } from '../calendar-context';
import { EventBlock } from './event-block';
import { DroppableTimeBlock } from '../dnd/droppable-time-block';
import { SlotClickArea } from '../dnd/slot-click-area';
import { CalendarTimeline } from './calendar-time-line';
import { DayViewMultiDayEventsRow } from './day-view-multi-day-events-row';
import { groupEvents, getEventBlockStyle, isWorkingHour, getCurrentEvents, getVisibleHours } from '../helpers';

import type { IEvent } from '../interfaces';

interface IProps {
  singleDayEvents: IEvent[];
  multiDayEvents: IEvent[];
}

export function CalendarDayView({ singleDayEvents, multiDayEvents }: IProps) {
  const { selectedDate, setSelectedDate, users, visibleHours, workingHours } = useCalendar();
  const [, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const { hours, earliestEventHour, latestEventHour } = getVisibleHours(
    visibleHours,
    singleDayEvents,
  );

  const currentEvents = getCurrentEvents(singleDayEvents);

  const dayEvents = singleDayEvents.filter((event) => {
    const eventDate = parseISO(event.startDate);
    return (
      eventDate.getDate() === selectedDate.getDate() &&
      eventDate.getMonth() === selectedDate.getMonth() &&
      eventDate.getFullYear() === selectedDate.getFullYear()
    );
  });

  const groupedEvents = groupEvents(dayEvents);

  return (
    <div className="flex">
      <div className="flex flex-1 flex-col">
        <div>
          <DayViewMultiDayEventsRow selectedDate={selectedDate} multiDayEvents={multiDayEvents} />

          {/* Day header */}
          <div className="relative z-20 flex border-b">
            <div className="w-18"></div>
            <span className="text-muted-foreground flex-1 border-l py-2 text-center text-xs font-medium">
              {format(selectedDate, 'EE')}{' '}
              <span className="text-foreground font-semibold">{format(selectedDate, 'd')}</span>
            </span>
          </div>
        </div>

        <ScrollArea className="h-[800px]">
          <div className="flex">
            {/* Hours column */}
            <div className="relative w-18">
              {hours.map((hour, index) => (
                <div key={hour} className="relative" style={{ height: '96px' }}>
                  <div className="absolute -top-3 right-2 flex h-6 items-center">
                    {index !== 0 && (
                      <span className="text-muted-foreground text-xs">
                        {format(new Date().setHours(hour, 0, 0, 0), 'hh a')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="relative flex-1 border-l">
              <div className="relative">
                {hours.map((hour, index) => {
                  const isDisabled = !isWorkingHour(selectedDate, hour, workingHours);

                  return (
                    <div
                      key={hour}
                      className={cn('relative', isDisabled && 'bg-calendar-disabled-hour')}
                      style={{ height: '96px' }}
                    >
                      {index !== 0 && (
                        <div className="pointer-events-none absolute inset-x-0 top-0 border-b"></div>
                      )}

                      <DroppableTimeBlock date={selectedDate} hour={hour} minute={0}>
                        <SlotClickArea
                          date={selectedDate}
                          hour={hour}
                          minute={0}
                          className="inset-x-0 top-0 h-[24px]"
                        />
                      </DroppableTimeBlock>

                      <DroppableTimeBlock date={selectedDate} hour={hour} minute={15}>
                        <SlotClickArea
                          date={selectedDate}
                          hour={hour}
                          minute={15}
                          className="inset-x-0 top-[24px] h-[24px]"
                        />
                      </DroppableTimeBlock>

                      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-b border-dashed"></div>

                      <DroppableTimeBlock date={selectedDate} hour={hour} minute={30}>
                        <SlotClickArea
                          date={selectedDate}
                          hour={hour}
                          minute={30}
                          className="inset-x-0 top-[48px] h-[24px]"
                        />
                      </DroppableTimeBlock>

                      <DroppableTimeBlock date={selectedDate} hour={hour} minute={45}>
                        <SlotClickArea
                          date={selectedDate}
                          hour={hour}
                          minute={45}
                          className="inset-x-0 top-[72px] h-[24px]"
                        />
                      </DroppableTimeBlock>
                    </div>
                  );
                })}

                {groupedEvents.map((group, groupIndex) =>
                  group.map((event) => {
                    let style = getEventBlockStyle(event, selectedDate, groupIndex, groupedEvents.length, {
                      from: earliestEventHour,
                      to: latestEventHour,
                    });
                    const hasOverlap = groupedEvents.some(
                      (otherGroup, otherIndex) =>
                        otherIndex !== groupIndex &&
                        otherGroup.some((otherEvent) =>
                          areIntervalsOverlapping(
                            { start: parseISO(event.startDate), end: parseISO(event.endDate) },
                            { start: parseISO(otherEvent.startDate), end: parseISO(otherEvent.endDate) },
                          ),
                        ),
                    );

                    if (!hasOverlap) style = { ...style, width: '100%', left: '0%' };

                    return (
                      <div key={event.id} className="absolute p-1" style={style}>
                        <EventBlock event={event} />
                      </div>
                    );
                  }),
                )}
              </div>

              <CalendarTimeline firstVisibleHour={earliestEventHour} lastVisibleHour={latestEventHour} />
            </div>
          </div>
        </ScrollArea>
      </div>

      <div className="hidden w-64 divide-y border-l md:block">
        <Calendar
          className="mx-auto w-fit"
          mode="single"
          selected={selectedDate}
          onSelect={setSelectedDate}
          initialFocus
        />

        <div className="flex-1 space-y-3">
          {currentEvents.length > 0 ? (
            <div className="flex items-start gap-2 px-4 pt-4">
              <span className="relative mt-[5px] flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex size-2.5 rounded-full bg-green-600"></span>
              </span>

              <p className="text-foreground text-sm font-semibold">Happening now</p>
            </div>
          ) : (
            <p className="text-muted-foreground p-4 text-center text-sm italic">
              No appointments or consultations at the moment
            </p>
          )}

          {currentEvents.length > 0 && (
            <ScrollArea className="h-[422px] px-4">
              <div className="space-y-6 pb-4">
                {currentEvents.map((event) => {
                  const user = users.find((u) => u.id === event.user.id);

                  return (
                    <div key={event.id} className="space-y-1.5">
                      <p className="line-clamp-2 text-sm font-semibold">{event.title}</p>

                      {user && (
                        <div className="text-muted-foreground flex items-center gap-1.5">
                          <LuUser className="size-3.5" />
                          <span className="text-sm">{user.name}</span>
                        </div>
                      )}

                      <div className="text-muted-foreground flex items-center gap-1.5">
                        <LuCalendar className="size-3.5" />
                        <span className="text-sm">{format(new Date(), 'MMM d, yyyy')}</span>
                      </div>

                      <div className="text-muted-foreground flex items-center gap-1.5">
                        <LuClock className="size-3.5" />
                        <span className="text-sm">
                          {format(parseISO(event.startDate), 'h:mm a')} -{' '}
                          {format(parseISO(event.endDate), 'h:mm a')}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
