// LeadsOverTimeChart pure-function tests - autoplan 2026-09-08.
import { describe, expect, it } from 'vitest';

import { formatDayLabel } from '@/components/charts/LeadsOverTimeChart';

describe('formatDayLabel', () => {
  it('formats an ISO date key to a friendly weekday + day label', () => {
    expect(formatDayLabel('2026-09-08')).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
  });

  it('returns the raw input for an invalid date', () => {
    expect(formatDayLabel('not-a-date')).toBe('not-a-date');
  });
});
