import type { UnitStatus } from '@shadhil/api-types';

// T-INV-SORT (2026-09-25): the order the villa inventory grid lists units in -
// on-hold first (a hold or token needs staff attention), then what is still
// sellable, then the ones that are gone.
//
// Lives in its own module so the ordering rule is importable by both the
// service that applies it and the test that asserts every UnitStatus is
// ranked. Inlining it in the service would make that coverage check reach into
// the Nest provider graph for a constant.
//
// Why the rank map exists at all: Prisma cannot order an enum by a custom
// sequence. `orderBy: { status: 'asc' }` sorts by the enum's DECLARATION order
// (AVAILABLE, HOLD, TOKEN, SOLD) - close to the reverse of what is wanted - so
// `list()` ranks rows from this map instead.

/** Status -> sort rank. Lower sorts first. TOKEN sits after AVAILABLE: a unit
 *  with a token is not sold, but it is further along than an open one. */
export const UNIT_STATUS_RANK: ReadonlyArray<readonly [UnitStatus, number]> = [
  ['HOLD', 0],
  ['AVAILABLE', 1],
  ['TOKEN', 2],
  ['SOLD', 3],
];

/** Rank for a status, defaulting to the tail so an unranked value degrades to
 *  a visible ordering oddity rather than an exception on the whole grid. */
export function unitStatusRank(status: string): number {
  return UNIT_STATUS_RANK.find(([s]) => s === status)?.[1] ?? 999;
}
