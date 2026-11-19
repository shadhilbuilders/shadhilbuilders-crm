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
/**
 * Cheap plausibility gate for the PUBLIC landing form's phone field.
 *
 * Length alone (`min(7).max(20)`, the previous rule) admitted `abcdefg123`.
 * This rejects the obviously-wrong shape at the boundary so the visitor gets
 * the message on the field they typed, instead of a late 400 (or, before
 * 2026-11-19, a 500) from the internal create DTO a layer down.
 *
 * Deliberately NOT the full rule - `PhoneSchema` remains authoritative. Two
 * conditions, both derived from what `normalizePhoneDigits` accepts:
 *   - alphabet: digits plus the separators it strips (space, hyphen, dot,
 *     parens, leading +);
 *   - 10-15 DIGITS, matching its international floor of `\d{10,15}`. Counting
 *     digits rather than characters matters: a 20-char rule admitted
 *     `12345678901234567890` while the server caps at 15. The floor used to be
 *     7, which let a 7-digit typo through this gate and only failed a layer
 *     down.
 */
function isPlausiblePublicPhone(value: string): boolean {
  if (!/^\+?[\d\s\-().]*$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

export const PublicCreateLeadDtoSchema = z.object({
  fullName: z
    .string({ error: 'fullName is required' })
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name is too long'),
  phone: z
    .string({ error: 'phone is required' })
    // HARDENED 2026-11-19. This was `.min(7).max(20)` - a LENGTH check only,
    // so `abcdefg123` passed and only failed later, when the service
    // re-parsed onto CreateLeadDtoSchema (which uses PhoneSchema). That late
    // failure used to surface as a 500; even now that it is a 400, rejecting
    // garbage HERE keeps the message at the field the user typed, and means
    // this public schema does not advertise a contract the real one rejects.
    //
    // ONE check, not two. An alphabet regex plus a digit-count refine (the
    // first attempt) emitted the SAME message twice for `abcdefg123`, because
    // both issues fired. This single predicate keeps one message per field.
    // The authoritative SHAPE rule still lives in PhoneSchema one layer down.
    .trim()
    .refine(isPlausiblePublicPhone, { message: 'Please enter a valid phone number' }),
  email: z.string().trim().toLowerCase().max(254).optional().or(z.literal('')),
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
