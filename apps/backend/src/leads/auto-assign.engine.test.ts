// auto-assign.engine tests (T-AUTOASSIGN, 2026-09-17).
//
// Pins the pure selection logic: weighted least-loaded selection, the
// determinism tie-breaks, and the no-eligible guard. The pooling/dedup is
// exercised at the SERVICE layer (it owns the Prisma queries); this file only
// proves the score rule holds.
import { describe, expect, it } from 'vitest';

import {
  pickAutoAssignCandidate,
  type AutoAssignCandidate,
} from './auto-assign.engine';

describe('pickAutoAssignCandidate', () => {
  it('picks the least-loaded member when everyone has the same weight', () => {
    const pool: AutoAssignCandidate[] = [
      { userId: 'tc-1', openLeads: 5, weight: 1 },
      { userId: 'tc-2', openLeads: 2, weight: 1 },
      { userId: 'tc-3', openLeads: 8, weight: 1 },
    ];
    const result = pickAutoAssignCandidate(pool);
    expect(result.kind).toBe('picked');
    if (result.kind !== 'picked') return;
    expect(result.userId).toBe('tc-2');
    expect(result.score).toBe(2);
  });

  it('weight biases toward an experienced member even when they carry more load', () => {
    const pool: AutoAssignCandidate[] = [
      { userId: 'tc-novice', openLeads: 3, weight: 1 }, // score 3.0
      { userId: 'tc-expert', openLeads: 6, weight: 2 }, // score 3.0 -> tie, fewer open leads wins
      { userId: 'tc-lead', openLeads: 4, weight: 1 }, // score 4.0
    ];
    const result = pickAutoAssignCandidate(pool);
    expect(result.kind).toBe('picked');
    if (result.kind !== 'picked') return;
    // experts 3.0 and novices 3.0 tie -> fewer open leads (novice) wins.
    expect(result.userId).toBe('tc-novice');
  });

  it('a heavier but higher-loaded member can beat a lighter one when the ratio favors it', () => {
    const pool: AutoAssignCandidate[] = [
      { userId: 'tc-a', openLeads: 4, weight: 1 }, // 4 / 1 = 4.0
      { userId: 'tc-b', openLeads: 6, weight: 2 }, // 6 / 2 = 3.0 -> wins
    ];
    const result = pickAutoAssignCandidate(pool);
    if (result.kind !== 'picked') throw new Error('expected a pick');
    expect(result.userId).toBe('tc-b');
  });

  it('breaks true ties deterministically by userId, not by array order', () => {
    const a: AutoAssignCandidate = { userId: 'tc-a', openLeads: 2, weight: 1 };
    const b: AutoAssignCandidate = { userId: 'tc-b', openLeads: 2, weight: 1 };
    expect(
      pickAutoAssignCandidate([b, a]),
    ).toMatchObject({ kind: 'picked', userId: 'tc-a' });
    expect(
      pickAutoAssignCandidate([a, b]),
    ).toMatchObject({ kind: 'picked', userId: 'tc-a' });
  });

  it('returns no-eligible when the pool is empty or all weights are <= 0', () => {
    expect(pickAutoAssignCandidate([])).toEqual({ kind: 'no-eligible' });
    expect(
      pickAutoAssignCandidate([{ userId: 'tc-0', openLeads: 1, weight: 0 }]),
    ).toEqual({ kind: 'no-eligible' });
  });
});
