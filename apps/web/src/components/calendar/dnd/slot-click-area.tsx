'use client';

// SlotClickArea - replaces the upstream demo's AddEventDialog. Renders a
// clickable strip over an empty time slot that calls the calendar's
// `onSlotClick` (wired by the page to the real ScheduleVisitDialog).
import { useCalendar } from '../calendar-context';

interface IProps {
  date: Date;
  hour: number;
  minute: number;
  className?: string;
}

export function SlotClickArea({ date, hour, minute, className }: IProps) {
  const { onSlotClick } = useCalendar();

  const handleClick = () => {
    const slotDate = new Date(date);
    slotDate.setHours(hour, minute, 0, 0);
    onSlotClick?.(slotDate);
  };

  return (
    <div
      className={`absolute cursor-pointer transition-colors hover:bg-accent ${className ?? ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`Schedule visit at ${hour}:${String(minute).padStart(2, '0')}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    />
  );
}
