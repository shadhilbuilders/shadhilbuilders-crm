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

import { UNIT_ROW_SELECT, toUnitRow, type UnitRowSource } from './unit-row';

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
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    phase: { name: 'CMDA Plots', projectId: 'proj-1', project: { name: 'Demo Villas' } },
    ...overrides,
  };
}

describe('toUnitRow', () => {
  it('produces a row the shared wire schema accepts', () => {
    const row = toUnitRow(source());
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
    expect(UnitRowSchema.parse(row)).toEqual(row);
  });

  it('serialises every Decimal column as a string, never a number', () => {
    // Prisma Decimal normalises on construction: Decimal('1450.00') prints
    // "1450". What matters on the wire is that it is a STRING - a number here
    // loses paise in JSON and fails the schema.
    const row = toUnitRow(source());
    expect(row.buildupSqft).toBe('1450');
    expect(row.pricePerSqft).toBe('4000');
    expect(row.price).toBe('5800000');
    expect(typeof row.price).toBe('string');
  });

  it('sends the timestamp as an ISO string, not a Date object', () => {
    expect(toUnitRow(source()).createdAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('flattens the phase and project names off the relation', () => {
    const row = toUnitRow(source());
    expect(row.phaseId).toBe('phase-cmda');
    expect(row.phaseName).toBe('CMDA Plots');
    expect(row.projectId).toBe('proj-1');
    expect(row.projectName).toBe('Demo Villas');
  });

  it('carries a null facing and a null plot sq.ft through unchanged', () => {
    // Both are nullable in the schema; turning either into 0 or '' would read as
    // a real value on the grid.
    const row = toUnitRow(source({ facing: null, sqft: null }));
    expect(row.facing).toBeNull();
    expect(row.sqft).toBeNull();
    expect(() => UnitRowSchema.parse(row)).not.toThrow();
  });

  it('carries a null plot number, which is what "not on the layout" looks like', () => {
    // Most villas start with no plot number. The map reads every plot as
    // available for them; nothing here may turn that into a plot.
    const row = toUnitRow({ ...source(), plotNumber: null });
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
    ]) {
      expect(Object.keys(UNIT_ROW_SELECT)).toContain(column);
    }
    expect(UNIT_ROW_SELECT.phase.select.name).toBe(true);
    expect(UNIT_ROW_SELECT.phase.select.project.select.name).toBe(true);
  });
});
