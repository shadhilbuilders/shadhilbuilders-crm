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
  LeadOwnerTypeSchema,
  ActivityTypeSchema,
} from './enums';
import { PhoneSchema } from './common';

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
  name: z.string({
    error: 'Name is required',
  }).trim().min(1).max(120),
  phone: PhoneSchema,
  email: z
    .email()
    .trim()
    .toLowerCase()
    .max(254)
    .optional(),
  source: sourceSchema,
  projectId: z.cuid2().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateLeadDto = z.infer<typeof CreateLeadDtoSchema>;

/**
 * PATCH /api/leads/:id - partial update. Only mutable fields are listed; id
 * state transitions, and ownership go through dedicated endpoints.
 *
 * `phone` is mutable as of autoplan 2026-09-07 (D10): the most common bad
 * data in a phone-first sales org is a mistyped number, and the dialog
 * could not fix it before. Uniqueness is enforced by the DB (Lead.phone
 * @unique); the service maps the violation to a 409 with what/why/fix.
 */
export const UpdateLeadDtoSchema = z.object({
  id: z.string().cuid2(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: PhoneSchema.optional(),
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
  leadId: z.string().cuid2(),
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
  leadId: z.string().cuid2(),
  targetUserId: z.string().cuid2(),
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
  ownerId: z.string().cuid2().optional(),
  teamId: z.cuid2().optional(),
  // Project.id is always a real cuid2 (seed/fixture slug ids were purged),
  // so filter strictly - a non-cuid2 value is a 400, not a silent pass.
  projectId: z.cuid2().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  // Server-side sort (T-SRVPG): the DataTable sorts client-side over the
  // loaded page, which is wrong under server pagination. The page passes
  // the sort column + direction and the service applies it in the SQL
  // ORDER BY. `sortBy` is a whitelisted column name; `sortDir` is asc/desc.
  sortBy: z.enum(['updatedAt', 'createdAt', 'name']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});
export type LeadFilterDto = z.infer<typeof LeadFilterDtoSchema>;

/**
 * POST /api/leads/:id/activities - append a manual activity (call note,
 * email log, etc.). Auto-emitted events (STATUS_CHANGE, VISIT_OUTCOME) use a
 * separate internal writer - clients never POST them directly.
 */
export const CreateActivityDtoSchema = z.object({
  leadId: z.string().cuid2(),
  type: ActivityTypeSchema,
  body: z.string().trim().min(1).max(4000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateActivityDto = z.infer<typeof CreateActivityDtoSchema>;

/**
 * GET /api/leads/:id - full lead detail row (Lead Detail page, Wireframe #5).
 * Superset of the list-page `LeadRow` projection: includes co-owner, team,
 * project, and the raw display phone. The page renders the full record so
 * staff see everything about a lead in one place.
 */
export const LeadDetailSchema = z.object({
  id: z.string().cuid2(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  source: z.string().nullable(),
  status: LeadStateSchema,
  ownerId: z.string().cuid2(),
  ownerName: z.string().nullable(),
  ownerType: LeadOwnerTypeSchema,
  coOwnerId: z.string().cuid2().nullable(),
  coOwnerName: z.string().nullable(),
  teamId: z.string(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LeadDetail = z.infer<typeof LeadDetailSchema>;

/**
 * GET /api/leads/:id/activities - the lead's timeline (oldest → newest).
 * Each entry is a manual or auto-emitted activity with the acting user's
 * name joined in so the UI can render "First call (Asha)" per Wireframe #5.
 */
export const LeadActivitySchema = z.object({
  id: z.string().cuid2(),
  type: ActivityTypeSchema,
  body: z.string(),
  createdAt: z.string(),
  userName: z.string().nullable(),
});
export type LeadActivity = z.infer<typeof LeadActivitySchema>;