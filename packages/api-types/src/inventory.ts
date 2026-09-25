// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Inventory module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Villa/unit availability grid (DESIGN.md module 4, plan Week 7):
//   Villa #, BHK, Facing, Sqft, Price, Status with Project/Phase/BHK/Facing/
//   Status filters. Click unit → detail panel with hold + booking flow.
//
// Roles (DESIGN.md §4 permission matrix):
//   GET    /api/inventory/units    - every authenticated role (view grid)
//   GET    /api/inventory/units/:id - every authenticated role (detail)
//   POST   /api/inventory/units    - ADMIN/OWNER only (service guard)
//   PATCH  /api/inventory/units/:id - ADMIN/OWNER only (service guard)
//   GET    /api/inventory/phases   - every authenticated role (filter + detail)
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ProjectOptionTypeSchema, UnitStatusSchema } from './enums';

/**
 * Row shape for GET /api/inventory/units. `price` is a string (Prisma
 * Decimal serialises to string over JSON). `phaseName`/`projectName`
 * are denormalized for the grid so the UI doesn't need a second lookup.
 */
export const UnitRowSchema = z.object({
  id: z.string(),
  phaseId: z.string(),
  phaseName: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  unitNumber: z.string(),
  bhk: z.number().int().min(1),
  facing: z.string().nullable(),
  sqft: z.number().int().positive().nullable(),
  price: z.string(),
  status: UnitStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type UnitRow = z.infer<typeof UnitRowSchema>;

export const UnitListResultSchema = z.object({
  total: z.number().int().min(0),
  rows: z.array(UnitRowSchema),
});
export type UnitListResult = z.infer<typeof UnitListResultSchema>;

/**
 * GET /api/inventory/units query filter. `status` may repeat
 * (e.g. `?status=AVAILABLE&status=HOLD`) - coerce to an array.
 * `bhk`/`facing` are single-value filters. `projectId` is a real
 * cuid2 (T-PROJID-CUID2, 2026-09-08).
 */
export const UnitFilterDtoSchema = z.object({
  // Project.id and Phase.id are real cuid2 at runtime + in the seed
  // (T-PROJID-CUID2). Validate strictly.
  projectId: z.cuid2().optional(),
  phaseId: z.cuid2().optional(),
  bhk: z.number().int().min(1).max(10).optional(),
  facing: z.string().trim().min(1).max(40).optional(),
  status: z
    .union([UnitStatusSchema, z.array(UnitStatusSchema)])
    .optional(),
  /**
   * T-INV-SEARCH (2026-09-25): free-text search over the villa NUMBER.
   * Matches the grid's "Search by villa" input. Server-side (the grid is
   * paginated), and >= 2 chars is enforced by the UI, per the repo contract
   * in leads/users (`useDebouncedValue` + a minimum length so a single
   * keystroke does not fire a request).
   */
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type UnitFilterDto = z.infer<typeof UnitFilterDtoSchema>;

/**
 * T-INV-SYNC (2026-09-15): manual unit-status overrides are limited to the
 * off-pipeline marks. Unit.status is DERIVED from the booking lifecycle - a
 * booking trigger recomputes it - so HOLD/TOKEN are produced by a booking, never
 * hand-set, and SOLD/AVAILABLE are the only states an admin legitimately sets by
 * hand. Anything that contradicts a live booking is rejected with a 409 by the
 * service. Declared before CreateUnitDtoSchema, which also uses it.
 */
export const UpdateUnitStatusSchema = z.enum(['AVAILABLE', 'SOLD']);
export type UpdateUnitStatus = z.infer<typeof UpdateUnitStatusSchema>;

/**
 * POST /api/inventory/units body. `price` is a number (converted to a
 * Decimal string server-side). `facing`/`sqft` optional.
 *
 * T-INV-SYNC: `status` accepts the MANUAL marks only (AVAILABLE|SOLD).
 * `Unit.status` is derived from the booking lifecycle - a trigger on `Booking`
 * recomputes it - so a new unit cannot be seeded straight into HOLD/TOKEN. That
 * combination is unreachable otherwise: the trigger only fires on Booking
 * writes, so a unit created as HOLD with no booking behind it would stay HOLD
 * forever and could never accept a booking (the bookable-unit guard rejects any
 * unit that is not AVAILABLE). Mirrors UpdateUnitStatusSchema; the web create
 * page never sends this field.
 */
export const CreateUnitDtoSchema = z.object({
  // Phase.id is a real cuid2 (T-PROJID-CUID2, 2026-09-08) - the same shape
  // the seed generates at runtime. The inventory filter's projectId is
  // already z.cuid2(); phaseId follows the same convention.
  phaseId: z.cuid2(),
  unitNumber: z.string().trim().min(1).max(40),
  bhk: z.number().int().min(1).max(10),
  facing: z.string().trim().min(1).max(40).optional(),
  sqft: z.number().int().positive().max(100_000).optional(),
  price: z.number().positive().max(100_000_000_00, 'Price too large (cap ₹100 Cr)'),
  status: UpdateUnitStatusSchema.optional(),
});
export type CreateUnitDto = z.infer<typeof CreateUnitDtoSchema>;

/**
 * PATCH /api/inventory/units/:id body - partial. Omitted fields keep
 * their value. `status` accepts the off-pipeline marks only (see
 * UpdateUnitStatusSchema) and is validated against the unit's live bookings
 * server-side.
 */
export const UpdateUnitDtoSchema = z.object({
  unitNumber: z.string().trim().min(1).max(40).optional(),
  bhk: z.number().int().min(1).max(10).optional(),
  facing: z.string().trim().min(1).max(40).nullable().optional(),
  sqft: z.number().int().positive().max(100_000).nullable().optional(),
  price: z.number().positive().max(100_000_000_00).optional(),
  status: UpdateUnitStatusSchema.optional(),
});
export type UpdateUnitDto = z.infer<typeof UpdateUnitDtoSchema>;

/**
 * Row shape for GET /api/inventory/phases. `unitCount` lets the filter
 * show how many units each phase holds.
 */
export const PhaseRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  unitCount: z.number().int().min(0),
});
export type PhaseRow = z.infer<typeof PhaseRowSchema>;

/**
 * POST /api/inventory/phases body. A phase belongs to a project and has
 * a display name. MANAGER/ADMIN/OWNER only (service guard).
 */
export const CreatePhaseDtoSchema = z.object({
  // Project.id is a plain string (cuid() default, but seed data uses
  // slug-like ids) - accept any non-empty string, NOT z.cuid2().
  projectId: z.string().min(1),
  name: z.string().trim().min(1, 'Phase name is required').max(80),
});
export type CreatePhaseDto = z.infer<typeof CreatePhaseDtoSchema>;

/**
 * PATCH /api/inventory/phases/:id body - partial. Only `name` is
 * editable (a phase's project is its identity anchor).
 */
export const UpdatePhaseDtoSchema = z.object({
  name: z.string().trim().min(1, 'Phase name is required').max(80).optional(),
});
export type UpdatePhaseDto = z.infer<typeof UpdatePhaseDtoSchema>;

/**
 * Row shape for GET /api/inventory/options. `value` is the free-form
 * stored string ('North', '1', ...).
 */
export const ProjectOptionRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: ProjectOptionTypeSchema,
  value: z.string(),
  /** Units in this project currently using this option value. */
  unitCount: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ProjectOptionRow = z.infer<typeof ProjectOptionRowSchema>;

/**
 * GET /api/inventory/options query filter. `projectId` filters to a
 * project; `type` optionally narrows to FACING or BHK.
 */
export const ProjectOptionFilterDtoSchema = z.object({
  projectId: z.string().min(1),
  type: ProjectOptionTypeSchema.optional(),
});
export type ProjectOptionFilterDto = z.infer<typeof ProjectOptionFilterDtoSchema>;

/**
 * POST /api/inventory/options body. Adds a value to a project's option
 * set. MANAGER/ADMIN/OWNER only (service guard).
 */
export const CreateProjectOptionDtoSchema = z.object({
  projectId: z.string().min(1),
  type: ProjectOptionTypeSchema,
  value: z.string().trim().min(1, 'Value is required').max(40),
});
export type CreateProjectOptionDto = z.infer<typeof CreateProjectOptionDtoSchema>;
