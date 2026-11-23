// The one mapper from a Prisma `Unit` row to the wire row every unit surface
// sends (`list`, `findOne`, `plots`).
//
// The point of this file is the last test: the mapper's output must satisfy
// `UnitRowSchema`, the contract the web app parses against. A unit row with a
// numeric price, or a missing phase name, would otherwise reach the browser
// looking fine in one grid and blank in another.

import { UnitRowSchema } from '@shadhil/api-types';
import { Prisma } from '@shadhil/database';
import { describe, expect, it } from 'vitest';

import {
  UNIT_ROW_SELECT,
  UNIT_ROW_SELECT_NO_MONEY,
  unitRowSelectFor,
  toUnitRow,
  type UnitRowSource,
} from './unit-row';

/** A row as `UNIT_ROW_SELECT` returns it, decimals and Date included. */
function source(overrides: Partial<Omit<UnitRowSource, 'plotNumber'>> = {}): UnitRowSource {
  return {
    id: 'unit-37',
    phaseId: 'phase-cmda',
    unitNumber: 'A-101',
    plotNumber: 37,
    bhk: 3,
    facing: 'East',
    sqft: 1450,
    buildupSqft: new Prisma.Decimal('1450.00'),
    pricePerSqft: new Prisma.Decimal('4000.00'),
    price: new Prisma.Decimal('5800000.00'),
    status: 'SOLD',
    expectedHandoverDate: null,
    assignedEngineerId: null,
    assignedEngineer: null,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    phase: { name: 'CMDA Plots', projectId: 'proj-1', project: { name: 'Demo Villas' } },
    // No photos by default: the common case for a freshly created villa.
    progressPhotos: [],
    _count: { progressPhotos: 0 },
    ...overrides,
  };
}

