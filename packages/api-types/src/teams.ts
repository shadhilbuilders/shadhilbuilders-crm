// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Team DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// The Team table is the staffing group (manager + members, via User.teamId).
// These shapes back the ADMIN/OWNER org-Teams pages:
//   GET /api/teams       -> TeamListItem[] (list; every authenticated role,
//                           RLS-scoped - used by the create-user dialog).
//   GET /api/teams/:id   -> TeamDetail (ADMIN/OWNER only; roster with each
//                           member's EXPLICIT project assignments + lead-owner
//                           provenance for read-only rows).
// Team membership = User.teamId matches the Team. An UNLINK removes a
// ProjectMember row from ONE project (reuses the projects module's
// DELETE /api/projects/:id/members/:userId); it does not change User.teamId.
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
});
export type TeamListItem = z.infer<typeof TeamListItemSchema>;

/** A single project a team member is assigned to (explicit ProjectMember). */
export const TeamMemberProjectSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  role: z.string(), // RoleSchema
  /**
   * True when this project assignment came ONLY from lead-ownership (the
   * member owns leads in the project but has no explicit ProjectMember row).
   * Such rows are read-only in the UI (Unlink disabled) - there is no
   * explicit ProjectMember to delete, and unlinking would be a silent no-op.
   */
  isLeadOwner: z.boolean(),
});
export type TeamMemberProject = z.infer<typeof TeamMemberProjectSchema>;

/**
 * One team member on the roster.
 * `projects` = every project they appear in: EXPLICIT ProjectMember rows
 * (unlinkable) UNION lead-owner-derived ones (read-only, isLeadOwner=true).
 */
export const TeamMemberRowSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(), // RoleSchema
  projects: z.array(TeamMemberProjectSchema),
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
