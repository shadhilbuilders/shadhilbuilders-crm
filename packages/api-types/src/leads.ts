// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Leads module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// NestJS LeadsController DTOs. All state-machine transitions go through the
// transition endpoint, which calls the leadsService.transition() guard
// (IMPLEMENTATION-PLAN §3) to enforce Model C ownership rules.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import {
  LeadStateSchema,
  ActivityTypeSchema,
} from './enums';

/**
 * Indian phone numbers are 10 digits with optional +91 prefix. We strip
 * everything except digits, then validate length.
 */
const phoneSchema = z
  .string()
  .transform((val: string) => val.replace(/\D/g, ''))
  .pipe(
    z
      .string()
      .regex(/^\d{10,15}$/, 'Phone must be 10–15 digits (country code allowed)'),
  );

/**
 * Lead source - free-form today (Meta ads, landing site, referral). When the
 * MarketingAttribution module ships (v2) this becomes a foreign key.
 */
const sourceSchema = z.string().trim().min(1).max(80);

/**
 * POST /api/leads - create a new lead. name, phone, source are required.
 * email and projectId are optional. Owner is assigned by the
 * ManagerAssignmentRule service (IMPLEMENTATION-PLAN §7) - callers do NOT
 * pick the owner.
 */
export const CreateLeadDtoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(254)
    .optional(),
  source: sourceSchema,
  projectId: z.string().cuid().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateLeadDto = z.infer<typeof CreateLeadDtoSchema>;

/**
 * PATCH /api/leads/:id - partial update. Only mutable fields are listed; id
 * state transitions, and ownership go through dedicated endpoints.
 */
export const UpdateLeadDtoSchema = z.object({
  id: z.string().cuid(),
  name: z.string().trim().min(1).max(120).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(254)
    .nullable()
    .optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateLeadDto = z.infer<typeof UpdateLeadDtoSchema>;

/**
 * POST /api/leads/:id/transition - drive the lead state machine.
 * `toState` is validated against LeadStateSchema; the service then checks
 * the Model C ownership + role table to allow/reject.
 *
 * `reason` is required when transitioning to LOST or COLD (audit).
 */
export const LeadStateTransitionDtoSchema = z.object({
  leadId: z.string().cuid(),
  toState: LeadStateSchema,
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type LeadStateTransitionDto = z.infer<
  typeof LeadStateTransitionDtoSchema
>;

/**
 * POST /api/leads/:id/reassign - move ownership to another user. Reason is
 * mandatory (audit + manager visibility). The service verifies the target
 * user exists, shares a team with the actor (or actor is ADMIN), and that
 * the new owner's role permits owning leads at the current state.
 */
export const ReassignLeadDtoSchema = z.object({
  leadId: z.string().cuid(),
  targetUserId: z.string().cuid(),
  reason: z.string().trim().min(1).max(500),
});
export type ReassignLeadDto = z.infer<typeof ReassignLeadDtoSchema>;

/**
 * Query filter for GET /api/leads - the Lead Inbox. `state` accepts an array
 * so the UI can filter "show me VISIT_SCHEDULED + VISITED". `ownerId` filters
 * to a single owner; `teamId` filters to a team (manager view).
 */
export const LeadFilterDtoSchema = z.object({
  state: z
    .union([LeadStateSchema, z.array(LeadStateSchema)])
    .optional(),
  ownerId: z.string().cuid().optional(),
  teamId: z.string().trim().min(1).max(64).optional(),
  // Seed project ids are readable (`seed-project-metro-heights`), not
  // cuids - same convention as auth.ts teamId (min(1).max(64)).
  projectId: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type LeadFilterDto = z.infer<typeof LeadFilterDtoSchema>;

/**
 * POST /api/leads/:id/activities - append a manual activity (call note,
 * email log, etc.). Auto-emitted events (STATUS_CHANGE, VISIT_OUTCOME) use a
 * separate internal writer - clients never POST them directly.
 */
export const CreateActivityDtoSchema = z.object({
  leadId: z.string().cuid(),
  type: ActivityTypeSchema,
  body: z.string().trim().min(1).max(4000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateActivityDto = z.infer<typeof CreateActivityDtoSchema>;