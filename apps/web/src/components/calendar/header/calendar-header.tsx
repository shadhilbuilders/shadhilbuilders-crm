'use client';

// CalendarHeader (adapted from lramos33/big-calendar to a single-page
// view switcher + @paalstack/react-ui). Renders the Today button, date
// navigator, view switcher, and exec filter.
import {
  LuCalendarRange,
  LuColumns4,
  LuGrid2X2,
  LuGrid3X3,
  LuList,
} from '@paalstack/react-icons/lu';
import { Button } from '@paalstack/react-ui';

import { UserSelect } from './user-select';
import { TodayButton } from './today-button';
import { DateNavigator } from './date-navigator';

import type { IEvent } from '../interfaces';
import type { TCalendarView } from '../types';

interface IProps {
  view: TCalendarView;
  onViewChange: (view: TCalendarView) => void;
  events: IEvent[];
}

const VIEWS: { key: TCalendarView; label: string; icon: React.ReactNode }[] = [
  { key: 'day', label: 'Day', icon: <LuList strokeWidth={1.8} /> },
  { key: 'week', label: 'Week', icon: <LuColumns4 strokeWidth={1.8} /> },
  { key: 'month', label: 'Month', icon: <LuGrid2X2 strokeWidth={1.8} /> },
  { key: 'year', label: 'Year', icon: <LuGrid3X3 strokeWidth={1.8} /> },
  { key: 'agenda', label: 'Agenda', icon: <LuCalendarRange strokeWidth={1.8} /> },
];

export function CalendarHeader({ view, onViewChange, events }: IProps) {
  return (
    <div className="flex flex-col gap-4 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        <TodayButton />
        <DateNavigator view={view} events={events} />
      </div>

      <div className="flex flex-col items-center gap-1.5 sm:flex-row sm:justify-between">
        <div className="flex w-full items-center gap-1.5">
          <div className="inline-flex first:rounded-r-none last:rounded-l-none [&:not(:first-child):not(:last-child)]:rounded-none">
            {VIEWS.map((v, index) => (
              <Button
                key={v.key}
                aria-label={`View by ${v.label.toLowerCase()}`}
                size="icon"
                variant={view === v.key ? 'default' : 'outline'}
                className={`[&_svg]:size-5 ${
                  index === 0
                    ? 'rounded-r-none'
                    : index === VIEWS.length - 1
                      ? '-ml-px rounded-l-none'
                      : '-ml-px rounded-none'
                }`}
                onClick={() => onViewChange(v.key)}
              >
                {v.icon}
              </Button>
            ))}
          </div>

          <UserSelect />
        </div>
      </div>
    </div>
  );
}
