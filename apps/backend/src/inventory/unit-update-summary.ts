// The video-aware half of a unit's update summary (site update video, step 4).
//
// WHY A SECOND QUERY: Prisma can select a relation once per query, and the
// units grid needs it three ways (newest photo, counts by kind, newest row
// that recorded a stage). The photo-only fields stay in `UNIT_ROW_SELECT`,
// filtered to PHOTO so they never start counting clips. Everything that needs
// to see videos is computed here, for a whole page of units in two statements
// (one grouped count, one DISTINCT ON), never one per row.
//
// Both statements run on the caller's RLS transaction, so a unit the actor
// cannot see contributes nothing.
import type { ConstructionStage } from '@shadhil/api-types';
import { Prisma, type PrismaClient } from '@shadhil/database';

export interface UnitUpdateExtras {
  videoCount: number;
  /** Every row, photo or video, tombstones included. */
  updateCount: number;
  lastUpdateAt: Date | null;
  /** Stage of the newest row WHERE stage IS NOT NULL, whatever its kind. */
  lastRecordedStage: ConstructionStage | null;
  lastRecordedStageAt: Date | null;
}

/** A unit with no rows at all: the truth for a villa that was just created. */
export const EMPTY_UNIT_UPDATE_EXTRAS: UnitUpdateExtras = Object.freeze({
  videoCount: 0,
  updateCount: 0,
  lastUpdateAt: null,
  lastRecordedStage: null,
  lastRecordedStageAt: null,
});

interface KindGroup {
  unitId: string;
  kind: 'PHOTO' | 'VIDEO';
  count: number;
  newest: Date | null;
}

interface StagedRow {
  unitId: string;
  stage: ConstructionStage;
  takenAt: Date;
}

/** Pure fold of the two query results into one extras record per unit. */
export function foldUnitUpdateExtras(
  unitIds: readonly string[],
  groups: readonly KindGroup[],
  staged: readonly StagedRow[],
): Map<string, UnitUpdateExtras> {
  const stagedByUnit = new Map(staged.map((s) => [s.unitId, s]));
  const out = new Map<string, UnitUpdateExtras>();
  for (const unitId of unitIds) {
    const mine = groups.filter((g) => g.unitId === unitId);
    const newest = mine.reduce<Date | null>(
      (acc, g) => (g.newest !== null && (acc === null || g.newest > acc) ? g.newest : acc),
      null,
    );
    const stagedRow = stagedByUnit.get(unitId);
    out.set(unitId, {
      videoCount: mine.find((g) => g.kind === 'VIDEO')?.count ?? 0,
      updateCount: mine.reduce((sum, g) => sum + g.count, 0),
      lastUpdateAt: newest,
      lastRecordedStage: stagedRow?.stage ?? null,
      lastRecordedStageAt: stagedRow?.takenAt ?? null,
    });
  }
  return out;
}

/** Two statements for the whole page, scoped by the caller's RLS context. */
export async function loadUnitUpdateExtras(
  tx: PrismaClient,
  unitIds: readonly string[],
): Promise<Map<string, UnitUpdateExtras>> {
  if (unitIds.length === 0) return new Map();
  const ids = [...unitIds];
  const [grouped, staged] = await Promise.all([
    tx.progressPhoto.groupBy({
      by: ['unitId', 'kind'],
      where: { unitId: { in: ids } },
      _count: { _all: true },
      _max: { takenAt: true },
    }),
    tx.$queryRaw<StagedRow[]>(Prisma.sql`
      SELECT DISTINCT ON ("unitId") "unitId", "stage"::text AS "stage", "takenAt"
      FROM "ProgressPhoto"
      WHERE "unitId" IN (${Prisma.join(ids)}) AND "stage" IS NOT NULL
      ORDER BY "unitId", "takenAt" DESC, "createdAt" DESC
    `),
  ]);
  const groups: KindGroup[] = grouped.map((g) => ({
    unitId: g.unitId,
    kind: g.kind,
    count: g._count._all,
    newest: g._max.takenAt,
  }));
  return foldUnitUpdateExtras(ids, groups, staged);
}

/** The extras for one unit, or the empty record when none were loaded for it. */
export function extrasFor(map: ReadonlyMap<string, UnitUpdateExtras>, unitId: string) {
  return map.get(unitId) ?? EMPTY_UNIT_UPDATE_EXTRAS;
}

/** Wire fields for `UnitRow`; dates become ISO strings. */
export function unitUpdateExtrasToWire(extras: UnitUpdateExtras) {
  return {
    videoCount: extras.videoCount,
    updateCount: extras.updateCount,
    lastUpdateAt: extras.lastUpdateAt?.toISOString() ?? null,
    lastRecordedStage: extras.lastRecordedStage,
    lastRecordedStageAt: extras.lastRecordedStageAt?.toISOString() ?? null,
  };
}
