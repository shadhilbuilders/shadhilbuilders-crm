// protects= the milestone editor's order, date round-trip and validation.
// fails_when= reordering drops/duplicates a row, a date shifts a day on the way
//   out, or a blank/over-long name reaches the API.
// no_claim= nothing about rendering or the network.
import { describe, expect, it } from 'vitest';

import {
  draftsFromRows,
  moveDraft,
  newDraft,
  toPayload,
  validateDrafts,
  warnDrafts,
} from './milestone-draft';

const rows = [
  {
    id: 'a',
    name: 'Slab cast',
    targetDate: '2026-11-15T00:00:00.000Z',
    completedAt: '2026-11-10T00:00:00.000Z',
  },
  { id: 'b', name: 'Handover', targetDate: null, completedAt: null },
];

describe('milestone drafts', () => {
  it('round-trips rows through drafts to the wire without shifting dates', () => {
    const payload = toPayload(draftsFromRows(rows));
    expect(payload).toEqual({
      milestones: [
        {
          name: 'Slab cast',
          targetDate: '2026-11-15T00:00:00.000Z',
          completedAt: '2026-11-10T00:00:00.000Z',
        },
        { name: 'Handover', targetDate: null, completedAt: null },
      ],
    });
  });

  it('moves an item by one and ignores moves off either end', () => {
    const drafts = draftsFromRows(rows);
    expect(moveDraft(drafts, 1, -1).map((d) => d.key)).toEqual(['b', 'a']);
    expect(moveDraft(drafts, 0, -1).map((d) => d.key)).toEqual(['a', 'b']);
    expect(moveDraft(drafts, 1, 1).map((d) => d.key)).toEqual(['a', 'b']);
    expect(drafts.map((d) => d.key)).toEqual(['a', 'b']); // input untouched
  });

  it('trims names on the way out', () => {
    const list = [{ ...newDraft('n'), name: '  Plinth  ' }];
    expect(toPayload(list).milestones[0]?.name).toBe('Plinth');
  });

  it('rejects a blank name by position, and too many rows', () => {
    expect(validateDrafts([...draftsFromRows(rows), newDraft('n')])).toBe(
      'Milestone 3 needs a name.',
    );
    expect(validateDrafts(draftsFromRows(rows))).toBeNull();
    const many = Array.from({ length: 31 }, (_, i) => ({ ...newDraft(String(i)), name: `m${i}` }));
    expect(validateDrafts(many)).toMatch(/at most 30/);
  });

  it('rejects a repeated name, ignoring case and inner whitespace', () => {
    const list = [
      { ...newDraft('a'), name: 'Slab  cast' },
      { ...newDraft('b'), name: ' slab CAST ' },
    ];
    expect(validateDrafts(list)).toBe(
      'Milestone 2 repeats the name "slab CAST". Give each one a different name.',
    );
    expect(
      validateDrafts([
        { ...newDraft('a'), name: 'Slab cast' },
        { ...newDraft('b'), name: 'Handover' },
      ]),
    ).toBeNull();
  });

  it('rejects a completion date in the future and a malformed one', () => {
    const nextYear = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(validateDrafts([{ ...newDraft('a'), name: 'Slab cast', completedDay: nextYear }])).toBe(
      'Milestone 1 cannot be marked reached with a future date.',
    );

    // The editor sends UTC midnight of the picked day; "today" must stay valid.
    const today = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(
      validateDrafts([{ ...newDraft('a'), name: 'Slab cast', completedDay: today }]),
    ).toBeNull();

    expect(
      validateDrafts([{ ...newDraft('a'), name: 'Slab cast', completedDay: '2027-13-45' }]),
    ).toBe('Milestone 1 has an invalid completion date.');
  });

  it('warns, without blocking, when a milestone was completed before its target', () => {
    const early = [
      {
        ...newDraft('a'),
        name: 'Slab cast',
        targetDay: '2026-11-15',
        completedDay: '2026-11-10',
      },
    ];
    expect(validateDrafts(early)).toBeNull();
    expect(warnDrafts(early)).toBe(
      'Milestone 1 was completed before its target date. Check the target date if that was not intended.',
    );

    const justDone = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 10);
    const late = [
      { ...newDraft('a'), name: 'Slab cast', targetDay: '2026-11-10', completedDay: justDone },
    ];
    expect(warnDrafts(late)).toBeNull();
    expect(warnDrafts([newDraft('a')])).toBeNull();
  });
});
