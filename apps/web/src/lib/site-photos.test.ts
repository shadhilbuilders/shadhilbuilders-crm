import { describe, expect, it } from 'vitest';

import {
  photoSummaryLine,
  QUICK_NOTE_LABELS,
  quickNoteSlug,
  relativeCaptureTime,
  stalenessLabel,
  toggleNoteLine,
  unitPhotoState,
  unitPhotoStateBadgeVariant,
  unitPhotoStateLabel,
  unitPhotoStateRank,
} from './site-photos';

// Fixed clock: every assertion below passes `now` in, so none of this depends
// on when the suite runs.
const NOW = new Date('2026-11-08T10:00:00.000Z');

const at = (daysAgo: number): string =>
  new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

describe('unitPhotoState', () => {
  it('is "none" when the unit has no photos, whatever the timestamp says', () => {
    expect(unitPhotoState({ photoCount: 0, lastPhotoAt: null }, NOW)).toBe('none');
    // A stale timestamp with a zero count cannot happen in real data, but if it
    // ever did, the count is the honest answer.
    expect(unitPhotoState({ photoCount: 0, lastPhotoAt: at(30) }, NOW)).toBe('none');
  });

  it('is "today" at exactly 2 days and "week" at 3', () => {
    expect(unitPhotoState({ photoCount: 1, lastPhotoAt: at(2) }, NOW)).toBe('today');
    expect(unitPhotoState({ photoCount: 1, lastPhotoAt: at(3) }, NOW)).toBe('week');
  });

  it('is "week" at exactly 7 days and "stale" at 8', () => {
    expect(unitPhotoState({ photoCount: 1, lastPhotoAt: at(7) }, NOW)).toBe('week');
    expect(unitPhotoState({ photoCount: 1, lastPhotoAt: at(8) }, NOW)).toBe('stale');
  });

  it('treats a future timestamp as "today", never "stale"', () => {
    // A phone with a skewed clock must not make a villa photographed this
    // morning read as neglected.
    const future = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(unitPhotoState({ photoCount: 1, lastPhotoAt: future }, NOW)).toBe('today');
  });

  it('carries a word label for every state, so colour is never the only signal', () => {
    for (const state of ['none', 'today', 'week', 'stale'] as const) {
      expect(unitPhotoStateLabel(state).length).toBeGreaterThan(0);
      expect(unitPhotoStateBadgeVariant(state)).toBeTruthy();
    }
    expect(unitPhotoStateLabel('stale')).toBe('Needs a photo');
    expect(unitPhotoStateLabel('none')).toBe('No photos');
    expect(unitPhotoStateLabel('today')).toBe('Updated today');
    expect(unitPhotoStateLabel('week')).toBe('This week');
  });

  it('sorts the most neglected first: stale, none, week, today', () => {
    const order = (['today', 'week', 'none', 'stale'] as const)
      .slice()
      .sort((a, b) => unitPhotoStateRank(a) - unitPhotoStateRank(b));
    expect(order).toEqual(['stale', 'none', 'week', 'today']);
  });
});

