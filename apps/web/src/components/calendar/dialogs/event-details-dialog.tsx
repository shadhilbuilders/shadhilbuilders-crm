'use client';

// EventDetailsDialog (adapted from lramos33/big-calendar to
// @paalstack/react-ui). Shows a read-only detail view of a visit event.
import { format, parseISO } from 'date-fns';

import { LuCalendar, LuClock, LuText, LuUser } from '@paalstack/react-icons/lu';
import { Dialog } from '@paalstack/react-ui';

import type { IEvent } from '../interfaces';

interface IProps {
  event: IEvent;
  children: React.ReactNode;
}

export function EventDetailsDialog({ event, children }: IProps) {
  const startDate = parseISO(event.startDate);
  const endDate = parseISO(event.endDate);

  return (
    <Dialog
      trigger={children}
      contentClassName='sm:max-w-lg'
      header={{ title: event.title }}
      footer={
        <span className="text-muted-foreground text-xs">
          {event.user.name}
        </span>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <LuUser className="mt-1 size-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">Responsible</p>
            <p className="text-muted-foreground text-sm">{event.user.name}</p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <LuCalendar className="mt-1 size-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">Start Date</p>
            <p className="text-muted-foreground text-sm">
              {format(startDate, 'MMM d, yyyy h:mm a')}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <LuClock className="mt-1 size-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">End Date</p>
            <p className="text-muted-foreground text-sm">
              {format(endDate, 'MMM d, yyyy h:mm a')}
            </p>
          </div>
        </div>

        {event.description.length > 0 && (
          <div className="flex items-start gap-2">
            <LuText className="mt-1 size-4 shrink-0" />
            <div>
              <p className="text-sm font-medium">Description</p>
              <p className="text-muted-foreground text-sm">{event.description}</p>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
