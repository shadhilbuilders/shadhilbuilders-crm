// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Team membership / project-team DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail #39 in
// IMPLEMENTATION-PLAN-v1.md). Backs the team-authoritative staffing model:
// `TeamMember(userId, teamId)` replaces single-valued `User.teamId`;
// `ProjectTeam(projectId, teamId)` replaces `ProjectMember(projectId, userId)`.
//
// Contracts defined here (endpoints land with the RLS/service cutover -
// this file ships the wire shapes first so frontend and backend can build
// against the same contract without drifting):
//   GET  /api/teams/:teamId/members/:userId/removal-preview
//   POST /api/teams/:teamId/members/:userId/reassign-and-remove
//   GET  /api/projects/:projectId/teams
//   POST /api/projects/:projectId/teams
//   DELETE /api/projects/:projectId/teams/:teamId
//
// Stable error codes (design doc "API contracts" section) are exported as a
// const array so the web ApiError-to-UI-behavior mapping (UI4) stays
// exhaustive against this same list.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { RoleSchema } from './enums';

/** A single TeamMember row, as returned by roster/preview endpoints. */
export const TeamMembershipSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
  name: z.string(),
  email: z.string(),
  role: RoleSchema,
  assignedAt: z.string(), // ISO datetime
  /**
   * True for the team's manager (Team.managerId) when they have NO
   * separate TeamMember row for this same team - i.e. they participate
   * through management alone. False for every ordinary membership row and
   * for a manager who ALSO holds an explicit TeamMember row in a
   * different team.
   */
  isManagerSlot: z.boolean(),
});
export type TeamMembership = z.infer<typeof TeamMembershipSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Removal preview / execute
// ────────────────────────────────────────────────────────────────────────────

/** One project's contribution to the removal-preview lead breakdown. */
export const RemovalPreviewProjectSummarySchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  ownedCount: z.number().int().nonnegative(),
  coOwnedCount: z.number().int().nonnegative(),
});
export type RemovalPreviewProjectSummary = z.infer<
  typeof RemovalPreviewProjectSummarySchema
>;

/** A same-team candidate eligible to receive the departing member's leads. */
export const ReplacementCandidateSchema = z.object({
  userId: z.string(),
  name: z.string(),
  role: RoleSchema,
  /**
   * True when this candidate IS the team's manager, participating via
   * Team.managerId rather than an explicit TeamMember row (design doc:
   * "the own-team manager is an eligible replacement ... including for
   * terminal-state leads").
   */
  isTeamManager: z.boolean(),
});
export type ReplacementCandidate = z.infer<typeof ReplacementCandidateSchema>;

/**
 * GET /api/teams/:teamId/members/:userId/removal-preview response.
 * `previewToken` is opaque (server-derived from sorted
 * (leadId, updatedAt, ownerId, coOwnerId) tuples) and must be echoed back
 * unchanged on the execute call; a mismatch at execute time means the
 * underlying leads changed and the caller must re-preview (STALE_PREVIEW).
 */
export const RemovalPreviewResponseSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  ownedCount: z.number().int().nonnegative(),
  coOwnedCount: z.number().int().nonnegative(),
  totalAffectedLeads: z.number().int().nonnegative(),
  projects: z.array(RemovalPreviewProjectSummarySchema),
  /** Distinct LeadState values among the OWNED leads (drives the
   * ownership-eligibility filter on candidates). */
  ownedStates: z.array(z.string()),
  eligibleReplacements: z.array(ReplacementCandidateSchema),
  previewToken: z.string(),
});
export type RemovalPreviewResponse = z.infer<
  typeof RemovalPreviewResponseSchema
>;

/**
 * POST /api/teams/:teamId/members/:userId/reassign-and-remove body.
 * `replacementUserId` is REQUIRED when the preview reported any affected
 * lead, and MUST be null/omitted when the preview reported zero (the
 * "Remove from team" branch) - the server rejects a mismatch rather than
 * silently ignoring it, per the design doc's contract-drift guard.
 */
export const ReassignAndRemoveDtoSchema = z.object({
  replacementUserId: z.string().nullable().optional(),
  reason: z
    .string({ error: 'A reason is required' })
    .trim()
    .min(1, 'A reason is required')
    .max(500, 'Reason must be at most 500 characters'),
  previewToken: z.string(),
  requestId: z.uuid(),
});
export type ReassignAndRemoveDto = z.infer<typeof ReassignAndRemoveDtoSchema>;

/** POST /api/teams/:teamId/members/:userId/reassign-and-remove response. */
export const ReassignAndRemoveResponseSchema = z.object({
  batchId: z.string(),
  removedUserId: z.string(),
  teamId: z.string(),
  replacementUserId: z.string().nullable(),
  transferredLeadCount: z.number().int().nonnegative(),
});
export type ReassignAndRemoveResponse = z.infer<
  typeof ReassignAndRemoveResponseSchema
>;

/**
 * Stable error codes for the removal flow (design doc "API contracts").
 * The Nest envelope's `code` field is one of these; the web `ApiError`
 * mapping (UI4) must stay exhaustive against this list.
 */
export const TEAM_REMOVAL_ERROR_CODES = [
  'STALE_PREVIEW',
  'NO_ELIGIBLE_REPLACEMENT',
  'LAST_TEAM_PARTICIPANT',
  'TARGET_NOT_TEAM_MEMBER',
  'TARGET_ROLE_INELIGIBLE',
  'SELF_REPLACEMENT',
  'CONCURRENT_MEMBERSHIP_CHANGE',
  'TOO_MANY_AFFECTED_LEADS',
  'PROJECT_TEAM_NOT_LINKED',
  'PROJECT_TEAM_HAS_LEADS',
] as const;
export const TeamRemovalErrorCodeSchema = z.enum(TEAM_REMOVAL_ERROR_CODES);
export type TeamRemovalErrorCode = z.infer<typeof TeamRemovalErrorCodeSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Project <-> Team linking (replaces per-user ProjectMember on the Staff page)
// ────────────────────────────────────────────────────────────────────────────

/** One linked team row on GET /api/projects/:projectId/teams. */
export const ProjectTeamRowSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  manager: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  memberCount: z.number().int().nonnegative(),
  leadCount: z.number().int().nonnegative(),
  members: z.array(TeamMembershipSchema),
  /** Server-computed capability flags - the UI never re-derives these. */
  canUnlink: z.boolean(),
});
export type ProjectTeamRow = z.infer<typeof ProjectTeamRowSchema>;

/** GET /api/projects/:projectId/teams response. */
export const ProjectTeamsResponseSchema = z.object({
  projectId: z.string(),
  teams: z.array(ProjectTeamRowSchema),
});
export type ProjectTeamsResponse = z.infer<typeof ProjectTeamsResponseSchema>;

/** POST /api/projects/:projectId/teams body - link one team. */
export const LinkProjectTeamDtoSchema = z.object({
  teamId: z.cuid2(),
});
export type LinkProjectTeamDto = z.infer<typeof LinkProjectTeamDtoSchema>;

/** DELETE /api/projects/:projectId/teams/:teamId has no body. */
