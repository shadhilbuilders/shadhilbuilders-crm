// lib/leads.ts - pure helpers (autoplan 2026-09-07, plan T5).
//
// The tripwire test pins LEAD_STATES to the api-types enum: a state added
// backend-side without updating this mirror must fail here, not silently
// disappear from the inbox facets.
import { LeadStateSchema } from '@shadhil/api-types';
import { describe, expect, it } from 'vitest';

import { isOverdue, LEAD_STATES, OVERDUE_AFTER_MIN } from './leads';

describe('LEAD_STATES mirror', () => {
  it('matches the api-types LeadStateSchema enum exactly (order + values)', () => {
    const enumValues = LeadStateSchema.options;
    expect(LEAD_STATES).toHaveLength(enumValues.length);
    expect([...LEAD_STATES]).toEqual([...enumValues]);
  });

  it('has 12 states (Model C full surface)', () => {
    expect(LEAD_STATES).toHaveLength(12);
  });
});

describe('isOverdue', () => {
  const NOW = Date.now();
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  it('true: NEW + created strictly beyond the 30-min target', () => {
    expect(isOverdue({ status: 'NEW', createdAt: minutesAgo(31) })).toBe(true);
  });

  it('boundary: exactly OVERDUE_AFTER_MIN counts as overdue (>=)', () => {
    expect(OVERDUE_AFTER_MIN).toBe(30);
    // Freeze-independent: build the timestamp relative to Date.now() at
    // call time, allowing 1s of execution skew.
    const at = new Date(NOW - OVERDUE_AFTER_MIN * 60_000).toISOString();
    expect(isOverdue({ status: 'NEW', createdAt: at })).toBe(true);
  });

  it('false: NEW + created inside the target', () => {
    expect(isOverdue({ status: 'NEW', createdAt: minutesAgo(5) })).toBe(false);
  });

  it('false: non-NEW states are exempt even when ancient', () => {
    expect(
      isOverdue({ status: 'CONTACTED', createdAt: minutesAgo(7 * 24 * 60) }),
    ).toBe(false);
    expect(
      isOverdue({ status: 'COLD', createdAt: minutesAgo(7 * 24 * 60) }),
    ).toBe(false);
  });

  it('false: missing createdAt (fail-closed)', () => {
    expect(isOverdue({ status: 'NEW', createdAt: undefined })).toBe(false);
    expect(isOverdue({ status: 'NEW', createdAt: null })).toBe(false);
  });

  it('false: malformed createdAt (fail-closed)', () => {
    expect(isOverdue({ status: 'NEW', createdAt: 'not-a-date' })).toBe(false);
  });

  it('false: null/undefined row', () => {
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(undefined)).toBe(false);
  });

  it('false: missing status', () => {
    expect(isOverdue({ createdAt: minutesAgo(60) })).toBe(false);
  });
});