describe('relativeCaptureTime', () => {
  // Local-time arithmetic: the helper reads LOCAL calendar days, so the
  // fixture is built locally too rather than from a UTC literal.
  const localNow = new Date(2026, 10, 8, 18, 0, 0); // 8 Nov 2026, 6:00 pm local

  it('reads "Today, <clock>" for a capture earlier the same day', () => {
    const captured = new Date(2026, 10, 8, 16, 12, 0).toISOString();
    expect(relativeCaptureTime(captured, localNow)).toBe('Today, 4:12 pm');
  });

  it('reads "Yesterday, <clock>" for the previous calendar day', () => {
    const captured = new Date(2026, 10, 7, 9, 5, 0).toISOString();
    expect(relativeCaptureTime(captured, localNow)).toBe('Yesterday, 9:05 am');
  });

  it('drops the year for an older date in the same year', () => {
    const captured = new Date(2026, 10, 3, 12, 0, 0).toISOString();
    expect(relativeCaptureTime(captured, localNow)).toBe('3 Nov');
  });

  it('includes the year across a year boundary', () => {
    const captured = new Date(2025, 11, 28, 12, 0, 0).toISOString();
    expect(relativeCaptureTime(captured, localNow)).toBe('28 Dec 2025');
  });

  it('shows 12 pm and 12 am correctly, not 0 pm', () => {
    const noon = new Date(2026, 10, 8, 12, 0, 0).toISOString();
    const midnight = new Date(2026, 10, 8, 0, 30, 0).toISOString();
    expect(relativeCaptureTime(noon, localNow)).toBe('Today, 12:00 pm');
    expect(relativeCaptureTime(midnight, localNow)).toBe('Today, 12:30 am');
  });

  it('returns an empty string for an unparseable timestamp rather than NaN text', () => {
    expect(relativeCaptureTime('not-a-date', localNow)).toBe('');
  });
});

describe('stalenessLabel', () => {
  it('phrases a duration, and never renders a negative age', () => {
    expect(stalenessLabel(null, NOW)).toBe('No photos yet');
    expect(stalenessLabel(at(0), NOW)).toBe('Today');
    expect(stalenessLabel(at(1), NOW)).toBe('Yesterday');
    expect(stalenessLabel(at(3), NOW)).toBe('3 days ago');
    const future = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(stalenessLabel(future, NOW)).toBe('Today');
  });
});

describe('photoSummaryLine', () => {
  it('is absent when there are no photos, so nothing claims an empty feed', () => {
    expect(photoSummaryLine([], NOW)).toBeNull();
  });

  it('counts singular and plural honestly', () => {
    expect(photoSummaryLine([{ takenAt: at(0) }], NOW)).toBe('1 photo · last added today');
    expect(photoSummaryLine([{ takenAt: at(0) }, { takenAt: at(1) }], NOW)).toBe(
      '2 photos · last added today',
    );
  });

  it('uses the NEWEST reading (the first row) for the phrase', () => {
    expect(photoSummaryLine([{ takenAt: at(3) }, { takenAt: at(9) }], NOW)).toBe(
      '2 photos · last added 3 days ago',
    );
  });
});

describe('toggleNoteLine', () => {
  it('appends the label as its own line', () => {
    expect(toggleNoteLine('', 'Slab', true)).toBe('Slab');
    expect(toggleNoteLine('Plinth poured', 'Slab', true)).toBe('Plinth poured\nSlab');
  });

  it('removes exactly that line when deselected', () => {
    expect(toggleNoteLine('Plinth poured\nSlab', 'Slab', false)).toBe('Plinth poured');
    expect(toggleNoteLine('Slab', 'Slab', false)).toBe('');
  });

  it('never duplicates a line', () => {
    expect(toggleNoteLine('Slab', 'Slab', true)).toBe('Slab');
  });

  it('keeps the order of the remaining lines untouched', () => {
    const note = 'Brickwork\nPlinth poured\nSlab';
    expect(toggleNoteLine(note, 'Plinth poured', false)).toBe('Brickwork\nSlab');
  });

  it('only removes a line that IS the label, not one that contains it', () => {
    expect(toggleNoteLine('Slab is poured', 'Slab', false)).toBe('Slab is poured');
  });
});

describe('quick notes', () => {
  it('offers the six labels in the documented order', () => {
    expect([...QUICK_NOTE_LABELS]).toEqual([
      'Slab',
      'Brickwork',
      'Plastering',
      'Waterproofing',
      'Flooring',
      'Issue',
    ]);
  });

  it('slugifies a label for its data-qa', () => {
    expect(quickNoteSlug('Slab')).toBe('slab');
    expect(quickNoteSlug('Waterproofing')).toBe('waterproofing');
  });
});
