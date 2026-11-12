// protects= the milestone editor's order, date round-trip and validation.
// fails_when= reordering drops/duplicates a row, a date shifts a day on the way
//   out, or a blank/over-long name reaches the API.
// no_claim= nothing about rendering or the network.
import { describe, expect, it } from 'vitest';

import { draftsFromRows, moveDraft, newDraft, toPayload, validateDrafts } from './milestone-draft';

const rows = [
  {
    id: 'a',
    name: 'Slab cast',
    targetDate: '2027-01-15T00:00:00.000Z',
    completedAt: '2027-01-10T00:00:00.000Z',
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
          targetDate: '2027-01-15T00:00:00.000Z',
          completedAt: '2027-01-10T00:00:00.000Z',
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
});
