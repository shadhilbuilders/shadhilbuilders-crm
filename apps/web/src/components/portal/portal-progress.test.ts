// Portal progress helpers (customer portal redesign, 2026-11-09).
// protects= "Stage N of 9" is derived from the enum order and is null (never 1)
//           for an unrecorded stage; "updated" copy is IST-day based; phase
//           grouping is consecutive + null-safe; the next milestone is the first
//           unfinished one; the handover countdown never goes negative;
// fails_when= an unset stage reads as "Stage 1", a photo at an IST day boundary
//           says the wrong day, or an overdue handover shows a negative count;
// no_claim= nothing about rendering.
import { describe, expect, it } from 'vitest';

import {
  daysUntilDay,
  groupByPhase,
  handoverSummary,
  milestoneEntries,
  nextMilestone,
  stagePosition,
  updatedLabel,
} from './portal-progress';

describe('stagePosition', () => {
  it('numbers stages by enum order out of nine', () => {
    expect(stagePosition('FOUNDATION')).toEqual({ position: 2, total: 9 });
    expect(stagePosition('READY')).toEqual({ position: 9, total: 9 });
  });
  it('is null for an unrecorded or unknown stage, never stage 1', () => {
    expect(stagePosition(null)).toEqual({ position: null, total: 9 });
    expect(stagePosition('BOGUS')).toEqual({ position: null, total: 9 });
  });
});

describe('updatedLabel', () => {
  const now = new Date('2026-11-09T10:00:00Z').getTime(); // 15:30 IST, 9 Nov
  it('says today / yesterday / N days ago by IST calendar day', () => {
    expect(updatedLabel('2026-11-09T01:00:00Z', now)).toBe('Updated today');
    // 2026-11-08T20:00Z is 01:30 IST on 9 Nov: still today.
    expect(updatedLabel('2026-11-08T20:00:00Z', now)).toBe('Updated today');
    expect(updatedLabel('2026-11-08T08:00:00Z', now)).toBe('Updated yesterday');
    expect(updatedLabel('2026-11-05T08:00:00Z', now)).toBe('Updated 4 days ago');
  });
  it('falls back to a date after a week', () => {
    expect(updatedLabel('2026-10-20T08:00:00Z', now)).toBe('Updated 20 Oct 2026');
  });
});

describe('groupByPhase', () => {
  const p = (id: string, phaseId: string | null, phaseName: string | null, takenAt: string) => ({
    id,
    phaseId,
    phaseName,
    takenAt,
  });
  it('groups consecutive photos of one phase, newest first, with a date range', () => {
    const groups = groupByPhase([
      p('4', 'b', 'Plinth', '2026-11-03T08:00:00Z'),
      p('3', 'a', 'Foundation', '2026-10-20T08:00:00Z'),
      p('2', 'a', 'Foundation', '2026-10-05T08:00:00Z'),
    ]);
    expect(groups.map((g) => [g.label, g.photos.length, g.rangeLabel])).toEqual([
      ['Plinth', 1, '3 Nov 2026'],
      ['Foundation', 2, '5 Oct 2026 – 20 Oct 2026'],
    ]);
  });
  it('labels photos without a phase "Other updates"', () => {
    const [g] = groupByPhase([p('1', null, null, '2026-11-03T08:00:00Z')]);
    expect(g?.label).toBe('Other updates');
  });
  it('is empty for no photos', () => {
    expect(groupByPhase([])).toEqual([]);
  });
});

describe('nextMilestone', () => {
  const m = (id: string, completedAt: string | null) => ({
    id,
    name: id,
    targetDate: null,
    completedAt,
  });
  it('returns the first unfinished milestone and the done count', () => {
    const r = nextMilestone([m('a', '2026-10-01T00:00:00Z'), m('b', null), m('c', null)]);
    expect(r.next?.id).toBe('b');
    expect(r.done).toBe(1);
    expect(r.total).toBe(3);
  });
  it('has no next when all are done or there are none', () => {
    expect(nextMilestone([m('a', '2026-10-01T00:00:00Z')]).next).toBeNull();
    expect(nextMilestone([]).next).toBeNull();
  });
});

describe('handoverSummary', () => {
  const now = new Date('2026-11-09T10:00:00Z').getTime();
  it('formats the date and a coarse countdown', () => {
    expect(handoverSummary('2027-06-15T00:00:00Z', now)).toEqual({
      dateLabel: '15 Jun 2027',
      countdown: 'about 7 months to go',
    });
    expect(handoverSummary('2026-12-09T00:00:00Z', now).countdown).toBe('about 4 weeks to go');
    expect(handoverSummary('2026-11-14T00:00:00Z', now).countdown).toBe('5 days to go');
  });
  it('has no countdown once the date has passed', () => {
    expect(handoverSummary('2026-10-01T00:00:00Z', now).countdown).toBeNull();
  });
});

describe('daysUntilDay', () => {
  const now = new Date('2026-11-09T10:00:00Z').getTime(); // 9 Nov IST
  it('counts whole IST days forward and backward', () => {
    expect(daysUntilDay('2026-11-14T00:00:00Z', now)).toBe(5);
    expect(daysUntilDay('2026-10-30T00:00:00Z', now)).toBe(-10);
  });
  it('is 0 for today even at the end of the IST day', () => {
    expect(daysUntilDay('2026-11-09T00:00:00Z', now)).toBe(0);
    // 18:29Z is 23:59 IST on 9 Nov - still today. (18:30Z is 00:00 IST on the
    // 10th, which is genuinely tomorrow; that boundary is covered above.)
    expect(daysUntilDay('2026-11-09T18:29:00Z', now)).toBe(0);
    expect(daysUntilDay('2026-11-09T18:30:00Z', now)).toBe(1);
  });
});

describe('milestoneEntries', () => {
  const m = (id: string, completedAt: string | null) => ({
    id,
    name: id,
    targetDate: null,
    completedAt,
  });

  it('marks the first unfinished row "next" and everything after it upcoming', () => {
    const states = milestoneEntries([
      m('a', '2026-10-01T00:00:00Z'),
      m('b', null),
      m('c', null),
    ]).map((e) => [e.milestone.id, e.state]);
    expect(states).toEqual([
      ['a', 'reached'],
      ['b', 'next'],
      ['c', 'upcoming'],
    ]);
  });

  it('preserves staff order - never re-sorts by date', () => {
    const ids = milestoneEntries([m('z', null), m('a', null)]).map((e) => e.milestone.id);
    expect(ids).toEqual(['z', 'a']);
  });

  it('marks nothing next when every row is reached', () => {
    const entries = milestoneEntries([m('a', '2026-10-01T00:00:00Z')]);
    expect(entries[0]?.state).toBe('reached');
  });

  it('is empty for no milestones', () => {
    expect(milestoneEntries([])).toEqual([]);
  });
});