describe('toUnitRow', () => {
  it('maps the handover date to an ISO string, and null to null (never a guess)', () => {
    expect(toUnitRow(source(), true).expectedHandoverDate).toBeNull();
    const withDate = source({ expectedHandoverDate: new Date('2027-06-30T00:00:00.000Z') });
    expect(toUnitRow(withDate, true).expectedHandoverDate).toBe('2027-06-30T00:00:00.000Z');
    // The redacted (site-only) shape carries it too: it is not money.
    expect(toUnitRow(withDate, false).expectedHandoverDate).toBe('2027-06-30T00:00:00.000Z');
  });

  it('produces a row the shared wire schema accepts', () => {
    const row = toUnitRow(source(), true);
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
    expect(UnitRowSchema.parse(row)).toEqual(row);
  });

  it('serialises every Decimal column as a string, never a number', () => {
    // Prisma Decimal normalises on construction: Decimal('1450.00') prints
    // "1450". What matters on the wire is that it is a STRING - a number here
    // loses paise in JSON and fails the schema.
    const row = toUnitRow(source(), true);
    expect(row.buildupSqft).toBe('1450');
    expect(row.pricePerSqft).toBe('4000');
    expect(row.price).toBe('5800000');
    expect(typeof row.price).toBe('string');
  });

  it('sends the timestamp as an ISO string, not a Date object', () => {
    expect(toUnitRow(source(), true).createdAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('flattens the phase and project names off the relation', () => {
    const row = toUnitRow(source(), true);
    expect(row.phaseId).toBe('phase-cmda');
    expect(row.phaseName).toBe('CMDA Plots');
    expect(row.projectId).toBe('proj-1');
    expect(row.projectName).toBe('Demo Villas');
  });

  it('carries a null facing and a null plot sq.ft through unchanged', () => {
    // Both are nullable in the schema; turning either into 0 or '' would read as
    // a real value on the grid.
    const row = toUnitRow(source({ facing: null, sqft: null }), true);
    expect(row.facing).toBeNull();
    expect(row.sqft).toBeNull();
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('carries a null plot number, which is what "not on the layout" looks like', () => {
    // Most villas start with no plot number. The map reads every plot as
    // available for them; nothing here may turn that into a plot.
    const row = toUnitRow({ ...source(), plotNumber: null }, true);
    expect(row.plotNumber).toBeNull();
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('selects every column the schema needs, in one shared select', () => {
    // Guards the failure that a dropped column would cause: `undefined` reaches
    // the wire and the schema rejects the whole row on the browser side.
    for (const column of [
      'id',
      'phaseId',
      'unitNumber',
      'plotNumber',
      'bhk',
      'facing',
      'sqft',
      'buildupSqft',
      'pricePerSqft',
      'price',
      'status',
      'createdAt',
      'phase',
      // Documentation state (2026-11-08): the site home page's counts and
      // sort read these, so they must come from the same select.
      'progressPhotos',
      '_count',
    ]) {
      expect(Object.keys(UNIT_ROW_SELECT)).toContain(column);
    }
    expect(UNIT_ROW_SELECT.phase.select.name).toBe(true);
    expect(UNIT_ROW_SELECT.phase.select.project.select.name).toBe(true);
  });

  it('reads only the newest photo, ordered by takenAt desc', () => {
    // take: 1 + orderBy is what makes `lastPhotoAt` the NEWEST capture without
    // loading a whole timeline for every row of the grid.
    expect(UNIT_ROW_SELECT.progressPhotos.take).toBe(1);
    expect(UNIT_ROW_SELECT.progressPhotos.orderBy).toEqual({ takenAt: 'desc' });
    expect(UNIT_ROW_SELECT.progressPhotos.select.takenAt).toBe(true);
  });

  it('pins the money columns to the privileged select only', () => {
    // This is the security property: the redacted select must not name the
    // price columns AT ALL, so the database never reads them for a role that
    // may not see them. A test that only checked the mapper could pass while
    // the query still fetched the values.
    expect(Object.keys(UNIT_ROW_SELECT)).toContain('price');
    expect(Object.keys(UNIT_ROW_SELECT)).toContain('pricePerSqft');
    expect(Object.keys(UNIT_ROW_SELECT_NO_MONEY)).not.toContain('price');
    expect(Object.keys(UNIT_ROW_SELECT_NO_MONEY)).not.toContain('pricePerSqft');
  });

  it('keeps every non-money column in the redacted select', () => {
    // Redaction must not cost a site screen a field it needs. Diff the two
    // selects and assert the ONLY removals are the two money columns.
    const removed = Object.keys(UNIT_ROW_SELECT).filter(
      (key) => !(key in UNIT_ROW_SELECT_NO_MONEY),
    );
    expect(removed.sort()).toEqual(['price', 'pricePerSqft']);
  });

  it('chooses the select by audience, with no third option', () => {
    expect(unitRowSelectFor(true)).toBe(UNIT_ROW_SELECT);
    expect(unitRowSelectFor(false)).toBe(UNIT_ROW_SELECT_NO_MONEY);
  });

  it('derives lastPhotoAt and photoCount from the newest photo and the count', () => {
    const row = toUnitRow(
      source({
        progressPhotos: [{ takenAt: new Date('2026-11-06T04:30:00.000Z'), stage: 'STRUCTURE' }],
        _count: { progressPhotos: 4 },
      }),
      true,
    );
    expect(row.lastPhotoAt).toBe('2026-11-06T04:30:00.000Z');
    expect(row.photoCount).toBe(4);
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('sends null for a unit with no photos, never a zero date or a fake count', () => {
    const row = toUnitRow(source(), true);
    expect(row.lastPhotoAt).toBeNull();
    expect(row.photoCount).toBe(0);
    expect(row.lastPhotoStage).toBeNull();
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('derives lastPhotoStage from the newest photo and keeps null when unrecorded', () => {
    const staged = toUnitRow(
      source({
        progressPhotos: [{ takenAt: new Date('2026-11-06T04:30:00.000Z'), stage: 'READY' }],
        _count: { progressPhotos: 1 },
      }),
      true,
    );
    expect(staged.lastPhotoStage).toBe('READY');

    // Null on the newest photo is "not recorded", NOT "not started".
    const unstaged = toUnitRow(
      source({
        progressPhotos: [{ takenAt: new Date('2026-11-06T04:30:00.000Z'), stage: null }],
        _count: { progressPhotos: 1 },
      }),
      true,
    );
    expect(unstaged.lastPhotoStage).toBeNull();
    expect(() => UnitRowSchema.parse(unstaged)).not.toThrow();
  });
});

// Money is audience-gated (2026-11-08): a site-only role (ENGINEER) must not
// receive villa pricing at all. These tests pin the REDACTION, not a hidden
// column - the number never leaves the database.
describe('toUnitRow - money audience', () => {
  it('nulls both money fields when the caller may not see them', () => {
    const row = toUnitRow(source(), false);
    // Null, not 0 and not undefined: 0 reads as "free", undefined reads as
    // "the API forgot". Null is the honest "not yours to see".
    expect(row.price).toBeNull();
    expect(row.pricePerSqft).toBeNull();
  });

  it('still sends every non-money field a redacted row needs', () => {
    // The whole point is that hiding prices does not break the site screens:
    // door/plot number, dimensions, status and documentation state all remain.
    const row = toUnitRow(source(), false);
    expect(row.unitNumber).toBe('A-101');
    expect(row.plotNumber).toBe(37);
    expect(row.bhk).toBe(3);
    expect(row.sqft).toBe(1450);
    expect(row.buildupSqft).toBe('1450');
    expect(row.status).toBe('SOLD');
    expect(row.phaseName).toBe('CMDA Plots');
  });

  it('produces a redacted row the shared wire schema still accepts', () => {
    // The schema must allow null money, or every engineer's request 500s on
    // parse instead of rendering the site screens.
    const row = toUnitRow(source(), false);
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('throws (500) when a money-visible actor arrives without price columns', () => {
    // The two audiences are passed to `unitRowSelectFor` and `toUnitRow`
    // separately. If a caller ever pairs the redacted select with
    // `canSeeMoney: true`, the row would silently carry undefined prices -
    // fail loudly instead of shipping a blank column.
    expect(() => toUnitRow(source(), true)).not.toThrow();
    const redacted = { ...source() } as Record<string, unknown>;
    delete redacted['price'];
    delete redacted['pricePerSqft'];
    expect(() => toUnitRow(redacted as never, true)).toThrow(/different audiences/);
  });
});

describe('toUnitRow - update summary extras (site update video, step 4)', () => {
  it('omits the new fields when the caller did not load them, rather than sending zeros', () => {
    const row = toUnitRow(source(), true);
    expect('videoCount' in row).toBe(false);
    expect('updateCount' in row).toBe(false);
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('sends the loaded extras alongside the unchanged photo-only fields', () => {
    const row = toUnitRow(
      source({
        progressPhotos: [{ takenAt: new Date('2026-11-06T04:30:00.000Z'), stage: 'READY' }],
        _count: { progressPhotos: 2 },
      }),
      true,
      {
        videoCount: 1,
        updateCount: 3,
        lastUpdateAt: new Date('2026-11-09T04:30:00.000Z'),
        lastRecordedStage: 'READY',
        lastRecordedStageAt: new Date('2026-11-06T04:30:00.000Z'),
      },
    );
    expect(row).toMatchObject({
      photoCount: 2,
      lastPhotoStage: 'READY',
      videoCount: 1,
      updateCount: 3,
      lastUpdateAt: '2026-11-09T04:30:00.000Z',
      lastRecordedStage: 'READY',
      lastRecordedStageAt: '2026-11-06T04:30:00.000Z',
    });
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('selects only PHOTO rows for the legacy fields, so a clip never becomes "the newest photo"', () => {
    expect(UNIT_ROW_SELECT.progressPhotos.where).toEqual({ kind: 'PHOTO' });
    expect(UNIT_ROW_SELECT_NO_MONEY.progressPhotos.where).toEqual({ kind: 'PHOTO' });
    expect(UNIT_ROW_SELECT._count.select.progressPhotos).toEqual({ where: { kind: 'PHOTO' } });
    expect(UNIT_ROW_SELECT_NO_MONEY._count.select.progressPhotos).toEqual({
      where: { kind: 'PHOTO' },
    });
  });
});
