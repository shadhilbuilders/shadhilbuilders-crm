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
import { InternalServerErrorException } from '@nestjs/common';
import type { Prisma } from '@shadhil/database';

/**
 * The unit columns every unit surface sends, plus the phase/project names the
 * grids denormalize so the UI needs no second lookup.
 *
 * MONEY IS AUDIENCE-DEPENDENT (2026-11-08). `price`/`pricePerSqft` are listed
 * here for the privileged shape only; a site-only role (ENGINEER) reads the
 * same villas through `UNIT_ROW_SELECT_NO_MONEY` and never receives a rupee
 * figure at all. Hiding the column in the grid was not enough - the number was
 * still in the JSON, one devtools panel away.
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
  expectedHandoverDate: true,
  assignedEngineerId: true,
  assignedEngineer: { select: { name: true } },
  createdAt: true,
  phase: {
    select: { name: true, projectId: true, project: { select: { name: true } } },
  },
  // Documentation state (2026-11-08): the site home page answers "which villa
  // have I not photographed yet", and that answer needs a real timestamp and a
  // real count - not something the browser invents. The newest photo's
  // `takenAt` drives the four-state map; `_count` gives the feed size.
  progressPhotos: {
    select: { takenAt: true, stage: true },
    orderBy: { takenAt: 'desc' },
    take: 1,
  },
  _count: { select: { progressPhotos: true } },
} as const satisfies Prisma.UnitSelect;

/**
 * The SAME row minus the money columns.
 *
 * Everything a site-only role legitimately needs (door/plot number, BHK,
 * facing, areas, status, documentation state) and nothing that prices the
 * villa. `buildupSqft`/`sqft` stay: they are dimensions of a building, not
 * its value, and the engineer's own screens show them.
 */
export const UNIT_ROW_SELECT_NO_MONEY = {
  id: true,
  phaseId: true,
  unitNumber: true,
  plotNumber: true,
  bhk: true,
  facing: true,
  sqft: true,
  buildupSqft: true,
  status: true,
  expectedHandoverDate: true,
  assignedEngineerId: true,
  assignedEngineer: { select: { name: true } },
  createdAt: true,
  phase: {
    select: { name: true, projectId: true, project: { select: { name: true } } },
  },
  progressPhotos: {
    select: { takenAt: true, stage: true },
    orderBy: { takenAt: 'desc' },
    take: 1,
  },
  _count: { select: { progressPhotos: true } },
} as const satisfies Prisma.UnitSelect;

/**
 * The select for a given audience. Every read path calls this, so a new unit
 * surface cannot pick the money shape by accident: passing `canSeeMoney:
 * false` is the only way to build a redacted row, and the mapper below has no
 * branch that fills prices back in.
 */
export function unitRowSelectFor(canSeeMoney: boolean) {
  return canSeeMoney ? UNIT_ROW_SELECT : UNIT_ROW_SELECT_NO_MONEY;
}

/** The row `UNIT_ROW_SELECT` returns. */
export type UnitRowSource = Prisma.UnitGetPayload<{ select: typeof UNIT_ROW_SELECT }>;

/** The row `UNIT_ROW_SELECT_NO_MONEY` returns (no `price`/`pricePerSqft`). */
export type UnitRowSourceRedacted = Prisma.UnitGetPayload<{
  select: typeof UNIT_ROW_SELECT_NO_MONEY;
}>;

/**
 * Map a unit row to the wire shape.
 *
 * Decimals become strings because that is how Prisma Decimal serialises over
 * JSON, and `createdAt` becomes an ISO string so the schema's datetime check
 * passes on the wire.
 *
 * MONEY IS PASSED IN, NOT READ OFF THE ROW (2026-11-08). `canSeeMoney` mirrors
 * the select that produced `row`: a redacted row has no Decimal columns, so
 * asking for `row.price` would be a compile error (the union below makes the
 * two shapes unmistakable) and a runtime `undefined` at worst. The mapper
 * cannot invent a price back, which is the point - the redaction happens in
 * SQL, and everything downstream only ever REFLECTS it.
 */
export function toUnitRow(
  row: UnitRowSource | UnitRowSourceRedacted,
  canSeeMoney: boolean,
): UnitRow {
  // Newest photo = the unit's current documentation state. `progressPhotos` is
  // selected with take: 1 ordered by takenAt DESC, so index 0 is the newest.
  const newestPhoto = row.progressPhotos[0];
  const base = {
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
    status: row.status,
    // Null (not a zero date) when the unit has no photos: "never photographed"
    // must never be confused with "photographed long ago".
    lastPhotoAt: newestPhoto?.takenAt.toISOString() ?? null,
    photoCount: row._count.progressPhotos,
    // Derived from the newest photo, never denormalized. Null means the newest
    // capture recorded no stage - every surface then says "Stage not set".
    lastPhotoStage: newestPhoto?.stage ?? null,
    expectedHandoverDate: row.expectedHandoverDate?.toISOString() ?? null,
    assignedEngineerId: row.assignedEngineerId,
    assignedEngineerName: row.assignedEngineer?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  };

  if (!canSeeMoney) {
    // Null, never 0 and never omitted: a zero reads as "free", a missing key
    // reads as "the API forgot". Null says "this figure is not yours to see".
    return { ...base, pricePerSqft: null, price: null };
  }

  // The money arm receives the privileged shape; `in` narrows the union so a
  // redacted row can never reach these field reads by mistake.
  if (!('price' in row) || !('pricePerSqft' in row)) {
    throw new InternalServerErrorException(
      'Unit row is missing price columns but the actor may see money. ' +
        'The select and the mapper were called with different audiences - ' +
        'pass the same `canSeeMoney` to `unitRowSelectFor` and `toUnitRow`.',
    );
  }
  return {
    ...base,
    pricePerSqft: row.pricePerSqft.toString(),
    price: row.price.toString(),
  };
}
