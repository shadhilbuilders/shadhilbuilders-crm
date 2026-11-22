// Phone helpers shared across the CRM (leads table, lead detail, invites,
// WhatsApp unknown contacts).
//
// ONE IMPLEMENTATION (2026-11-22): parsing, canonicalisation, display
// formatting and `tel:` links all live in `@shadhil/api-types/phone`. This
// module is the CRM-facing adapter that keeps the names call sites already
// import; it holds no rules of its own beyond a narrow legacy display bridge
// (see `withDomesticCountry`) and a shape-only form validator.

import {
  DOMESTIC_COUNTRY,
  PHONE_ERRORS,
  formatPhone as formatStoredPhone,
  isCountryCode,
  regionOf,
  telHref,
  type CountryCode,
} from '@shadhil/api-types/phone';
import { z } from 'zod';

/** India's calling code, the one domestic assumption in the system. */
const DOMESTIC_CALLING_CODE = '91';

/**
 * Legacy display bridge for rows written before phones were stored
 * canonically. Every seed lead - and many older rows - hold a BARE 10-digit
 * Indian mobile; the shared parser deliberately refuses to guess a country
 * from a bare national number, because that guess is what rewrote a US number
 * into an Indian one.
 *
 * Display is the one place the domestic reading is still safe, so it is
 * applied here, named, and only for a shape that cannot be claimed by another
 * country: exactly 10 digits starting 6-9 (the Indian mobile range).
 */
function withDomesticCountry(stored: string): string {
  const digits = stored.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `${DOMESTIC_CALLING_CODE}${digits}`;
  return stored;
}

/**
 * Build a `tel:` href from a stored phone value.
 *
 * Delegates to the shared `telHref`, which adds the `+` and refuses anything
 * that is not a possible number. This wrapper keeps the local contract every
 * call site already relies on: an EMPTY STRING (not null) when there is
 * nothing dialable, so `<a href={telUrl(...)}>` never renders a null href.
 *
 * Masked placeholders are not numbers and yield `''`.
 */
export function telUrl(phone: string): string {
  return telHref(withDomesticCountry(phone)) ?? '';
}

/**
 * Format a stored phone for display, delegating to the shared formatter.
 *
 * - canonical digits (91 + a 10-digit Indian mobile) -> `98765 43210`
 * - a legacy bare 10-digit Indian mobile            -> `98765 00009`
 * - a foreign number                                -> `+` and its digits
 * - a masked placeholder or anything unparseable    -> passed through as-is
 *
 * Never throws: four surfaces call this inside a table row, and one bad row
 * must not blank the list.
 */
export function formatPhone(phone: string): string {
  return formatStoredPhone(withDomesticCountry(phone));
}

/**
 * The stored value in the shape `IntlPhoneInput` takes: canonical E.164
 * DIGITS with no `+`.
 *
 * It used to strip the `91` country code so a 10-digit-capped input could hold
 * an Indian mobile. `IntlPhoneInput` carries the country itself, so nothing is
 * shortened any more - that shortening is what made a normalised lead number
 * lose its country code on the first keystroke.
 */
export function toPhoneInputValue(stored: string | null | undefined): string {
  const value = typeof stored === 'string' ? stored.trim() : '';
  // Same legacy bridge as the display helpers: a bare 10-digit mobile is
  // opened as the Indian number it is, so the field neither shows the wrong
  // flag nor sends digits the server would have to guess a country for.
  // Canonical values pass through untouched.
  const canonical = withDomesticCountry(value);
  // Canonical form has no `+`; a few pre-normalisation rows still carry one.
  return canonical.startsWith('+') ? canonical.slice(1) : canonical;
}

/**
 * The country a stored value should be opened in.
 *
 * `regionOf` cannot answer this for the legacy bare-mobile shape (it would read
 * a bare 10-digit Indian number as Iran), so the same domestic bridge that
 * governs display governs the picker.
 */
export function countryOfStored(stored: string | null | undefined): CountryCode | null {
  const value = typeof stored === 'string' ? stored.trim() : '';
  const digits = value.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return DOMESTIC_COUNTRY;
  return regionOf(value);
}

// ---------------------------------------------------------------------------
// Form-level validation
// ---------------------------------------------------------------------------
// SHAPE ONLY (2026-11-22). Country rules - the national prefix, whether the
// digits are valid for the chosen country, how to read a bare number - live in
// exactly one place: the shared parser (`parsePhone`), which runs on the
// SERVER with the country the operator picked (`phoneCountry`). A form field
// cannot know any of that, so it answers the only question it can: "is this
// plausibly a phone number at all?". Every country shares that shape, so there
// is nothing Indian left to hand-roll here.
//
// `''` is ALLOWED: clearing is the caller's decision, and requiring a value is
// the field's own concern (see OptionalPhoneInputSchema).
export const phoneFieldMessage = 'Enter a valid phone number';

/** Digits (with at most one leading `+`) and the punctuation people type. */
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;
/** E.164 caps a number at 15 digits; below 7 nothing is a phone number. */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

export function isValidPhoneInput(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true; // "empty" is the caller's decision
  if (!PHONE_SHAPE.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS;
}

/** Zod-ready predicate for a phone field that keeps the typed value as-is. */
export function phoneInputIssue(value: string): string | null {
  return isValidPhoneInput(value) ? null : phoneFieldMessage;
}

/**
 * The field schema to drop into a form's zod object.
 *
 * Deliberately transform-free: it validates and hands the value back
 * unchanged, so react-hook-form revalidation cannot rewrite what the operator
 * typed (the server canonicalises `phone` + `phoneCountry` on submit).
 *
 * It does NOT accept `undefined` - a field absent from the payload is a
 * different question from one left blank. Optional phone fields use
 * `OptionalPhoneInputSchema`.
 */
export const PhoneInputSchema = z
  .string()
  .refine((value) => isValidPhoneInput(value), { message: phoneFieldMessage });

/** The same rule for a phone field the UI treats as OPTIONAL. */
export const OptionalPhoneInputSchema = PhoneInputSchema.optional();

/** The country a phone field starts on when the row does not say otherwise. */
export const DEFAULT_PHONE_COUNTRY = DOMESTIC_COUNTRY;

/**
 * The country that travels WITH the digits.
 *
 * A phone number is only interpretable beside the country it was typed in, so
 * every form keeps the pair together and sends `phoneCountry` alongside
 * `phone`. Typed as `CountryCode`, not `string`, so the request body cannot
 * accept a value the server would refuse.
 */
export const PhoneCountrySchema = z.custom<CountryCode>((value) => isCountryCode(value), {
  message: PHONE_ERRORS.UNKNOWN_COUNTRY,
});
