// Soft-delete read filters - ONE definition per relation, so a new query
// cannot silently forget them.
//
// WHY THIS EXISTS (2026-10-01). `Project.deletedAt` was added for soft delete
// (autoplan 2026-09-09), but the filter was only applied to the project
// REGISTRY queries. Every other surface that counted or named projects kept
// reading the raw table, so a soft-deleted project still appeared. Live
// reproduction: the owner created a project, deleted it, and the admin Users
// table still showed "1 project" on the owner's row.
//
// The class of bug is the one `references/soft-delete.md` already warns about
// - "a new nullable column = existing findMany silently returns soft-deleted
// rows until filters are added" - and the reason it recurred is that the
// filter was hand-written at each site. Hence a shared constant.
//
// Use `PROJECT_ACTIVE` for a direct `project.findMany/findFirst` where, and
// `LEAD_IN_ACTIVE_PROJECT` for any Lead read that must ignore leads sitting on
// a soft-deleted project (lists, counts, KPIs, alert scans).

/**
 * A Project row that is not soft-deleted. Spread into a `project.*` where.
 *
 *   client.project.findMany({ where: { organizationId, ...PROJECT_ACTIVE } })
 */
export const PROJECT_ACTIVE = { deletedAt: null } as const;

/**
 * A Lead whose project is not soft-deleted.
 *
 * A soft-deleted project keeps its leads (Lead.project's FK is RESTRICT, so
 * they survive by design and stay queryable for audit). Product decision
 * 2026-10-01: those leads are work on a deleted project, so they are excluded
 * from lists, counts and KPIs - the same treatment the project itself gets.
 *
 *   client.lead.findMany({ where: { ...existing, ...LEAD_IN_ACTIVE_PROJECT } })
 *
 * NOTE this is a to-one relation filter, so it composes with any other Lead
 * predicate (including `OR` clauses) without needing an explicit AND.
 */
export const LEAD_IN_ACTIVE_PROJECT = {
  project: { deletedAt: null },
} as const;

/**
 * A ProjectTeam link whose project AND team are both live.
 *
 * A user's "projects" column is derived from their team's ProjectTeam rows, so
 * the project filter has to be applied on the relation - filtering the link
 * table alone is not enough.
 *
 *   client.projectTeam.findMany({ where: { teamId: { in: ids }, ...PROJECT_TEAM_LIVE } })
 */
export const PROJECT_TEAM_LIVE = {
  project: { deletedAt: null },
  team: { deletedAt: null },
} as const;

/**
 * True when a row fetched by `findUnique` is unusable because it is
 * soft-deleted. For the accept-a-project-id write guards: `findUnique` only
 * accepts unique columns in `where`, so `deletedAt` cannot be pushed into the
 * query and the caller must check the loaded row.
 *
 *   const p = await tx.project.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
 *   if (p === null || isSoftDeleted(p)) throw new NotFoundException(...);
 */
export function isSoftDeleted(row: { deletedAt: Date | null }): boolean {
  return row.deletedAt !== null;
}
