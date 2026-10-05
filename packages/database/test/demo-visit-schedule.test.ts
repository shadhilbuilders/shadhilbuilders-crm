import { describe, expect, it } from 'vitest';

import { demoVisitSchedule } from '../src/demo-visit-schedule';

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

describe('demoVisitSchedule', () => {
  it('keeps both fixtures in the current month (mid-month)', () => {
    const now = new Date(2026, 9, 5, 12, 0, 0); // 5 Oct 2026
    const { upcoming, past } = demoVisitSchedule(now);
    expect(sameMonth(upcoming, now)).toBe(true);
    expect(sameMonth(past, now)).toBe(true);
    expect(past.getTime()).toBeLessThan(upcoming.getTime());
  });

  it('stays in-month on the 1st (yesterday would be the previous month)', () => {
    const now = new Date(2026, 9, 1, 9, 0, 0);
    const { upcoming, past } = demoVisitSchedule(now);
    expect(sameMonth(upcoming, now)).toBe(true);
    expect(sameMonth(past, now)).toBe(true);
  });

  it('stays in-month on the last day (tomorrow would be the next month)', () => {
    const now = new Date(2026, 9, 31, 18, 0, 0);
    const { upcoming, past } = demoVisitSchedule(now);
    expect(sameMonth(upcoming, now)).toBe(true);
    expect(sameMonth(past, now)).toBe(true);
  });
});
