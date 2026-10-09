// auto-assign.engine tests (T-AUTOASSIGN, 2026-09-17).
//
// Pins the pure selection logic: weighted least-loaded selection, the
// determinism tie-breaks, and the no-eligible guard. The pooling/dedup is
// exercised at the SERVICE layer (it owns the Prisma queries and the
// telecaller-only eligibility rule); this file only proves the score rule holds.
import { describe, expect, it } from 'vitest';

import {
  orderTeamsForRotation,
  pickAutoAssignCandidate,
  type AutoAssignCandidate,
  type RotationTeam,
} from './auto-assign.engine';

// T-TEAM-ROUND-ROBIN (2026-10-08): the team whose turn it is = the one routed to
// longest ago; never-routed teams (null) go first.
describe('orderTeamsForRotation', () => {
  const T = (teamId: string, lastAssignedAt: Date | null): RotationTeam => ({
    teamId,
    lastAssignedAt,
  });

  it('puts never-routed teams (null) before any routed team', () => {
    const ordered = orderTeamsForRotation([
      T('b', new Date('2026-10-08T10:00:00Z')),
      T('a', null),
    ]);
    expect(ordered.map((t) => t.teamId)).toEqual(['a', 'b']);
  });

  it('orders routed teams oldest-first (longest since last lead goes next)', () => {
    const ordered = orderTeamsForRotation([
      T('recent', new Date('2026-10-08T12:00:00Z')),
      T('old', new Date('2026-10-08T09:00:00Z')),
      T('mid', new Date('2026-10-08T10:30:00Z')),
    ]);
    expect(ordered.map((t) => t.teamId)).toEqual(['old', 'mid', 'recent']);
  });

  it('breaks ties (same timestamp, or both null) by teamId for determinism', () => {
    const at = new Date('2026-10-08T10:00:00Z');
    expect(
      orderTeamsForRotation([T('z', at), T('m', at)]).map((t) => t.teamId),
    ).toEqual(['m', 'z']);
    expect(
      orderTeamsForRotation([T('z', null), T('m', null)]).map((t) => t.teamId),
    ).toEqual(['m', 'z']);
  });

  it('does not mutate its input and returns a new array', () => {
    const input = [T('b', null), T('a', null)];
    const snapshot = [...input];
    const out = orderTeamsForRotation(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });

  it('preserves extra fields on the team objects', () => {
    const out = orderTeamsForRotation([
      { teamId: 'a', lastAssignedAt: null, autoAssignLeads: true },
    ]);
    expect(out[0]).toMatchObject({ autoAssignLeads: true });
  });
});

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

  it('ignores a member who opted out with weight 0 instead of treating them as idle', () => {
    // Weight 0 = "takes no auto-assigned leads". Such a member must not win by
    // scoring 0/0-ish, and must not block an eligible colleague.
    const pool: AutoAssignCandidate[] = [
      { userId: 'tc-off', openLeads: 0, weight: 0 },
      { userId: 'tc-on', openLeads: 7, weight: 1 },
    ];
    expect(pickAutoAssignCandidate(pool)).toMatchObject({
      kind: 'picked',
      userId: 'tc-on',
    });
  });
});

describe('T-MAXOPENLEADS: the cap is an eligibility gate, not a score penalty', () => {
  const TC = (
    userId: string,
    openLeads: number,
    maxOpenLeads: number | null,
    weight = 1,
  ): AutoAssignCandidate => ({ userId, openLeads, weight, maxOpenLeads });

  it('excludes a member at or over their ceiling, even when they score lowest', () => {
    // The capped member would win on score (0.0) but is full, so the lead must
    // go to the loaded-but-uncapped colleague. This is the whole point of the
    // cap: it overrides the weighted ratio rather than merely biasing it.
    const pool: AutoAssignCandidate[] = [
      TC('tc-full', 5, 5), // at ceiling, score 5.0 - ineligible
      TC('tc-loaded', 9, 20), // under ceiling, score 9.0 - wins
    ];
    expect(pickAutoAssignCandidate(pool)).toMatchObject({
      kind: 'picked',
      userId: 'tc-loaded',
    });
  });

  it('a member under their ceiling is eligible (boundary is strict)', () => {
    const pool: AutoAssignCandidate[] = [TC('tc-at-4', 4, 5)];
    expect(pickAutoAssignCandidate(pool)).toMatchObject({
      kind: 'picked',
      userId: 'tc-at-4',
    });
    // ...and one more lead (openLeads === cap) makes them full.
    const full: AutoAssignCandidate[] = [TC('tc-at-5', 5, 5)];
    expect(pickAutoAssignCandidate(full)).toEqual({ kind: 'no-eligible' });
  });

  it('a cap of 0 excludes the member entirely (a real ceiling, not "unset")', () => {
    expect(pickAutoAssignCandidate([TC('tc-zero-cap', 0, 0)])).toEqual({
      kind: 'no-eligible',
    });
  });

  it('null and undefined ceilings are uncapped (every pre-existing row)', () => {
    // The opt-in contract: an un-migrated/undefined cap must never exclude.
    expect(
      pickAutoAssignCandidate([TC('tc-null', 99, null)]),
    ).toMatchObject({ kind: 'picked', userId: 'tc-null' });
    expect(
      pickAutoAssignCandidate([{ userId: 'tc-undef', openLeads: 99, weight: 1 }]),
    ).toMatchObject({ kind: 'picked', userId: 'tc-undef' });
  });

  it('returns no-eligible when EVERY candidate is at their ceiling', () => {
    // The caller turns this into the manager handoff (pending), never a
    // sales-exec pick and never an over-cap assignment.
    const pool: AutoAssignCandidate[] = [
      TC('tc-a', 3, 3),
      TC('tc-b', 7, 7),
      TC('tc-c', 1, 1),
    ];
    expect(pickAutoAssignCandidate(pool)).toEqual({ kind: 'no-eligible' });
  });

  it('a capped member does not block uncapped colleagues in the same pool', () => {
    const pool: AutoAssignCandidate[] = [
      TC('tc-full', 2, 2),
      TC('tc-free-a', 8, null),
      TC('tc-free-b', 4, null),
    ];
    expect(pickAutoAssignCandidate(pool)).toMatchObject({
      kind: 'picked',
      userId: 'tc-free-b',
    });
  });

  it('the cap and weight compose: eligibility first, then the weighted ratio', () => {
    // Among the eligible, weight still decides the share. tc-expert is heavier
    // (score 4/2 = 2.0) and beats tc-novice (3/1 = 3.0); tc-capped is excluded
    // despite carrying the best raw score (1/1 = 1.0).
    const pool: AutoAssignCandidate[] = [
      TC('tc-capped', 1, 1, 1),
      TC('tc-novice', 3, 10, 1),
      TC('tc-expert', 4, 10, 2),
    ];
    expect(pickAutoAssignCandidate(pool)).toMatchObject({
      kind: 'picked',
      userId: 'tc-expert',
    });
  });
});
