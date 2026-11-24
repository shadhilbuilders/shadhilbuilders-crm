import { describe, expect, it } from 'vitest';

import {
  CHECKIN_MAX_LATENESS_MS,
  checkinStillWorthSending,
  nextCheckinSlot,
} from './checkin-schedule';

/** An IST wall clock reading, expressed as the instant it names. */
function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 5.5 * 60 * 60 * 1000);
}

describe('nextCheckinSlot', () => {
  it('sends straight away inside the working day', () => {
    for (const hour of [8, 11, 15, 19]) {
      const now = ist(2026, 11, 24, hour, 30);
      expect(nextCheckinSlot(now).toISOString()).toBe(now.toISOString());
    }
  });

  it('waits for the next morning after the window closes', () => {
    // 24 Nov, 20:00 IST -> 25 Nov, 08:00 IST.
    expect(nextCheckinSlot(ist(2026, 11, 24, 20, 0)).toISOString()).toBe(
      ist(2026, 11, 25, 8, 0).toISOString(),
    );
    expect(nextCheckinSlot(ist(2026, 11, 24, 20, 1)).toISOString()).toBe(
      ist(2026, 11, 25, 8, 0).toISOString(),
    );
    expect(nextCheckinSlot(ist(2026, 11, 24, 23, 59)).toISOString()).toBe(
      ist(2026, 11, 25, 8, 0).toISOString(),
    );
  });

  it('treats the last minute before the window as outside it', () => {
    expect(nextCheckinSlot(ist(2026, 11, 24, 7, 59)).toISOString()).toBe(
      ist(2026, 11, 24, 8, 0).toISOString(),
    );
  });

  it('keeps a small-hours completion on the same calendar morning', () => {
    // 24 Nov, 02:15 IST -> 24 Nov, 08:00 IST, not the 25th.
    expect(nextCheckinSlot(ist(2026, 11, 24, 2, 15)).toISOString()).toBe(
      ist(2026, 11, 24, 8, 0).toISOString(),
    );
  });

  it('rolls over month and year boundaries', () => {
    expect(nextCheckinSlot(ist(2026, 12, 31, 21, 0)).toISOString()).toBe(
      ist(2027, 1, 1, 8, 0).toISOString(),
    );
  });

  it('does not depend on the host timezone', () => {
    // The point of the fixed offset: the same instant gives the same answer even
    // when the runner's TZ would call it a different hour.
    const now = new Date('2026-11-24T15:00:00.000Z'); // 20:30 IST
    expect(nextCheckinSlot(now).toISOString()).toBe('2026-11-25T02:30:00.000Z');
  });
});

describe('checkinStillWorthSending', () => {
  it('keeps a check-in that is at most two days late', () => {
    const due = new Date('2026-11-25T02:30:00.000Z');
    expect(checkinStillWorthSending(due, new Date(due.getTime() + CHECKIN_MAX_LATENESS_MS))).toBe(
      true,
    );
  });

  it('drops one that is later than that', () => {
    const due = new Date('2026-11-25T02:30:00.000Z');
    expect(
      checkinStillWorthSending(due, new Date(due.getTime() + CHECKIN_MAX_LATENESS_MS + 1)),
    ).toBe(false);
  });
});
