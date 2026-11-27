'use client';

// The freeform window as a live countdown (2026-11-27). Sits above the composer
// so a staff member answering messages can see how long they have before Meta
// stops delivering plain text. The closed case is not this component's job: the
// pane already replaces the composer with a notice once the window shuts.
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

const TICK_MS = 30_000;

const TONE_CLASS: Record<WindowRemaining['tone'], string> = {
  calm: 'text-muted-foreground',
  soon: 'text-amber-600',
  imminent: 'text-destructive',
};

export function ChatWindowCountdown({ lastInboundAt, now }: ChatWindowCountdownProps) {
  const [clock, setClock] = useState<Date>(() => now ?? new Date());

  // Re-render every half minute so "3h 12m" is never more than a half minute
  // stale, and stop the timer when the component goes away.
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setClock(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, [now]);

  const remaining = windowRemaining(lastInboundAt, now ?? clock);
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
