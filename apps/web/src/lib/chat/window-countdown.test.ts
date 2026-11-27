// protects=the freeform clock staff read before replying: the label rounds DOWN so
//           it never promises more time than is left, and the shared expiry decides
//           when the window is really over so the countdown and the composer gate
//           cannot disagree.
// fails_when=the label rounds up, a closed or never-opened window reports time left,
//           or the tone ignores the ten minute edge.
import { describe, expect, it } from 'vitest';

import { formatRemaining, remainingSentence, toneFor, windowRemaining } from './window-countdown';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const now = new Date('2026-11-27T10:00:00.000Z');

describe('windowRemaining', () => {
  it('reports hours and minutes left from the last inbound message', () => {
    const lastInbound = new Date(now.getTime() - 20 * HOUR - 48 * MINUTE);
    const remaining = windowRemaining(lastInbound, now);
    expect(remaining).not.toBeNull();
    expect(remaining?.label).toBe('3h 12m 0s');
    expect(remaining?.tone).toBe('calm');
    // 24h after the inbound message, which is 3h 12m from now.
    expect(remaining?.closesAt.toISOString()).toBe('2026-11-27T13:12:00.000Z');
  });

  it('is null when the customer never wrote', () => {
    expect(windowRemaining(null, now)).toBeNull();
    expect(windowRemaining(undefined, now)).toBeNull();
  });

  it('is null once the window has closed', () => {
    // The composer's closed notice owns this case; a countdown of zero is noise.
    expect(windowRemaining(new Date(now.getTime() - 25 * HOUR), now)).toBeNull();
    expect(windowRemaining(new Date(now.getTime() - 24 * HOUR), now)).toBeNull();
  });

  it('is null for a timestamp that will not parse, rather than guessing', () => {
    expect(windowRemaining('not a date', now)).toBeNull();
  });

  it('reports the amber tone inside the last hour and red inside the last ten minutes', () => {
    expect(windowRemaining(new Date(now.getTime() - 23 * HOUR - 30 * MINUTE), now)?.tone).toBe(
      'soon',
    );
    expect(windowRemaining(new Date(now.getTime() - 23 * HOUR - 55 * MINUTE), now)?.tone).toBe(
      'imminent',
    );
  });
});

describe('formatRemaining', () => {
  it('floors to the second, so the pane never promises time that has gone', () => {
    expect(formatRemaining(3 * HOUR + 12 * MINUTE + 59_000)).toBe('3h 12m 59s');
    expect(formatRemaining(HOUR + 59_000)).toBe('1h 0m 59s');
    expect(formatRemaining(59 * MINUTE + 59_000)).toBe('59m 59s');
    // The last second must read 0s and still be a countdown, not an empty label.
    expect(formatRemaining(999)).toBe('0s');
  });

  it('counts seconds, because the clock ticks once a second', () => {
    const one = formatRemaining(5 * MINUTE + 3_000);
    const two = formatRemaining(5 * MINUTE + 2_000);
    expect(one).toBe('5m 3s');
    expect(two).toBe('5m 2s');
    expect(one).not.toBe(two);
  });
});

describe('toneFor', () => {
  it('is calm above an hour, soon up to it, imminent up to ten minutes', () => {
    expect(toneFor(2 * HOUR)).toBe('calm');
    expect(toneFor(HOUR)).toBe('soon');
    expect(toneFor(11 * MINUTE)).toBe('soon');
    expect(toneFor(10 * MINUTE)).toBe('imminent');
  });
});

describe('remainingSentence', () => {
  it('names what closes, in the pane\u2019s one line', () => {
    const remaining = windowRemaining(new Date(now.getTime() - 21 * HOUR), now);
    expect(remaining).not.toBeNull();
    if (remaining !== null)
      expect(remainingSentence(remaining)).toBe('Freeform replies close in 3h 0m 0s');
  });
});
