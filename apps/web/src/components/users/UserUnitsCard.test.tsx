// protects= the pure selection helpers behind the assignment card never mutate
// and detect real change; fails_when= Save enables with no change, or a toggle
// mutates the saved set.
import { describe, expect, it } from 'vitest';

import type { UnitRow } from '@/hooks/queries/inventory';

import { assignedIdsFor, isDirty, toggled } from './UserUnitsCard';

const row = (id: string, assignedEngineerId: string | null): UnitRow =>
  ({ id, assignedEngineerId }) as unknown as UnitRow;

describe('UserUnitsCard helpers', () => {
  it("assignedIdsFor keeps only this engineer's villas", () => {
    const rows = [row('a', 'e1'), row('b', 'e2'), row('c', null), row('d', 'e1')];
    expect([...assignedIdsFor(rows, 'e1')]).toEqual(['a', 'd']);
  });

  it('toggled returns a new set and leaves the input alone', () => {
    const saved = new Set(['a']);
    const next = toggled(saved, 'b', true);
    expect([...next].sort()).toEqual(['a', 'b']);
    expect([...saved]).toEqual(['a']);
    expect([...toggled(next, 'a', false)]).toEqual(['b']);
  });

  it('isDirty is false for an equal selection and true for any difference', () => {
    expect(isDirty(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(false);
    expect(isDirty(new Set(['a']), new Set(['b']))).toBe(true);
    expect(isDirty(new Set(['a']), new Set())).toBe(true);
  });
});
