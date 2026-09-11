// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Visits module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// NestJS VisitsController DTOs. Site visits are owned by SalesExec once
// scheduled; telecaller schedules them but loses write access at VISITED.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { VisitStatusSchema } from './enums';

/**
 * POST /api/visits - schedule a new site visit. The lead must be in
 * VISIT_REQUESTED or VISIT_SCHEDULED state; the service enforces this.
 */
export const CreateSiteVisitDtoSchema = z.object({
  leadId: z.string().cuid2(),
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .refine((iso: string) => new Date(iso).getTime() > Date.now(), {
      message: 'scheduledFor must be in the future',
    }),
  salesExecId: z.string().cuid2().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateSiteVisitDto = z.infer<typeof CreateSiteVisitDtoSchema>;

/**
 * PATCH /api/visits/:id - update visit outcome after the visit happens.
 * `outcome` is required. The state-machine service flips the parent lead
 * state accordingly (VISITED → NEGOTIATION, NO_SHOW → reverts to TELECALLER,
 * RESCHEDULED → spawns a new SiteVisit row).
 */
export const UpdateVisitOutcomeDtoSchema = z.object({
  visitId: z.string().cuid2(),
  outcome: VisitStatusSchema,
  notes: z.string().trim().max(2000).optional(),
});
export type UpdateVisitOutcomeDto = z.infer<typeof UpdateVisitOutcomeDtoSchema>;

/**
 * PATCH /api/visits/:id/reschedule - same shape as create, but pinned to
 * an existing visit. The old visit row is marked RESCHEDULED and the new
 * one carries `rescheduledFromId`.
 */
export const RescheduleVisitDtoSchema = z.object({
  visitId: z.string().cuid2(),
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .refine((iso: string) => new Date(iso).getTime() > Date.now(), {
      message: 'scheduledFor must be in the future',
    }),
  salesExecId: z.string().cuid2().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type RescheduleVisitDto = z.infer<typeof RescheduleVisitDtoSchema>;

/**
 * GET /api/visits query filter - for the Visit Calendar view.
 */
export const VisitFilterDtoSchema = z.object({
  leadId: z.string().cuid2().optional(),
  salesExecId: z.string().cuid2().optional(),
  // Project.id is a plain string (cuid() default, but seed data uses
  // slug-like ids). Accept any non-empty string - NOT z.cuid2().
  projectId: z.string().min(1).optional(),
  status: z.union([VisitStatusSchema, z.array(VisitStatusSchema)]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type VisitFilterDto = z.infer<typeof VisitFilterDtoSchema>;