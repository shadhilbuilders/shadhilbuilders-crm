// UnitUpdateExtras (site update video, step 4).
//
// protects= the derived summary is right by construction: a newer clip with no
// stage moves neither the stage nor its date; counts split by kind; an empty
// unit is zero, not missing; the loader costs two statements for any page size.
// fails_when= a stageless video becomes the unit's stage, videos leak into
// photoCount, or the loader issues a statement per unit.
// no_claim= the SQL text is proved against a live database by hand in the step
// notes; this file proves the fold and the call shape.
import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@shadhil/database';

import {
  EMPTY_UNIT_UPDATE_EXTRAS,
  extrasFor,
  foldUnitUpdateExtras,
  loadUnitUpdateExtras,
  unitUpdateExtrasToWire,
} from './unit-update-summary';

const d = (iso: string) => new Date(iso);

describe('foldUnitUpdateExtras', () => {
  it('counts videos and every row, and takes the newest of any kind', () => {
    const out = foldUnitUpdateExtras(
      ['u1'],
      [
        { unitId: 'u1', kind: 'PHOTO', count: 3, newest: d('2026-11-10T00:00:00Z') },
        { unitId: 'u1', kind: 'VIDEO', count: 2, newest: d('2026-11-12T00:00:00Z') },
      ],
      [],
    );
    expect(out.get('u1')).toMatchObject({
      videoCount: 2,
      updateCount: 5,
      lastUpdateAt: d('2026-11-12T00:00:00Z'),
    });
  });

  it('a newer stageless clip moves neither the recorded stage nor its date', () => {
    // Risk 4 in the build sequence: the hero must not go blank.
    const out = foldUnitUpdateExtras(
      ['u1'],
      [
        { unitId: 'u1', kind: 'PHOTO', count: 1, newest: d('2026-11-10T00:00:00Z') },
        { unitId: 'u1', kind: 'VIDEO', count: 1, newest: d('2026-11-20T00:00:00Z') },
      ],
      [{ unitId: 'u1', stage: 'STRUCTURE', takenAt: d('2026-11-10T00:00:00Z') }],
    );
    const u1 = out.get('u1');
    expect(u1?.lastRecordedStage).toBe('STRUCTURE');
    expect(u1?.lastRecordedStageAt).toEqual(d('2026-11-10T00:00:00Z'));
    expect(u1?.lastUpdateAt).toEqual(d('2026-11-20T00:00:00Z'));
  });

  it('gives a unit with no rows the empty record, not a missing entry', () => {
    const out = foldUnitUpdateExtras(['u1', 'u2'], [], []);
    expect(out.get('u2')).toEqual(EMPTY_UNIT_UPDATE_EXTRAS);
  });

  it('keeps units apart', () => {
    const out = foldUnitUpdateExtras(
      ['u1', 'u2'],
      [{ unitId: 'u2', kind: 'VIDEO', count: 4, newest: d('2026-11-01T00:00:00Z') }],
      [{ unitId: 'u2', stage: 'READY', takenAt: d('2026-11-01T00:00:00Z') }],
    );
    expect(out.get('u1')?.updateCount).toBe(0);
    expect(out.get('u2')).toMatchObject({ videoCount: 4, lastRecordedStage: 'READY' });
  });

  it('treats a group with no timestamp as not newest', () => {
    const out = foldUnitUpdateExtras(
      ['u1'],
      [{ unitId: 'u1', kind: 'PHOTO', count: 1, newest: null }],
      [],
    );
    expect(out.get('u1')?.lastUpdateAt).toBeNull();
  });
});

describe('loadUnitUpdateExtras', () => {
  function fakeTx(grouped: unknown[], staged: unknown[]) {
    return {
      progressPhoto: { groupBy: vi.fn().mockResolvedValue(grouped) },
      $queryRaw: vi.fn().mockResolvedValue(staged),
    };
  }

  it('issues two statements for a whole page, never one per unit', async () => {
    const tx = fakeTx([], []);
    await loadUnitUpdateExtras(tx as unknown as PrismaClient, ['a', 'b', 'c', 'd', 'e']);
    expect(tx.progressPhoto.groupBy).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('scopes the grouped count to the requested units', async () => {
    const tx = fakeTx([], []);
    await loadUnitUpdateExtras(tx as unknown as PrismaClient, ['a', 'b']);
    expect(tx.progressPhoto.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['unitId', 'kind'],
        where: { unitId: { in: ['a', 'b'] } },
      }),
    );
  });

  it('runs nothing for an empty page', async () => {
    const tx = fakeTx([], []);
    expect((await loadUnitUpdateExtras(tx as unknown as PrismaClient, [])).size).toBe(0);
    expect(tx.progressPhoto.groupBy).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('only ever selects rows that recorded a stage for the stage lookup', async () => {
    const tx = fakeTx([], []);
    await loadUnitUpdateExtras(tx as unknown as PrismaClient, ['a']);
    const sql = String((tx.$queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?'));
    expect(sql).toMatch(/"stage" IS NOT NULL/);
    expect(sql).toMatch(/DISTINCT ON \("unitId"\)/);
  });

  it('folds the query results into per-unit extras', async () => {
    const tx = fakeTx(
      [
        {
          unitId: 'a',
          kind: 'VIDEO',
          _count: { _all: 2 },
          _max: { takenAt: d('2026-11-02T00:00:00Z') },
        },
      ],
      [{ unitId: 'a', stage: 'STRUCTURE', takenAt: d('2026-11-01T00:00:00Z') }],
    );
    const out = await loadUnitUpdateExtras(tx as unknown as PrismaClient, ['a']);
    expect(out.get('a')).toMatchObject({ videoCount: 2, lastRecordedStage: 'STRUCTURE' });
  });
});

describe('helpers', () => {
  it('extrasFor falls back to the empty record', () => {
    expect(extrasFor(new Map(), 'x')).toBe(EMPTY_UNIT_UPDATE_EXTRAS);
  });

  it('unitUpdateExtrasToWire emits ISO strings and nulls', () => {
    expect(unitUpdateExtrasToWire(EMPTY_UNIT_UPDATE_EXTRAS)).toEqual({
      videoCount: 0,
      updateCount: 0,
      lastUpdateAt: null,
      lastRecordedStage: null,
      lastRecordedStageAt: null,
    });
    expect(
      unitUpdateExtrasToWire({
        ...EMPTY_UNIT_UPDATE_EXTRAS,
        lastUpdateAt: d('2026-11-02T00:00:00Z'),
      }).lastUpdateAt,
    ).toBe('2026-11-02T00:00:00.000Z');
  });
});
