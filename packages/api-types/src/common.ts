// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Common DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Shared pagination, error envelopes, ID param schemas. Used by every
// NestJS controller and Next.js route handler.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

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
 *   7–15 digits otherwise          → as-is (international)
 *
 * Anything outside these shapes fails validation. The output is the
 * normalized digits-only E.164 form (no leading "+").
 */
export const PhoneSchema = z
  .string()
  .superRefine((raw, ctx) => {
    // Reuse the landing page's throwing validator for shape checks;
    // surface its failure as a Zod issue so `.safeParse` returns
    // `success:false` instead of re-throwing.
    try {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      normalizePhoneDigits(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please enter a valid phone number',
      });
    }
  })
  .transform((raw) => normalizePhoneDigits(raw));
export type PhoneNumber = z.infer<typeof PhoneSchema>;

/**
 * Normalize a raw phone number to E.164 format (digits only, no +).
 * Ported verbatim from landing-page/lib/enquiry-schema.ts `normalizePhone`.
 * Throws on unparseable input.
 *
 * Handles:
 *   +91XXXXXXXXXX  → 91XXXXXXXXXX
 *   91XXXXXXXXXX   → 91XXXXXXXXXX
 *   0XXXXXXXXXX    → 91XXXXXXXXXX  (strip leading 0, prepend 91)
 *   XXXXXXXXXX     → 91XXXXXXXXXX  (10 digits starting 6-9 = Indian mobile)
 *   +1XXXXXXXXXX   → 1XXXXXXXXXX   (international, strip +)
 */
export function normalizePhoneDigits(raw: string): string {
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);

  // Indian: starts with 91 and has 12 digits total
  if (/^91\d{10}$/.test(digits)) return digits;
  // Indian: starts with 0 and has 11 digits → strip 0, prepend 91
  if (/^0\d{10}$/.test(digits)) return '91' + digits.slice(1);
  // Indian mobile: 10 digits starting with 6-9 → prepend 91
  if (/^[6-9]\d{9}$/.test(digits)) return '91' + digits;
  // International: 7+ digits, starts with a valid country code
  if (/^\d{7,15}$/.test(digits)) return digits;

  throw new Error('Invalid phone number format');
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
