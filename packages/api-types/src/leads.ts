// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Leads module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// NestJS LeadsController DTOs. All state-machine transitions go through the
// transition endpoint, which calls the leadsService.transition() guard
// (IMPLEMENTATION-PLAN §3) to enforce Model C ownership rules.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { LeadStateSchema, LeadOwnerTypeSchema, ActivityTypeSchema } from './enums';
import { CountryCodeSchema, PhoneSchema } from './common';

/**
 * Lead source - free-form today (Meta ads, landing site, referral). When the
 * MarketingAttribution module ships (v2) this becomes a foreign key.
 */
const sourceSchema = z.string().trim().min(1).max(80);

/**
 * POST /api/leads - create a new lead. name, phone, source and projectId are
 * required. email is optional. Owner is assigned by the
 * ManagerAssignmentRule service (IMPLEMENTATION-PLAN §7) - callers do NOT
 * pick the owner.
 *
 * The one exception: the PUBLIC leads endpoint may set `assignedOwnerId`
 * (a validated, org-scoped staff user id) to override engine assignment for
 * a landing enquiry. It is NOT accepted from ordinary authed clients (the
 * shared JWT create path ignores it); only the public-leads service, which
 * validates the id against the target org, sets it. Internal only.
 */
export const CreateLeadDtoSchema = z.object({
  name: z
    .string({
      error: 'Name is required',
    })
    .trim()
    .min(1)
    .max(120),
  phone: PhoneSchema,
  // Country the number was typed in. Omitted means the pre-existing Indian
  // paths (convert, imports), which parse under the named legacy rule.
  phoneCountry: CountryCodeSchema.optional(),
  // Email is optional but .optional() only allows undefined/missing, not
  // ''. Several clients (new-lead form, landing mirror) may send ''
  // for a blank optional field, so accept '' as "not provided" too.
  email: z.union([z.literal(''), z.email().trim().toLowerCase().max(254)]).optional(),
  source: sourceSchema,
  /**
   * T-LEAD-PROJECT-REQUIRED (2026-09-16, owner ruling): REQUIRED. `Lead.projectId`
   * is NOT NULL in the database, so this mirrors a real constraint instead of
   * inventing one. 140 project-less leads had accumulated, and because a lead
   * with no project is invisible on every project-scoped surface (the work
   * dashboard, the leads inbox) while still counting org-wide, a correct
   * dashboard `0` read as a broken counter.
   */
  projectId: z.cuid2(),
  notes: z.string().trim().max(2000).optional(),
  // Internal: optional explicit owner override (public-leads only).
  assignedOwnerId: z.string().cuid2().optional(),
  // T-TEAM-AUTHORITATIVE (2026-09-13): optional explicit team pick. A
  // MANAGER who leads multiple teams (or an ADMIN/OWNER) may specify
  // which team the lead belongs to; omitted defaults to the actor's
  // first/oldest managed team (MANAGER) or the org's oldest team
  // (ADMIN/OWNER) - unchanged behavior for single-team actors.
  teamId: z.cuid2().optional(),
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
  phoneCountry: CountryCodeSchema.optional(),
  email: z
    .union([z.literal(''), z.email().trim().toLowerCase().max(254)])
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
 * `reason` is required when transitioning to LOST or RNR (audit).
 */
export const LeadStateTransitionDtoSchema = z.object({
  leadId: z.string().cuid2(),
  toState: LeadStateSchema,
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type LeadStateTransitionDto = z.infer<typeof LeadStateTransitionDtoSchema>;

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
 * PATCH /api/leads/:id/co-owner - set or clear the lead's co-owner.
 * `coOwnerId` is the new co-owner id, or null to clear. The reason is
 * mandatory (audit + manager visibility), mirroring reassign.
 *
 * Permission is the same as reassign: MANAGER may set a same-team co-owner;
 * ADMIN/OWNER may set any (cross-team). The co-owner must be an assignable
 * role (TELECALLER/SALES_EXEC/MANAGER) and cannot be the lead's owner.
 */
export const SetLeadCoOwnerDtoSchema = z.object({
  leadId: z.string().cuid2(),
  coOwnerId: z.string().cuid2().nullable(),
  reason: z.string().trim().min(1).max(500),
});
export type SetLeadCoOwnerDto = z.infer<typeof SetLeadCoOwnerDtoSchema>;

/**
 * POST /api/leads/bulk-delete - clear out leads nobody wants, in one action.
 *
 * A POST, not a DELETE with a body: some proxies drop a DELETE body, and
 * silently deleting nothing is worse than a slightly impure verb. Capped at 100
 * because this is a cleanup action, not a migration, and each row is its own
 * audited transaction on the server.
 */
export const BulkDeleteLeadsDtoSchema = z.object({
  leadIds: z.array(z.string().cuid2()).min(1).max(100),
});
export type BulkDeleteLeadsDto = z.infer<typeof BulkDeleteLeadsDtoSchema>;

/**
 * What actually happened, per id. `refused` is not an error: a WON lead or one
 * with booking history is deliberately undeletable, and the operator needs to
 * know which rows stayed and why rather than a single opaque failure.
 */
export const BulkDeleteLeadsResultSchema = z.object({
  deleted: z.array(z.string()),
  refused: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type BulkDeleteLeadsResult = z.infer<typeof BulkDeleteLeadsResultSchema>;

/**
 * Query filter for GET /api/leads - the Lead Inbox. `state` accepts an array
 * so the UI can filter "show me VISIT_SCHEDULED + VISITED". `ownerId` filters
 * to a single owner; `teamId` filters to a team (manager view).
 */
export const LeadFilterDtoSchema = z.object({
  state: z.union([LeadStateSchema, z.array(LeadStateSchema)]).optional(),
  ownerId: z.string().cuid2().optional(),
  teamId: z.cuid2().optional(),
  // T-USER-LEADS (2026-09-24): match a lead the user is LINKED to, meaning
  // owner OR co-owner. `ownerId` above stays strict owner-only (its existing
  // contract - reassign flows read it). This is the filter the user-detail
  // page uses so a co-owner's workload is visible on their own profile,
  // matching how team-members.service.preview() defines "leads linked with
  // a member".
  linkedUserId: z.string().cuid2().optional(),
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
  // T-NOTES (2026-11-27): the rep's free text about the buyer. Null means no
  // note was ever written, which is different from an empty one.
  notes: z.string().nullable(),
  source: z.string().nullable(),
  status: LeadStateSchema,
  ownerId: z.string().cuid2(),
  ownerName: z.string().nullable(),
  ownerType: LeadOwnerTypeSchema,
  coOwnerId: z.string().cuid2().nullable(),
  coOwnerName: z.string().nullable(),
  teamId: z.string(),
  // T-LEAD-PROJECT-REQUIRED: Lead.projectId is NOT NULL, so a lead detail
  // can never carry a null project. Typing this nullable made every consumer
  // handle a case the database cannot produce.
  projectId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const WhatsAppReachabilitySchema = z.object({
  state: z.enum(['REACHABLE', 'UNREACHABLE', 'UNKNOWN']),
  detail: z.string().nullable(),
});
export type WhatsAppReachability = z.infer<typeof WhatsAppReachabilitySchema>;

/**
 * The answer to "may we send this buyer marketing messages", in three states.
 *
 * Three, not two, because "denied" and "never-asked" are both non-sends but
 * only one of them is a customer who said no. The site-update WhatsApp
 * templates were approved as MARKETING, so this is the answer the send
 * decision reads (see site-update-consent.ts on the backend).
 */
export const LeadConsentAnswerSchema = z.enum(['granted', 'denied', 'never-asked']);
export type LeadConsentAnswer = z.infer<typeof LeadConsentAnswerSchema>;

/**
 * How a marketing opt-in was obtained. The database column is a free string
 * (older rows carry names this list does not know), but a NEW row is written
 * by one of these paths, so the endpoint accepts only these. `call_verbal` is
 * the default in the UI: that is how a builder's sales team actually gets it.
 */
export const LeadConsentSourceSchema = z.enum([
  'call_verbal',
  'in_person',
  'whatsapp_button',
  'booking_form',
]);
export type LeadConsentSource = z.infer<typeof LeadConsentSourceSchema>;

/**
 * POST /api/leads/:id/consent - append one row to the MARKETING consent
 * ledger for this lead.
 *
 * `consentType` is not a field: MARKETING is the only consent whose answer the
 * product acts on today (the site-update templates). Opening the other two
 * (DATA_PROCESSING, COMMUNICATION) is a separate decision with its own
 * surfaces, not something to fold into this endpoint silently.
 */
export const RecordLeadConsentDtoSchema = z.object({
  granted: z.boolean(),
  source: LeadConsentSourceSchema,
  note: z.string().trim().max(500).optional(),
});
export type RecordLeadConsentDto = z.infer<typeof RecordLeadConsentDtoSchema>;

/**
 * What the endpoint answers.
 *
 * `changed` is false when the newest row already says this and no note came with
 * the submit - a rep clicking twice must not append a second row to a ledger
 * whose whole point is that each row is a moment in time. A repeated answer that
 * DOES carry a note is a new statement and gets its own row, because the
 * alternative is swallowing what the buyer just said.
 */
export const RecordLeadConsentResultSchema = z.object({
  changed: z.boolean(),
  answer: LeadConsentAnswerSchema,
  recordedAt: z.string().nullable(),
  /** Whether the buyer's words were stored, so the caller can say so. */
  noteSaved: z.boolean(),
});
export type RecordLeadConsentResult = z.infer<typeof RecordLeadConsentResultSchema>;

export type LeadDetail = z.infer<typeof LeadDetailSchema> & {
  /**
   * The newest MARKETING consent answer for this lead, and when it was given.
   * Optional like `whatsapp` below: `undefined` means the server did not
   * compute it, which is not the same as `never-asked`.
   */
  marketingConsent?: LeadConsentAnswer;
  marketingConsentAt?: string | null;
  /** How the newest answer was obtained ("call_verbal", "in_person", ...). */
  marketingConsentSource?: string | null;
  /** The buyer's own words, if the operator recorded any. */
  marketingConsentNote?: string | null;
  /**
   * Whether this lead can actually receive a WhatsApp message. Derived from
   * evidence (an inbound message, or Meta's 131026), never guessed: the Cloud
   * API has no pre-flight lookup.
   */
  whatsapp?: WhatsAppReachability;
};

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

/** Default and maximum page size for GET /leads/:id/activities. */
export const LEAD_ACTIVITIES_PAGE_SIZE = 50;
export const LEAD_ACTIVITIES_MAX_PAGE_SIZE = 200;

/**
 * Query: `cursor` is the opaque `nextCursor` of the previous page (omit for the
 * newest page); each page walks BACKWARDS in time.
 */
export const LeadActivitiesQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LEAD_ACTIVITIES_MAX_PAGE_SIZE).optional(),
});
export type LeadActivitiesQuery = z.infer<typeof LeadActivitiesQuerySchema>;

/**
 * Timeline page: `items` are oldest -> newest within the page; `nextCursor`
 * fetches the next-OLDER page, or is null when there is nothing earlier.
 */
export const LeadActivitiesResponseSchema = z.object({
  items: z.array(LeadActivitySchema),
  nextCursor: z.string().nullable(),
});
export type LeadActivitiesResponse = z.infer<typeof LeadActivitiesResponseSchema>;
