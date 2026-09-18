// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Project DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// T-ProjectSwitch (2026-09-05): the Project table becomes the real project
// registry for the sidebar switcher (Phase 2 - real switching). The Team
// table returns to being purely a staffing group (manager + members).
//
// Roles (locked Round-17 hierarchy, service-enforced):
//   GET    /api/projects    - every authenticated role (registry is shared
//                             operational data; the switcher needs it).
//   POST   /api/projects    - ADMIN/OWNER only (service guard; RLS is the
//                             second wall).
//   PATCH  /api/projects/:id - ADMIN/OWNER only. Slug is immutable.
//   DELETE /api/projects/:id - OWNER only (service guard). 409 when the
//                             project still has active inventory.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * Row shape for GET /api/projects (and the switcher dropdown).
 * `createdAt` ordering is the business chronology: the FIRST project ever
 * created is the default active project (seed creates Shadhil Metro Heights
 * first for exactly this reason).
 */
export const ProjectRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  reraNumber: z.string().nullable().optional(),
  cmdaNumber: z.string().nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const ProjectListResultSchema = z.object({
  projects: z.array(ProjectRowSchema),
  total: z.number().int().min(0),
});
export type ProjectListResult = z.infer<typeof ProjectListResultSchema>;

/**
 * GET /api/projects/:id - full detail for the admin/owner A-Z project page.
 * Identity + per-project counts. ADMIN/OWNER only (service guard). Counts are
 * RLS-scoped to the actor (for admin/owner = org-wide).
 */
export const ProjectDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  reraNumber: z.string().nullable().optional(),
  cmdaNumber: z.string().nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }),
  counts: z.object({
    phases: z.number().int().min(0),
    units: z.number().int().min(0),
    options: z.number().int().min(0),
    teams: z.number().int().min(0),
    teamMembers: z.number().int().min(0),
    leads: z.number().int().min(0),
    bookings: z.number().int().min(0),
  }),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

/**
 * GET /api/projects query filter - server-side search + pagination.
 * Mirrors UserFilterDto. When `limit`/`offset`/`search` are omitted the
 * controller returns the full registry (backward-compatible for the
 * sidebar switcher, which calls with no query params).
 */
export const ProjectFilterDtoSchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
export type ProjectFilterDto = z.infer<typeof ProjectFilterDtoSchema>;

/**
 * POST /api/projects body. `slug` is NOT caller-supplied - the service
 * derives it from the name (slugify + uniqueness suffix on collision).
 */
export const CreateProjectDtoSchema = z.object({
  name: z.string({
    error: 'Name is required',
  }).trim().min(1).max(120),
  // Required: the Project table column is NOT nullable (schema.prisma
  // `address String`). Compliance numbers stay optional.
  address: z.string({
    error: 'Address is required',
  }).trim().min(1).max(500),
  reraNumber: z.string().trim().max(64).optional(),
  cmdaNumber: z.string().trim().max(64).optional(),
});
export type CreateProjectDto = z.infer<typeof CreateProjectDtoSchema>;

/**
 * PATCH /api/projects/:id body - partial. Omitted fields keep their value;
 * explicit `null` clears the optional compliance fields. `address` is
 * non-nullable (column is NOT NULL) - it can be replaced, not removed.
 * `slug` and `createdAt` are immutable (stable identity + chronology).
 *
 * Derived from `CreateProjectDtoSchema` (perf-reuse-schemas) so `name`/
 * `address` keep the SAME constraints (single source of truth), then
 * `.partial()` makes each key optional. `reraNumber`/`cmdaNumber` are
 * redefined with `.nullable()` so the edit form can send `null` to CLEAR
 * them (a documented contract the service honors via `dto.x ?? null`) -
 * `.partial()` alone would reject `null`.
 */
export const UpdateProjectDtoSchema = CreateProjectDtoSchema.pick({
  name: true,
  address: true,
})
  .extend({
    reraNumber: z.string().trim().max(64).nullable().optional(),
    cmdaNumber: z.string().trim().max(64).nullable().optional(),
  })
  .partial();
export type UpdateProjectDto = z.infer<typeof UpdateProjectDtoSchema>;

/** DELETE has no body; the id param is validated in the controller. */

// ────────────────────────────────────────────────────────────────────────────
// ProjectMember (per-user project linking) was RETIRED T-TEAM-AUTHORITATIVE
// (2026-09-13, clean cutover): projects link to TEAMS only, via ProjectTeam
// (see team-membership.ts). The design doc explicitly lists "per-user
// project exceptions or exclusions" as Not in Scope - this schema/endpoint
// pair (ProjectMemberRowSchema, LinkProjectMemberDtoSchema, GET/POST/DELETE
// /api/projects/:id/members) was the residual pre-cutover feature that
// contradicted that. No replacement DTO is needed: staffing a project is
// exclusively "link/unlink a TEAM" now (ProjectTeamRowSchema/
// LinkProjectTeamDtoSchema).
// ────────────────────────────────────────────────────────────────────────────