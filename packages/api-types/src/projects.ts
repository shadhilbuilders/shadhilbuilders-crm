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
//   PATCH  /api/projects/:id - ADMIN/OWNER only. The slug IS editable.
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
  name: z
    .string({
      error: 'Name is required',
    })
    .trim()
    .min(1)
    .max(120),
  // Required: the Project table column is NOT nullable (schema.prisma
  // `address String`). Compliance numbers stay optional.
  address: z
    .string({
      error: 'Address is required',
    })
    .trim()
    .min(1)
    .max(500),
  reraNumber: z.string().trim().max(64).optional(),
  cmdaNumber: z.string().trim().max(64).optional(),
});
export type CreateProjectDto = z.infer<typeof CreateProjectDtoSchema>;

/**
 * PATCH /api/projects/:id body - partial. Omitted fields keep their value;
 * explicit `null` clears the optional compliance fields. `address` is
 * non-nullable (column is NOT NULL) - it can be replaced, not removed.
 * `createdAt` is immutable (chronology).
 *
 * `slug` IS editable (2026-11-19). It is the URL segment for every project
 * page, so a change moves those URLs; the service rejects a slug already used
 * anywhere in the org (409) rather than silently suffixing it, because the
 * admin typed a specific value. Omitted keeps the current slug.
 *
 * Derived from `CreateProjectDtoSchema` (perf-reuse-schemas) so `name`/
 * `address` keep the SAME constraints (single source of truth), then
 * `.partial()` makes each key optional. `reraNumber`/`cmdaNumber` are
 * redefined with `.nullable()` so the edit form can send `null` to CLEAR
 * them (a documented contract the service honors via `dto.x ?? null`) -
 * `.partial()` alone would reject `null`.
 */
/**
 * Project slug - the URL segment, e.g. /shadhil-metro-heights/leads.
 *
 * 2026-11-19: projects can now be renamed at the URL level. Creating a project
 * still derives the slug from its name, but an ADMIN may rewrite it from the
 * edit dialog, so it needs its own rule instead of relying on the slugifier.
 *
 * Lowercase letters, digits and single hyphens: no leading/trailing hyphen, no
 * doubled hyphen. That is exactly what slugifyProjectName can produce, so an
 * edited slug stays indistinguishable from a derived one - and a hand-typed
 * value cannot introduce a segment that breaks the [projectSlug] route.
 */
export const ProjectSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Slug must be at least 2 characters')
  .max(80, 'Slug is too long')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');
export type ProjectSlug = z.infer<typeof ProjectSlugSchema>;

export const UpdateProjectDtoSchema = CreateProjectDtoSchema.pick({
  name: true,
  address: true,
})
  .extend({
    reraNumber: z.string().trim().max(64).nullable().optional(),
    cmdaNumber: z.string().trim().max(64).nullable().optional(),
    slug: ProjectSlugSchema.optional(),
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
