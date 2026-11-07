// Portal formatting helpers (issue #8 slice 2).
// protects= alt text falls back to a real description and month grouping is
//           consecutive + zone-pinned; fails_when= empty captions yield empty
//           alt, or a photo near a month boundary lands in the wrong section;
// no_claim= says nothing about rendering.
import { describe, expect, it } from 'vitest';

import { formatDay, groupByMonth, photoAlt } from './portal-format';

describe('photoAlt', () => {
  it('uses the caption when present', () => {
    expect(photoAlt({ caption: 'Foundation October 2026', phaseName: 'Foundation', takenAt: '2026-10-26T10:00:00Z' })).toBe(
      'Foundation October 2026',
    );
  });
  it('falls back to "Construction photo, {phase}, {date}" for a blank caption', () => {
    expect(photoAlt({ caption: '   ', phaseName: 'Plinth', takenAt: '2026-10-26T10:00:00Z' })).toBe(
      `Construction photo, Plinth, ${formatDay('2026-10-26T10:00:00Z')}`,
    );
  });
});

describe('groupByMonth', () => {
  it('groups consecutive photos by IST month, newest first', () => {
    // 2026-10-31T20:00Z is 01:30 IST on 1 November: it belongs to November.
    const groups = groupByMonth([
      { takenAt: '2026-10-31T20:00:00Z' },
      { takenAt: '2026-11-03T08:00:00Z' },
      { takenAt: '2026-10-30T08:00:00Z' },
    ]);
    expect(groups.map((g) => [g.label, g.photos.length])).toEqual([
      ['November 2026', 2],
      ['October 2026', 1],
    ]);
  });
});
