'use client';

import { LuCheck, LuClock, LuCircleAlert } from '@paalstack/react-icons/lu';
import { cn } from '@paalstack/react-ui/lib';

type State = 'saved' | 'queued' | 'uploaded' | 'failed';

const ICONS: Record<State, typeof LuCheck> = {
  saved: LuCheck,
  queued: LuClock,
  uploaded: LuCheck,
  failed: LuCircleAlert,
};

const LABELS: Record<State, string> = {
  saved: 'Saved',
  queued: 'Queued',
  uploaded: 'Uploaded',
  failed: 'Failed',
};

const VARIANTS: Record<State, string> = {
  saved: 'bg-muted text-muted-foreground',
  queued: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  uploaded: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
  failed: 'bg-destructive/15 text-destructive',
};

/**
 * Photo status chip (D5). Renders one of four states:
 *   - saved:    photo is in IDB, mutation not yet enqueued
 *   - queued:   mutation enqueued, not yet sent
 *   - uploaded: server returned 2xx
 *   - failed:   server returned 4xx (caller decides how to retry)
 *
 * `prefers-reduced-motion: reduce` disables the color transition via
 * the `motion-reduce:transition-none` utility. The chip's role is
 * `status`; the aria-live region is `polite` for normal transitions
 * and `assertive` for failures.
 */
export const PhotoStatusChip = ({ state }: { state: State }) => {
  const Icon = ICONS[state];
  return (
    <span
      className={cn(
        'motion-reduce:transition-none inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors',
        VARIANTS[state],
      )}
      role="status"
      aria-live={state === 'failed' ? 'assertive' : 'polite'}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {LABELS[state]}
    </span>
  );
};
