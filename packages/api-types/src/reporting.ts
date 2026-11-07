// ────────────────────────────────────────────────────────────────────────────
// Reporting line ("Reports to") - single source of truth.
// ────────────────────────────────────────────────────────────────────────────
// T-REPORTS-TO-OWNER (2026-10-06) established that "who does this user report
// to" depends on the TARGET's own role, not on one rule:
//
//   TELECALLER / SALES_EXEC / ENGINEER -> their linked team's manager
//   MANAGER / ADMIN                    -> the org OWNER (fixed)
//   OWNER                              -> nobody
//   CUSTOMER                           -> nobody (buyer portal; no staff line)
//
// WHY THIS FILE EXISTS (2026-11-07): the rule used to be copy-pasted as a bare
// role union (`role === 'TELECALLER' || role === 'SALES_EXEC'`) in the backend
// read paths and as a different negative check in the team roster. ENGINEER was
// added by issue #7 slice 1 three weeks after this rule shipped, appeared in
// none of the positive unions, and so silently rendered "Reports to: -" on the
// Users table while the team roster showed the manager for the same person.
// TypeScript could not catch it because a bare `===` union is not exhaustive.
//
// The map below IS exhaustive (`Record<Role, ReportingTarget>`), so adding a
// Role to `RoleSchema` without deciding its reporting line is a BUILD ERROR.
// That is the whole point: do not "fix" a missing role by widening a union at a
// call site, add it here and let the compiler point at every consumer.
//
// Pure + framework-free on purpose: `apps/backend/src/users/roles.ts` imports
// @nestjs/common and therefore cannot be consumed by the Next.js app. This
// module has no imports beyond the Role type, so both apps share one rule.
// ────────────────────────────────────────────────────────────────────────────

import { RoleSchema, type Role } from './enums';

/**
 * Where a role's "Reports to" value comes from.
 *
 * - `TEAM_MANAGER` - resolved from the user's team membership -> Team.managerId.
 *   Assignable via PATCH /api/users/:id/manager.
 * - `ORG_OWNER`    - the single org OWNER. Fixed, never assignable.
 * - `NONE`         - reports to nobody; surfaces omit the row entirely.
 */
export type ReportingTarget = 'TEAM_MANAGER' | 'ORG_OWNER' | 'NONE';

/**
 * Exhaustive role -> reporting-target map. Add a role, fix the compile error.
 *
 * ENGINEER sits with TELECALLER/SALES_EXEC: they are ordinary team staff
 * (TeamMember rows), so their reporting line is the manager of the team(s) they
 * belong to - the same `Team.managerId` that already governs their project
 * access through TeamMember -> ProjectTeam under RLS.
 */
export const REPORTING_TARGET_BY_ROLE: Readonly<Record<Role, ReportingTarget>> = {
  OWNER: 'NONE',
  ADMIN: 'ORG_OWNER',
  MANAGER: 'ORG_OWNER',
  SALES_EXEC: 'TEAM_MANAGER',
  TELECALLER: 'TEAM_MANAGER',
  // Issue #7 slice 1: site staff. Team-linked, so team-manager reporting.
  ENGINEER: 'TEAM_MANAGER',
  // Issue #8 slice 2: buyer login. Not staff - no reporting line at all.
  // (Before this file existed, `showReportsTo = role !== 'OWNER'` gave CUSTOMER
  // a bogus "No manager assigned" row on the user detail page.)
  CUSTOMER: 'NONE',
};

/**
 * Resolve a role's reporting target. Total over `Role` - never returns
 * undefined, never throws, never guesses from an unknown string.
 */
export function reportingTargetFor(role: Role): ReportingTarget {
  return REPORTING_TARGET_BY_ROLE[role];
}

/**
 * Tolerant variant for values that arrive as a plain `string` (API rows whose
 * role field is typed loosely, e.g. `TeamMemberRow.role`).
 *
 * Unknown values resolve to `NONE` - fail closed. An unrecognised role must
 * never be shown a manager it may not report to.
 */
export function reportingTargetForRole(role: string): ReportingTarget {
  const parsed = RoleSchema.safeParse(role);
  return parsed.success ? REPORTING_TARGET_BY_ROLE[parsed.data] : 'NONE';
}

/**
 * True when the role's "Reports to" is their team's manager (i.e. the value is
 * derived from `Team.managerId` and is therefore ASSIGNABLE).
 *
 * Backend read paths use this to decide which users need a manager lookup;
 * write paths use it to decide who may be assigned.
 */
export function reportsToTeamManager(role: Role): boolean {
  return reportingTargetFor(role) === 'TEAM_MANAGER';
}

/** True when the role has a "Reports to" row at all (anything except `NONE`). */
export function hasReportingLine(role: Role): boolean {
  return reportingTargetFor(role) !== 'NONE';
}
