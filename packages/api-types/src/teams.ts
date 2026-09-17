// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Team DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// The Team table is the staffing group (manager + members, via User.teamId).
// These shapes back the ADMIN/OWNER org-Teams pages:
//   GET /api/teams       -> TeamListItem[] (list; every authenticated role,
//                           RLS-scoped - used by the create-user dialog).
//   GET /api/teams/:id   -> TeamDetail (ADMIN/OWNER only; simple roster).
//
// T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): TeamDetail's members no
// longer carry a per-member `projects` list - that was ProjectMember-
// derived, and ProjectMember was retired (design doc: "per-user project
// exceptions" are Not in Scope). Project staffing is exclusively team-based
// now (see team-membership.ts's ProjectTeamRowSchema) - "which projects is
// this member on" is the SAME answer for every member of a team (whichever
// projects the TEAM is linked to via ProjectTeam), so it belongs on the
// per-project Staff page, not duplicated per-row on the team roster.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * Row shape for GET /api/teams (the create-user dialog + admin switcher).
 * `memberCount` = number of users whose teamId points at this team.
 * `managerName` = the team manager's display name (null when unassigned).
 */
export const TeamListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  defaultAssigneeId: z.string().nullable().optional(),
  memberCount: z.number().int().min(0),
  managerId: z.string().nullable().optional(),
  managerName: z.string().nullable(),
  // T-AUTOASSIGN (2026-09-17): how this team routes NEW leads. Surfaced on the
  // list item so the admin roster/edit UI can toggle it.
  autoAssignLeads: z.boolean().optional(),
});
export type TeamListItem = z.infer<typeof TeamListItemSchema>;

/** One team member on the roster. */
export const TeamMemberRowSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(), // RoleSchema
  // T-AUTOASSIGN (2026-09-17): relative routing weight for the auto-assign
  // lead engine (higher = biased toward more leads). Default 1.
  weight: z.number().int().min(0),
});
export type TeamMemberRow = z.infer<typeof TeamMemberRowSchema>;

/**
 * GET /api/teams/:id body - the roster for the org-Teams page.
 * `manager` mirrors the manager's basic identity (null when unassigned).
 * Members are User rows whose teamId matches this team, ordered by name.
 */
export const TeamDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  manager: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    })
    .nullable(),
  members: z.array(TeamMemberRowSchema),
});
export type TeamDetail = z.infer<typeof TeamDetailSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Team CRUD + reassign (T-TEAM-CRUD, 2026-09-13)
// ────────────────────────────────────────────────────────────────────────────
//   POST   /api/teams                    -> ADMIN/OWNER only
//   PATCH  /api/teams/:id                -> ADMIN/OWNER only
//   DELETE /api/teams/:id                -> ADMIN/OWNER only; 409 when the
//                                            team still has members or an
//                                            active manager
//   POST   /api/teams/:id/reassign-members -> ADMIN/OWNER only; omit
//                                            `userIds` to move every member
//                                            (bulk one-click), pass ids to
//                                            move only those members

/**
 * POST /api/teams body. `managerId` must reference an existing `MANAGER`
 * user who does not already lead a different (active) team - the service
 * enforces both, this schema only validates shape.
 */
export const CreateTeamDtoSchema = z.object({
  name: z.string({
    error: 'Name is required',
  }).trim().min(1).max(120),
  managerId: z.cuid2().nullable().optional(),
  // T-AUTOASSIGN (2026-09-17): how this team routes NEW leads. When true,
  // new leads auto-assign to the least-loaded telecaller across ALL project
  // teams (openLeads/weight). When false/omitted, new leads land owned by the
  // team's manager (manager owns until handoff). Default false.
  autoAssignLeads: z.boolean().optional(),
});
export type CreateTeamDto = z.infer<typeof CreateTeamDtoSchema>;

/**
 * PATCH /api/teams/:id body - partial. Omitted fields keep their value;
 * explicit `null` for `managerId` clears the manager (required before the
 * team can be deleted). Mirrors UpdateProjectDto's partial-with-nullable
 * pattern.
 */
export const UpdateTeamDtoSchema = CreateTeamDtoSchema.partial();
export type UpdateTeamDto = z.infer<typeof UpdateTeamDtoSchema>;

/**
 * PATCH /api/teams/:teamId/members/:userId body - update a member's routing
 * weight for the auto-assign engine. ADMIN/OWNER (or the team's manager)
 * only. Weight is a positive int; 0 disables the member from receiving
 * auto-assigned leads (the engine filters weight <= 0).
 */
export const UpdateTeamMemberWeightDtoSchema = z.object({
  weight: z.number().int().min(0),
});
export type UpdateTeamMemberWeightDto = z.infer<typeof UpdateTeamMemberWeightDtoSchema>;

/** DELETE has no body; the id param is validated in the controller. */

/**
 * POST /api/teams/:id/reassign-members body. Omitting `userIds` reassigns
 * every current member of the source team (the one-click "reassign all"
 * action that unblocks delete); a non-empty array reassigns only those
 * members (the per-member "move to another team" action on the roster).
 */
export const ReassignTeamMembersDtoSchema = z.object({
  targetTeamId: z.cuid2(),
  userIds: z.array(z.cuid2()).min(1).optional(),
});
export type ReassignTeamMembersDto = z.infer<typeof ReassignTeamMembersDtoSchema>;
