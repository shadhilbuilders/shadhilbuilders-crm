// DateNavigator (vendored from lramos33/big-calendar, adapted to
// @paalstack/react-ui + @paalstack/react-icons). Prev/next + range label.
import { useMemo } from 'react';
import { formatDate } from 'date-fns';

import { LuChevronLeft, LuChevronRight } from '@paalstack/react-icons/lu';
import { Badge, Button } from '@paalstack/react-ui';

import { useCalendar } from '../calendar-context';
import { getEventsCount, navigateDate, rangeText } from '../helpers';

import type { IEvent } from '../interfaces';
import type { TCalendarView } from '../types';

interface IProps {
  view: TCalendarView;
  events: IEvent[];
}

export function DateNavigator({ view, events }: IProps) {
  const { selectedDate, setSelectedDate } = useCalendar();

  const month = formatDate(selectedDate, 'MMMM');
  const year = selectedDate.getFullYear();

  const eventCount = useMemo(
    () => getEventsCount(events, selectedDate, view),
    [events, selectedDate, view],
  );

  const handlePrevious = () => setSelectedDate(navigateDate(selectedDate, view, 'previous'));
  const handleNext = () => setSelectedDate(navigateDate(selectedDate, view, 'next'));

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold">
          {month} {year}
        </span>
        <Badge variant="outline" className="px-1.5">
          {eventCount} events
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          className="size-6.5 px-0 [&_svg]:size-4.5"
          aria-label="Previous period"
          data-qa="calendar-prev"
          onClick={handlePrevious}
        >
          <LuChevronLeft />
        </Button>

        <p className="text-muted-foreground text-sm">{rangeText(view, selectedDate)}</p>

        <Button
          variant="outline"
          className="size-6.5 px-0 [&_svg]:size-4.5"
          aria-label="Next period"
          data-qa="calendar-next"
          onClick={handleNext}
        >
          <LuChevronRight />
        </Button>
      </div>
    </div>
  );
}
