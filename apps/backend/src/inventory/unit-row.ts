// One place that turns a Prisma `Unit` row into the wire row `UnitRowSchema`
// describes.
//
// WHY IT EXISTS: `list()`, `findOne()` and now `plots()` all return the same
// unit shape, and each of them used to hand-write the select and the
// field-by-field mapping. Three copies of a 14-field literal is how one surface
// ends up sending `price` as a number, or dropping `phaseName`, while the
// others stay right - and the mismatch only shows up as a blank column in one
// grid. `unit-row.test.ts` pins the output against `UnitRowSchema`, so the
// contract cannot drift from the mapper in silence.
//
// Kept in its own module (like `unit-status-rank.ts`) so a test can import it
// without building the Nest provider graph.

import type { UnitRow } from '@shadhil/api-types';
import type { Prisma } from '@shadhil/database';

/**
 * The unit columns every unit surface sends, plus the phase/project names the
 * grids denormalize so the UI needs no second lookup.
 */
export const UNIT_ROW_SELECT = {
  id: true,
  phaseId: true,
  unitNumber: true,
  // The plot map's join key: the villa's position on the layout, NOT a parse of
  // `unitNumber` (the door number).
  plotNumber: true,
  bhk: true,
  facing: true,
  sqft: true,
  buildupSqft: true,
  pricePerSqft: true,
  price: true,
  status: true,
  createdAt: true,
  phase: {
    select: { name: true, projectId: true, project: { select: { name: true } } },
  },
} as const satisfies Prisma.UnitSelect;

/** The row `UNIT_ROW_SELECT` returns. */
export type UnitRowSource = Prisma.UnitGetPayload<{ select: typeof UNIT_ROW_SELECT }>;

/**
 * Map a unit row to the wire shape.
 *
 * Decimals become strings because that is how Prisma Decimal serialises over
 * JSON, and `createdAt` becomes an ISO string so the schema's datetime check
 * passes on the wire.
 */
export function toUnitRow(row: UnitRowSource): UnitRow {
  return {
    id: row.id,
    phaseId: row.phaseId,
    phaseName: row.phase.name,
    projectId: row.phase.projectId,
    projectName: row.phase.project.name,
    unitNumber: row.unitNumber,
    plotNumber: row.plotNumber,
    bhk: row.bhk,
    facing: row.facing,
    sqft: row.sqft,
    buildupSqft: row.buildupSqft.toString(),
    pricePerSqft: row.pricePerSqft.toString(),
    price: row.price.toString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
