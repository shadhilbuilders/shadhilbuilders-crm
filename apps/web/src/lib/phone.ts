// Phone-number helpers shared across the CRM, extracted from the
// Shadhil landing page's lib/site.ts telUrl logic so every surface
// (leads table, lead detail, WhatsApp unknown contacts) uses one
// consistent dialer link + display format.

/**
 * Build a `tel:` href from a raw phone string. Strips everything but
 * `+` and digits so `"(+91) 98765 43210"` → `tel:+919876543210`.
 * Masked placeholders (contain `*`) yield an empty href (not dialable).
 */
export function telUrl(phone: string): string {
  if (phone.includes('*')) return '';
  const digits = phone.replace(/[^+\d]/g, '');
  return digits.length > 0 ? `tel:${digits}` : '';
}

/**
 * Format a raw phone for display. Handles the two shapes used across
 * the app and falls back to the raw string for anything unknown or
 * masked (`*` placeholders are NOT real numbers and pass through):
 *   - `9876500009` (plain 10-digit Indian)   → `98765 00009`
 *   - `+919876543210` (E164, +91)            → `+91 98765 43210`
 *   - `+919****3210` (masked)                → `+919****3210`
 */
export function formatPhone(phone: string): string {
  if (phone.includes('*')) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  // E164 with the +91 country code (Indian WhatsApp contacts).
  if (phone.startsWith('+91') && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  // Don't guess at other country codes - pass them through unchanged
  // (the CRM mostly handles Indian numbers; foreign E164 stays raw so
  // we never mis-format a number we don't recognize).
  return phone;
}
