'use client';

// The freeform window as a live countdown (2026-11-27). Sits above the composer
// so a staff member answering messages can see how long they have before Meta
// stops delivering plain text. The closed case is not this component's job: both
// panes replace the composer with a notice once the window shuts.
import { useEffect, useState } from 'react';

import { LuClock } from '@paalstack/react-icons/lu';

import {
  remainingSentence,
  windowRemaining,
  type WindowRemaining,
} from '@/lib/chat/window-countdown';
import { dateIntl } from '@/lib/format';

export interface ChatWindowCountdownProps {
  lastInboundAt: string | null | undefined;
  /** Injected in tests; the pane uses the clock. */
  now?: Date;
}

const TICK_MS = 1000;

const TONE_CLASS: Record<WindowRemaining['tone'], string> = {
  calm: 'text-muted-foreground',
  soon: 'text-amber-600',
  imminent: 'text-destructive',
};

export function ChatWindowCountdown({ lastInboundAt, now }: ChatWindowCountdownProps) {
  // The clock starts as null, not `new Date()`: this renders on the server too,
  // and a server-rendered second hand either mismatches on hydration or arrives
  // already stale. One frame of nothing, then live time.
  const [clock, setClock] = useState<Date | null>(() => now ?? null);
  const injected = now !== undefined;

  // One tick a second, because the label counts seconds and a number that only
  // moves every half minute reads as stuck. Cleared when the pane goes away.
  useEffect(() => {
    if (injected) return;
    setClock(new Date());
    const timer = setInterval(() => setClock(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, [injected]);

  const remaining = clock === null ? null : windowRemaining(lastInboundAt, clock);
  if (remaining === null) return null;

  // DateIntl has no time-only helper; the pattern goes in as the format.
  const closesAt = dateIntl.format(remaining.closesAt, 'hh:mm a');

  return (
    <p
      className={`flex items-center gap-1.5 px-1 pb-1 text-xs ${TONE_CLASS[remaining.tone]}`}
      title={`Freeform replies reach the customer until ${closesAt}. After that only an approved template is delivered.`}
      data-qa="chat-window-remaining"
      data-tone={remaining.tone}
    >
      <LuClock aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        {remainingSentence(remaining)}
        <span className="sr-only">, at {closesAt}</span>
      </span>
    </p>
  );
}
