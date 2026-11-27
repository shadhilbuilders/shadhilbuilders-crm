// The freeform clock, in words (2026-11-27).
//
// Meta only delivers a freeform reply within 24 hours of the customer's last
// message. Staff work in this pane all day and had no way to see that clock
// except by counting back from a timestamp, so the window is rendered as time
// left: "3h 12m", not "expires at 18:42".
//
// The arithmetic is the shared one (serviceWindowExpiry), so the countdown and
// the composer gate can never disagree about when the window closes.

import { serviceWindowExpiry } from '@shadhil/api-types';

export type WindowTone = 'calm' | 'soon' | 'imminent';

export interface WindowRemaining {
  ms: number;
  label: string;
  tone: WindowTone;
  closesAt: Date;
}

/** Under an hour is worth an amber note; under ten minutes is worth a red one. */
const SOON_MS = 60 * 60 * 1000;
const IMMINENT_MS = 10 * 60 * 1000;

/**
 * Time left in the freeform window, or null when the clock is not running: no
 * inbound message ever, a timestamp that will not parse, or a window already
 * closed (the closed notice owns that case).
 */
export function windowRemaining(
  lastInboundAt: string | Date | null | undefined,
  now: Date = new Date(),
): WindowRemaining | null {
  const closesAt = serviceWindowExpiry(lastInboundAt);
  if (closesAt === null) return null;
  const ms = closesAt.getTime() - now.getTime();
  if (ms <= 0) return null;
  return { ms, label: formatRemaining(ms), tone: toneFor(ms), closesAt };
}

/**
 * Hours and minutes, rounded DOWN so the pane never promises more time than is
 * left. Seconds are noise at this scale; under a minute says so instead of "0m".
 */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function toneFor(ms: number): WindowTone {
  if (ms <= IMMINENT_MS) return 'imminent';
  if (ms <= SOON_MS) return 'soon';
  return 'calm';
}

/** One sentence for the pane. Plain, and specific about what closes. */
export function remainingSentence(remaining: WindowRemaining): string {
  return `Freeform replies close in ${remaining.label}`;
}
