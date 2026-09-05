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
  createdAt: z.string().datetime({ offset: true }),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const ProjectListResultSchema = z.object({
  projects: z.array(ProjectRowSchema),
  total: z.number().int().min(0),
});
export type ProjectListResult = z.infer<typeof ProjectListResultSchema>;

/**
 * POST /api/projects body. `slug` is NOT caller-supplied - the service
 * derives it from the name (slugify + uniqueness suffix on collision).
 */
export const CreateProjectDtoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Required: the Project table column is NOT nullable (schema.prisma
  // `address String`). Compliance numbers stay optional.
  address: z.string().trim().min(1).max(500),
  reraNumber: z.string().trim().max(64).optional(),
  cmdaNumber: z.string().trim().max(64).optional(),
});
export type CreateProjectDto = z.infer<typeof CreateProjectDtoSchema>;

/**
 * PATCH /api/projects/:id body - partial. Omitted fields keep their value;
 * explicit `null` clears the optional compliance fields. `address` is
 * non-nullable (column is NOT NULL) - it can be replaced, not removed.
 * `slug` and `createdAt` are immutable (stable identity + chronology).
 */
export const UpdateProjectDtoSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  reraNumber: z.string().trim().max(64).nullable().optional(),
  cmdaNumber: z.string().trim().max(64).nullable().optional(),
});
export type UpdateProjectDto = z.infer<typeof UpdateProjectDtoSchema>;

/** DELETE has no body; the id param is validated in the controller. */