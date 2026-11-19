// Phone-number helpers shared across the CRM, extracted from the
// Shadhil landing page's lib/site.ts telUrl logic so every surface
// (leads table, lead detail, WhatsApp unknown contacts) uses one
// consistent dialer link + display format.

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
