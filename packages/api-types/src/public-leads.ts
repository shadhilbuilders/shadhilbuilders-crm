// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Public leads (landing-page enquiry → Lead) DTOs
// ────────────────────────────────────────────────────────────────────────────
// Endpoint served by apps/backend/src/public-leads/:
//
//   POST /api/public/leads                  (public, API-key-gated)
//     - the landing page calls this when a visitor submits the contact /
//       enquiry form. The enquiry becomes a real CRM Lead immediately,
//       auto-assigned by the manager-assignment engine (source=LANDING →
//       matching rule, or the team's default assignee, or the configured
//       fallback owner).
//     - auth: `x-api-key: <PUBLIC_API_KEY>` header (constant-time compare).
//     - body: the landing page's EnquiryInput, mapped to a Lead. The
//       `source` is FORCED to "LANDING" server-side (never trusted from
//       the client) so analytics / manager routing are correct. `notes`
//       is composed from requirement + message.
//     - response: { ok: true, id: string, state: string }
//
// Mirrors the feedback public endpoint's shape (see ./feedback.ts) but for
// Lead creation, which requires an owner + team (resolved via the manager-
// assignment engine against the configured destination).
// ────────────────────────────────────────────────────────────────────────────
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────
// Public submit DTO (POST /api/public/leads)
// ────────────────────────────────────────────────────────────────────────

/**
 * Validate + shape-check the landing enquiry before it becomes a Lead.
 * Fields intentionally map 1:1 to the landing page's EnquiryInput:
 *   fullName  -> name (required)
 *   phone     -> phone (required, normalized like the landing's normalizePhone)
 *   email     -> email (optional)
 *   message   -> folded into notes
 *   requirement -> also folded into notes (requirement + message)
 *   contactMethod / preferredDate / preferredTime / utm* are accepted but
 *   not persisted as columns today (Lead has no field for them); they are
 *   ignored for v1. `source` is NOT accepted from the client - the service
 *   forces it to "LANDING".
 *
 * Org + project targeting (T-ORG, 2026-09-12):
 *   - `orgSlug` / `projectSlug` let the landing page target a specific org
 *     + project. The service resolves slug -> id server-side (the landing
 *     only knows slugs, never cuids). When omitted, the service falls back
 *     to PUBLIC_ORG_ID / LEADS_FALLBACK_PROJECT_ID env vars.
 *   - `ownerId` is OPTIONAL. When present AND valid (a real staff user in
 *     the resolved org/team), the service uses it as the lead owner
 *     (bypassing the manager-assignment engine). When absent or invalid,
 *     the engine assigns as it does today (rule -> team default ->
 *     LEADS_FALLBACK_OWNER_ID).
 */
export const PublicCreateLeadDtoSchema = z.object({
  fullName: z
    .string({ error: 'fullName is required' })
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name is too long'),
  phone: z
    .string({ error: 'phone is required' })
    .min(7, 'Please enter a valid phone number')
    .max(20, 'Please enter a valid phone number'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .or(z.literal('')),
  requirement: z.string().trim().max(2000).optional().or(z.literal('')),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
  contactMethod: z.string().trim().max(20).optional().or(z.literal('')),
  preferredDate: z.string().trim().max(20).optional().or(z.literal('')),
  preferredTime: z.string().trim().max(20).optional().or(z.literal('')),
  source: z.string().trim().max(80).optional().or(z.literal('')),
  // Org targeting: the landing passes a SLUG; the service resolves it.
  orgSlug: z.string().trim().min(1).max(120).optional().or(z.literal('')),
  projectSlug: z.string().trim().min(1).max(120).optional().or(z.literal('')),
  // Optional direct-owner override (validated against the org/team).
  ownerId: z.string().trim().min(1).max(120).optional().or(z.literal('')),
});
export type PublicCreateLeadDto = z.infer<typeof PublicCreateLeadDtoSchema>;

/** Shape of POST /api/public/leads success. `id` + `state` let the landing
 *  page log / reference the new Lead. */
export interface PublicCreateLeadResult {
  ok: true;
  id: string;
  state: string;
}
