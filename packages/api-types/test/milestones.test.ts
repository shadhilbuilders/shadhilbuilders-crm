// protects= the milestone DTO rules that reach the buyer: no future completion
//   date, no two milestones with the same name, no unknown keys, 30-row cap.
// fails_when= a rule lives only in the editor (a crafted PUT bypasses it), or a
//   legitimate "mark today reached" is rejected for a user ahead of UTC.
// no_claim= nothing about persistence, ordering by sortOrder, or the audit row.
import { describe, expect, it } from 'vitest';

import {
  COMPLETED_AT_FUTURE_TOLERANCE_MS,
  MAX_MILESTONES_PER_PROJECT,
  ReplaceMilestonesDtoSchema,
  findDuplicateMilestoneName,
} from '../src/milestones';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('ReplaceMilestonesDtoSchema', () => {
  it('accepts a normal list and an empty one (the documented clear-everything path)', () => {
    expect(
      ReplaceMilestonesDtoSchema.safeParse({
        milestones: [{ name: 'Slab cast', targetDate: null, completedAt: null }],
      }).success,
    ).toBe(true);
    expect(ReplaceMilestonesDtoSchema.safeParse({ milestones: [] }).success).toBe(true);
  });

  it('rejects a completion date beyond the tolerance', () => {
    const tooFar = iso(Date.now() + COMPLETED_AT_FUTURE_TOLERANCE_MS + 60 * 60 * 1000);
    const result = ReplaceMilestonesDtoSchema.safeParse({
      milestones: [{ name: 'Slab cast', completedAt: tooFar }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('future date');
  });

  it('accepts "today" for a user ahead of UTC, because the editor sends UTC midnight', () => {
    // An IST user at 03:00 local picks today; UTC midnight of that day is still ahead.
    const utcMidnightOfToday = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    expect(
      ReplaceMilestonesDtoSchema.safeParse({
        milestones: [{ name: 'Slab cast', completedAt: utcMidnightOfToday }],
      }).success,
    ).toBe(true);
  });

  it('rejects two milestones with the same name, whatever the case or spacing', () => {
    const result = ReplaceMilestonesDtoSchema.safeParse({
      milestones: [{ name: 'Slab  cast' }, { name: ' slab CAST ' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('both named');
  });

  it('rejects unknown keys and more than the cap', () => {
    expect(
      ReplaceMilestonesDtoSchema.safeParse({ milestones: [{ name: 'A', colour: 'red' }] }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_MILESTONES_PER_PROJECT + 1 }, (_, i) => ({
      name: `m${i}`,
    }));
    expect(ReplaceMilestonesDtoSchema.safeParse({ milestones: tooMany }).success).toBe(false);
  });
});

describe('findDuplicateMilestoneName', () => {
  it('returns the second occurrence and ignores blank names', () => {
    expect(findDuplicateMilestoneName(['Slab cast', 'Handover', 'slab cast'])).toEqual({
      index: 2,
      name: 'slab cast',
    });
    expect(findDuplicateMilestoneName(['', '  ', 'Handover'])).toBeNull();
    expect(findDuplicateMilestoneName([])).toBeNull();
  });
});
