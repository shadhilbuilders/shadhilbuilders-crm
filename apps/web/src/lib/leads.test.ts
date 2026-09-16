// @vitest-environment node
// lib/leads.ts - pure helpers (autoplan 2026-09-07, plan T5).
//
// The tripwire test pins LEAD_STATES to the api-types enum: a state added
// backend-side without updating this mirror must fail here, not silently
// disappear from the inbox facets.
import { LeadStateSchema } from '@shadhil/api-types';
import { describe, expect, it } from 'vitest';

import {
  AGE_URGENT_AFTER_MIN,
  AGE_WARN_AFTER_MIN,
  isOverdue,
  leadAgeTier,
  LEAD_AGE_TIER_CLASS,
  LEAD_STATES,
  OVERDUE_AFTER_MIN,
} from './leads';

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
// Row-tint tiers (user request 2026-09-15): NEW leads get progressively
// warmer rows at 10 / 20 / 30 minutes. Pinned here because the boundaries ARE
// the feature - an off-by-one would tint at the wrong minute and nobody would
// notice in review.
describe('leadAgeTier', () => {
  const NOW = Date.parse('2026-09-15T12:00:00.000Z');
  /** ISO createdAt for a NEW lead created `min` minutes before NOW. */
  const createdMinAgo = (min: number) =>
    new Date(NOW - min * 60_000).toISOString();

  function tier(minAgo: number, status = 'NEW') {
    return leadAgeTier({ status, createdAt: createdMinAgo(minAgo) }, NOW);
  }

  it('null (default white): under the first boundary', () => {
    expect(tier(0)).toBeNull();
    expect(tier(9)).toBeNull();
    expect(tier(9.99)).toBeNull();
  });

  it('age (light yellow): 10 min up to just under 20', () => {
    expect(tier(AGE_WARN_AFTER_MIN)).toBe('age');
    expect(tier(15)).toBe('age');
    expect(tier(19.99)).toBe('age');
  });

  it('warn (dark yellow): 20 min up to just under 30', () => {
    expect(tier(AGE_URGENT_AFTER_MIN)).toBe('warn');
    expect(tier(25)).toBe('warn');
    expect(tier(29.99)).toBe('warn');
  });

  it('overdue (red): 30 min and beyond', () => {
    expect(tier(OVERDUE_AFTER_MIN)).toBe('overdue');
    expect(tier(31)).toBe('overdue');
    expect(tier(60 * 24)).toBe('overdue');
  });

  it('boundaries belong to the LATER tier - no un-tinted gaps', () => {
    // Walk the whole range and assert every minute maps to exactly one tier
    // (never null above the first boundary, never skipping a tier).
    const seen = new Set<string | null>();
    for (let m = 10; m <= 40; m++) seen.add(tier(m));
    expect([...seen].sort()).toEqual(['age', 'overdue', 'warn']);
    expect(seen.has(null)).toBe(false);
  });

  it('agrees with isOverdue at the 30-minute boundary', () => {
    for (const m of [5, 10, 20, 29, 30, 45]) {
      const row = { status: 'NEW', createdAt: createdMinAgo(m) };
      const red = leadAgeTier(row, NOW) === 'overdue';
      // isOverdue reads the real clock, so only compare the boundary rule.
      expect(red).toBe(m >= OVERDUE_AFTER_MIN);
    }
  });

  it('null: non-NEW states are exempt, however old', () => {
    for (const status of ['CONTACTED', 'VISITED', 'NEGOTIATION', 'WON', 'LOST']) {
      expect(tier(600, status)).toBeNull();
    }
  });

  it('null: unknown data fails closed', () => {
    expect(leadAgeTier(null, NOW)).toBeNull();
    expect(leadAgeTier(undefined, NOW)).toBeNull();
    expect(leadAgeTier({ status: 'NEW' }, NOW)).toBeNull();
    expect(leadAgeTier({ status: 'NEW', createdAt: '' }, NOW)).toBeNull();
    expect(leadAgeTier({ status: 'NEW', createdAt: 'not-a-date' }, NOW)).toBeNull();
    expect(leadAgeTier({ createdAt: createdMinAgo(60) }, NOW)).toBeNull();
  });

  it('tier classes exist, differ, and carry a dark-mode variant', () => {
    const classes = Object.values(LEAD_AGE_TIER_CLASS);
    expect(new Set(classes).size).toBe(classes.length);
    for (const cls of classes) {
      expect(cls).toMatch(/\bbg-/);
      expect(cls).toMatch(/\bdark:bg-/);
    }
    // The three tints must be visually distinct colours.
    expect(LEAD_AGE_TIER_CLASS.age).toContain('bg-yellow');
    expect(LEAD_AGE_TIER_CLASS.warn).toContain('bg-yellow');
    expect(LEAD_AGE_TIER_CLASS.overdue).toContain('bg-red');
  });

  it('the warn tier is a deeper yellow than the age tier', () => {
    const shade = (cls: string) => Number(/-(\d{2,3})\b/.exec(cls)?.[1] ?? 0);
    expect(shade(LEAD_AGE_TIER_CLASS.warn)).toBeGreaterThan(
      shade(LEAD_AGE_TIER_CLASS.age),
    );
  });
});
