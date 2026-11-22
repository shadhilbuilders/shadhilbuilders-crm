// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Common DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Shared pagination, error envelopes, ID param schemas. Used by every
// NestJS controller and Next.js route handler.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import { isCountryCode, parsePhone } from './phone';

/** Standard pagination for list endpoints. */
export const PaginationDtoSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type PaginationDto = z.infer<typeof PaginationDtoSchema>;

/** Cuid path param. */
export const IdParamDtoSchema = z.object({ id: z.string().cuid2() });
export type IdParamDto = z.infer<typeof IdParamDtoSchema>;

/**
 * Reusable Indian phone-number schema (T-PHONE-SCHEMA, 2026-09-08).
 * Shared across every module that accepts a phone (Lead create/update,
 * WhatsApp convert, and the client-side lead form) so validation and
 * normalization live in ONE place instead of duplicated per DTO/form.
 *
 * Behavior mirrors the Shadhil landing page's `normalizePhone`
 * (landing-page/lib/enquiry-schema.ts) - the canonical phone validator
 * for the business. It normalizes to E.164 digits (no "+", no spaces):
 *
 *   +91XXXXXXXXXX  → 91XXXXXXXXXX
 *   91XXXXXXXXXX   → 91XXXXXXXXXX
 *   0XXXXXXXXXX    → 91XXXXXXXXXX  (strip leading 0, prepend 91)
 *   XXXXXXXXXX     → 91XXXXXXXXXX  (10 digits starting 6-9 = Indian mobile)
 *   +1XXXXXXXXXX   → 1XXXXXXXXXX   (international, strip +)
 *   10–15 digits otherwise         → as-is (international)
 *
 * Anything outside these shapes fails validation. The output is the
 * normalized digits-only E.164 form (no leading "+").
 */
/**
 * Shape rule for a phone number as it arrives over the wire.
 *
 * This validates SHAPE and nothing else: characters, and 10 to 15 digits. It
 * deliberately does NOT rewrite the value. The old version appended `91` to
 * anything that looked like an Indian mobile, which is how +1 650 234 5678
 * became an Indian number before any service saw it. Canonicalisation now
 * happens once, in `parsePhone`, where the country is known.
 */
export const PhoneSchema = z.string().superRefine((raw, ctx) => {
  try {
    assertPhoneShape(raw);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Please enter a valid phone number',
    });
  }
});
export type PhoneNumber = z.infer<typeof PhoneSchema>;

/**
 * An ISO 3166-1 alpha-2 country, validated at runtime.
 *
 * `CountryCode` is a TypeScript type, so a DTO that declares it proves
 * nothing at run time. An invalid code must be refused loudly, never fall
 * back to the domestic default.
 */
export const CountryCodeSchema = z.string().superRefine((value, ctx) => {
  if (!isCountryCode(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unknown country code',
    });
  }
});

/** Characters and digit count only. Throws on a shape that cannot be a phone. */
function assertPhoneShape(raw: string): void {
  if (!/^\+?[\d\s\-().]*$/.test(raw)) throw new Error('Invalid phone number format');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new Error('Invalid phone number format');
  }
}

/**
 * Normalize a raw phone number to E.164 digits (no `+`).
 *
 * Kept for the Indian-only paths that still call it. It delegates to the one
 * parser in `./phone`, under the explicitly named `legacy-national` rule, so
 * there is exactly one implementation of the Indian assumption in the
 * codebase instead of two that disagree.
 *
 * Throws on unparseable input.
 */
export function normalizePhoneDigits(raw: string): string {
  try {
    return parsePhone({ source: 'legacy-national', raw }).e164;
  } catch {
    throw new Error('Invalid phone number format');
  }
}

/**
 * Domain for the synthetic address given to a staff member invited without a
 * real email. `.invalid` is reserved by RFC 2606, so a bug that tries to mail
 * one fails loudly instead of reaching a stranger.
 *
 * The local part is random on purpose. Sign-in looks a user up by email ALONE
 * (see the `User` comment in schema.prisma) while the unique index is per
 * organisation, so a predictable local part - a phone number, a name - can
 * collide across orgs and land the caller on the wrong row. Random removes that
 * class of bug, and it also stops a re-hired person from squatting on the
 * address of the account they left, which the index still holds for
 * soft-deleted rows.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = 'users.invalid';

/** Local-part prefix of every generated address: `noemail+<hex>@users.invalid`. */
export const PLACEHOLDER_EMAIL_PREFIX = 'noemail+';

/**
 * True for an address this system generated, never for one a person typed.
 *
 * Matches on the prefix and the reserved domain rather than the exact hex, so
 * rows written by an older generator are still recognised after the format
 * changes.
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (email === null || email === undefined) return false;
  const normalised = email.trim().toLowerCase();
  return (
    normalised.startsWith(PLACEHOLDER_EMAIL_PREFIX) &&
    normalised.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)
  );
}

/** Standard error response envelope. */
export const ErrorResponseDtoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
});
export type ErrorResponseDto = z.infer<typeof ErrorResponseDtoSchema>;

/** ISO datetime string. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** Standard success response wrapper. */
export const OkResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown().optional(),
});
export type OkResponse = z.infer<typeof OkResponseSchema>;
