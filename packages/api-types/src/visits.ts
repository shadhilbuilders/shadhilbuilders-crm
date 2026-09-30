// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Visits module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// NestJS VisitsController DTOs. Site visits are owned by SalesExec once
// scheduled; telecaller schedules them but loses write access at VISITED.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { LeadStateSchema, VisitStatusSchema } from './enums';

/**
 * The LEAD states that may accept a NEW site visit.
 *
 * Single source of truth for one rule that three surfaces have to agree on:
 * the backend's `VisitsService.create` guard, the lead picker in
 * `ScheduleVisitDialog`, and the queue's row-action matrix
 * (`apps/web/src/lib/queue-actions.ts`).
 *
 * WHY IT LIVES HERE (2026-09-30). The three surfaces used to hold three copies
 * and the copies disagreed: the queue offered "Schedule visit" on a NO_SHOW
 * lead while `create()` answered `400 Lead state NO_SHOW cannot accept a visit`.
 * The guard's own comment even claimed RESCHEDULED existed so that "a manager
 * re-opening a no-show can re-schedule" - but a no-show leaves the lead in
 * NO_SHOW, not RESCHEDULED, so the state the comment described was the one being
 * refused. A button the API rejects reads as a broken tool to the operator, so
 * the rule is stated once and imported.
 *
 * NO_SHOW is included on purpose: it is a side state with a live re-engagement
 * edge back to VISIT_SCHEDULED (`leads.state-machine.ts`,
 * `NO_SHOW: ['VISIT_SCHEDULED', 'RNR', 'LOST']`), and booking the next visit is
 * exactly how that edge is taken. It is NOT terminal - see
 * `isTerminalLeadState` in `./lead-status`.
 */
export const SCHEDULABLE_LEAD_STATES = [
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'RESCHEDULED',
  'NO_SHOW',
] as const satisfies readonly z.infer<typeof LeadStateSchema>[];

export type SchedulableLeadState = (typeof SCHEDULABLE_LEAD_STATES)[number];

/**
 * The LEAD states a new visit should ADVANCE the lead out of.
 *
 * Mirrors what `VisitsService.reschedule()` already does for a moved visit
 * (`RESCHEDULED | NO_SHOW | VISIT_REQUESTED -> VISIT_SCHEDULED`): all three mean
 * "a visit is due", and scheduling one means it is now booked.
 *
 * VISIT_SCHEDULED is deliberately absent - a lead already there is either being
 * scheduled a second, parallel visit (a booking path the queue does not offer)
 * or has a live visit of its own; force-writing the same state would only
 * produce a no-op transition row.
 *
 * WHY NOT `RESCHEDULED` AS THE TARGET. In the LEAD machine RESCHEDULED's only
 * outgoing edges are `['VISIT_SCHEDULED', 'RNR', 'LOST']` - there is no
 * RESCHEDULED -> VISITED. Parking a lead there would break the visit handoff
 * permanently. See the long note in `visits.service.ts`.
 */
export const VISIT_SCHEDULING_ADVANCES_FROM = [
  'VISIT_REQUESTED',
  'RESCHEDULED',
  'NO_SHOW',
] as const satisfies readonly z.infer<typeof LeadStateSchema>[];

/**
 * The lead states where the UI should INVITE booking a new visit - the server's
 * {@link SCHEDULABLE_LEAD_STATES} minus `VISIT_SCHEDULED`.
 *
 * The one state that differs, and why it is a UI rule rather than a server rule:
 * a `VISIT_SCHEDULED` lead already has a live appointment. Its surfaces offer
 * the OUTCOME ("No show" on the dashboard row, "Mark completed" / "No-show" on
 * the lead page), and a second, parallel booking is a different action on a
 * different surface (the calendar, or the reschedule endpoint). Offering "book a
 * visit" next to "record what happened" on the same lead is how a lead ends up
 * with two open visits and `LeadVisitPanel` aiming an outcome at the wrong row -
 * the trap the queue design names.
 *
 * The server still ACCEPTS a create from `VISIT_SCHEDULED` (the calendar relies
 * on it), so this list must never be used as a server guard. It exists so the
 * dashboard queue and the lead page offer the same button, instead of each
 * deciding for itself.
 */
export const LEAD_STATES_AWAITING_A_VISIT = [
  'VISIT_REQUESTED',
  'RESCHEDULED',
  'NO_SHOW',
] as const satisfies readonly z.infer<typeof LeadStateSchema>[];

/**
 * POST /api/visits - schedule a new site visit. The lead must be in one of
 * {@link SCHEDULABLE_LEAD_STATES}; the service enforces this.
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