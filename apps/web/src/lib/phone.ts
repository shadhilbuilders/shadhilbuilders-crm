// Phone-number helpers shared across the CRM, extracted from the
// Shadhil landing page's lib/site.ts telUrl logic so every surface
// (leads table, lead detail, WhatsApp unknown contacts) uses one
// consistent dialer link + display format.

import { normalizePhoneDigits } from '@shadhil/api-types';
import { z } from 'zod';

/**
 * Build a `tel:` href from a raw phone string. Strips everything but
 * `+` and digits so `"(+91) 98765 43210"` → `tel:+919876543210`.
 * Masked placeholders (contain `*`) yield an empty href (not dialable).
 *
 * 2026-11-18 (user-phone rev 5): the digits-only STORED form
 * (`919876543210`, what `PhoneSchema` persists) now gains the `+`. Without
 * it the href was `tel:919876543210`, which a handset interprets as a local
 * number - the country code is not stripped, it is dialed as part of the
 * subscriber number. A bare 10-digit value keeps its existing local-dial
 * behaviour, because `tel:+9876543210` would be country code 9 and is not a
 * number anybody meant.
 */
export function telUrl(phone: string): string {
  if (phone.includes('*')) return '';
  const digits = phone.replace(/[^+\d]/g, '');
  if (digits.length === 0) return '';
  // Already an explicit international number - trust the caller's `+`.
  if (digits.startsWith('+')) return `tel:${digits}`;
  // The normalized stored form (91 + a 10-digit Indian mobile).
  if (/^91\d{10}$/.test(digits)) return `tel:+${digits}`;
  // Local 10-digit and unrecognised shapes: unchanged.
  return `tel:${digits}`;
}

/**
 * Format a raw phone for display. Handles the shapes actually stored across
 * the app and falls back to the raw string for anything unknown or masked
 * (`*` placeholders are NOT real numbers and pass through):
 *   - `9876500009` (plain 10-digit Indian)   → `98765 00009`
 *   - `+919876543210` (E164, +91)            → `+91 98765 43210`
 *   - `919876543210` (stored normalized)     → `+91 98765 43210`
 *   - `+919****3210` (masked)                → `+919****3210`
 *
 * The third shape is why this function was wrong until 2026-11-18: every
 * lead created through the API stores the digits-only normalized value
 * (`PhoneSchema` → `normalizePhoneDigits`), but only the `+`-prefixed form
 * was handled. Seed rows hold `9876500001` and rendered correctly, so the
 * bug was invisible in demo data and only showed on real leads.
 */
export function formatPhone(phone: string): string {
  if (phone.includes('*')) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  // Indian, either explicit E164 (`+91…`) or the digits-only stored form.
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  // Don't guess at other country codes - pass them through unchanged
  // (the CRM mostly handles Indian numbers; foreign E164 stays raw so
  // we never mis-format a number we don't recognize).
  return phone;
}

/**
 * Convert a STORED phone value into the 10-digit form `PhoneNumberInput`
 * expects, for prefill only.
 *
 * WHY THIS EXISTS (Defect 1, fixed 2026-11-18): the stored value is the
 * digits-only normalized form (`919876543210`, what `PhoneSchema` persists),
 * but `PhoneNumberInput` caps typing at 10 digits and sanitizes with
 * `digitsOnly(value, 10)` on change. It renders a 12-char controlled value
 * untouched (React does not apply `maxLength` to a programmatic value), so
 * the field LOOKED right - and the FIRST KEYSTROKE truncated it:
 *
 *   919876543210 -> 9198765432 -> normalized -> 919198765432
 *
 * One character typed silently rewrote a lead's phone number. Prefilling the
 * 10-digit local form removes the mismatch, so typing appends to `9876543210`
 * and the round-trip is lossless.
 *
 * Only the exact `91` + 10-digit Indian mobile shape is shortened. Anything
 * else (international, masked, a plain 10-digit value, garbage) is returned
 * unchanged: guessing would be worse than showing the raw value.
 */
export function toPhoneInputValue(stored: string | null | undefined): string {
  const value = typeof stored === 'string' ? stored.trim() : '';
  if (value.includes('*')) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 10) return digits;
  return value;
}
/**
 * Client-side phone rule for forms whose schema leaves `phone` unvalidated.
 *
 * WHY NOT `PhoneSchema` DIRECTLY (2026-11-19): `PhoneSchema` TRANSFORMS its
 * input (`'9876543210' → '919876543210'`). Used as a react-hook-form field
 * schema it would rewrite the value the user is typing - the field would
 * jump to 12 digits mid-keystroke, which is exactly the class of bug
 * `toPhoneInputValue` exists to undo. So this mirrors the RULE without the
 * transform: validate against the server's own normalizer, keep the value.
 *
 * DERIVED, NOT RE-DECLARED. The test below asserts this accepts/rejects the
 * same shapes as `normalizePhoneDigits` (which `PhoneSchema` itself calls),
 * so the inline message cannot drift from what the API will accept.
 *
 * `''` is ALLOWED here - clearing is handled by the caller (`'' → null` on
 * submit for the clearable endpoints). Whether the field is REQUIRED is the
 * field's own concern, not the format's.
 */
export const phoneFieldMessage = 'Enter a valid phone number';

export function isValidPhoneInput(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true; // "empty" is the caller's decision
  try {
    normalizePhoneDigits(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Zod-ready predicate for a phone field that keeps the typed value as-is. */
export function phoneInputIssue(value: string): string | null {
  return isValidPhoneInput(value) ? null : phoneFieldMessage;
}

/**
 * The field schema to drop into a form's zod object.
 *
 * Use this INSTEAD of `z.string().optional()` on every phone field that has
 * no server-transform step of its own. It is deliberately transform-free
 * (see `isValidPhoneInput` for why `PhoneSchema` cannot be used here).
 *
 * `''` passes: a blank field means "not provided" (or "clear it", which the
 * caller maps to `null`), and marking it invalid would paint a red border on
 * an untouched optional field. It does NOT accept `undefined` - a field that
 * is absent from the payload is a different question from one left blank. For
 * the optional phone fields use `OptionalPhoneInputSchema`.
 */
export const PhoneInputSchema = z
  .string()
  .refine((value) => isValidPhoneInput(value), { message: phoneFieldMessage });

/**
 * The same rule for a phone field the UI treats as OPTIONAL.
 *
 * Needed because the api-types DTOs mark phone `.optional()` (an omitted key
 * means "leave it alone"), and a schema test that builds a payload without a
 * `phone` key must still pass. Without this, adding the format rule silently
 * turned every optional phone into a required one - caught by the existing
 * CreateUserForm tests.
 */
export const OptionalPhoneInputSchema = PhoneInputSchema.optional();

