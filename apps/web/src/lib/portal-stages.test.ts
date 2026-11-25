// portal-stages - the chip row and the two rules it enforces.
//
// protects= exactly one chip is on, a press on the active chip is a no-op, an
//           unknown value cannot become the filter, a zero-count stage is not
//           offered, and a deep link overrides any filter;
// fails_when= an empty press clears the filter (the feed would then match
//           nothing), chips re-sort away from the server's build order, or the
//           "Stage not set" bucket is folded into NOT_STARTED;
// no_claim= the server's counts (backend tests) and the rendered chip markup
//           (component test).
import { describe, expect, it } from 'vitest';

import {
  effectiveStageFilter,
  nextStageFilter,
  stageChips,
  totalItems,
  type StageCountsInput,
} from './portal-stages';

const counts: StageCountsInput = {
  stages: [
    { stage: 'FOUNDATION', count: 8 },
    { stage: 'STRUCTURE', count: 24 },
    { stage: 'MASONRY', count: 0 },
    { stage: 'PLASTERING', count: 6 },
  ],
  unset: 3,
  total: 41,
};

describe('stageChips', () => {
  it('offers All, then the stages the server sent in its order, then the unset bucket', () => {
    expect(stageChips(counts)).toEqual([
      { value: 'all', label: 'All', count: 41 },
      { value: 'FOUNDATION', label: 'Foundation', count: 8 },
      { value: 'STRUCTURE', label: 'Structure', count: 24 },
      { value: 'PLASTERING', label: 'Plastering', count: 6 },
      { value: 'UNSET', label: 'Stage not set', count: 3 },
    ]);
  });

  it('never offers a stage with nothing in it', () => {
    const values = stageChips(counts).map((chip) => chip.value);
    expect(values).not.toContain('MASONRY');
  });

  it('omits the unset chip when every capture recorded a stage', () => {
    const values = stageChips({ ...counts, unset: 0 }).map((chip) => chip.value);
    expect(values).not.toContain('UNSET');
  });

  it('shows only All while the counts are still loading', () => {
    expect(stageChips(undefined)).toEqual([{ value: 'all', label: 'All', count: 0 }]);
  });

  it('treats a null stage as its own bucket, never as NOT_STARTED', () => {
    const withNotStarted = stageChips({
      stages: [{ stage: 'NOT_STARTED', count: 2 }],
      unset: 5,
      total: 7,
    });
    expect(withNotStarted.map((c) => c.value)).toEqual(['all', 'NOT_STARTED', 'UNSET']);
    expect(withNotStarted.at(-1)).toEqual({ value: 'UNSET', label: 'Stage not set', count: 5 });
  });
});

describe('nextStageFilter', () => {
  const offered = stageChips(counts);

  it('ignores an empty press, which is what a click on the active chip reports', () => {
    expect(nextStageFilter('STRUCTURE', '', offered)).toBe('STRUCTURE');
    expect(nextStageFilter('STRUCTURE', undefined, offered)).toBe('STRUCTURE');
  });

  it('ignores a press on the chip that is already on', () => {
    expect(nextStageFilter('all', 'all', offered)).toBe('all');
  });

  it('switches to a chip that is on offer', () => {
    expect(nextStageFilter('all', 'PLASTERING', offered)).toBe('PLASTERING');
    expect(nextStageFilter('PLASTERING', 'UNSET', offered)).toBe('UNSET');
  });

  it('ignores a value that is not offered, so a stray label cannot blank the feed', () => {
    expect(nextStageFilter('STRUCTURE', 'MASONRY', offered)).toBe('STRUCTURE');
    expect(nextStageFilter('STRUCTURE', 'nonsense', offered)).toBe('STRUCTURE');
  });
});

describe('effectiveStageFilter', () => {
  it('lets a deep link override the chip, then hands the chip back', () => {
    expect(effectiveStageFilter('PLASTERING', 'photo-1')).toBe('all');
    expect(effectiveStageFilter('PLASTERING', null)).toBe('PLASTERING');
  });
});

describe('totalItems', () => {
  it('is zero until the counts arrive', () => {
    expect(totalItems(undefined)).toBe(0);
    expect(totalItems(counts)).toBe(41);
  });
});
