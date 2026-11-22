import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

/**
 * Phone identity for the CRM.
 *
 * Two rules everything else follows from:
 *
 *   1. Storage is canonical E.164 DIGITS, no leading `+`. `Lead.phone` and
 *      `Lead.phoneE164` hold the same string, enforced by a CHECK constraint.
 *      The `+` is added only when rendering or building a `tel:` link.
 *
 *   2. A bare national number with no country is REFUSED, not guessed. The
 *      guess is what silently rewrote +1 650 234 5678 into an Indian number.
 *      The one exception is named: `legacy-national`, which is the Indian
 *      assumption, importable and grep-able so it cannot be reached by
 *      forgetting an argument.
 *
 * `parsePhone` never returns a silently-wrong number and `leadPhoneColumns`
 * makes "wrote one column and forgot the other" unrepresentable.
 */

export type { CountryCode };

/** The one domestic assumption in the system: an Indian call centre. */
export const DOMESTIC_COUNTRY: CountryCode = 'IN';

export type PhoneInput =
  /** A form field. `country: null` means the person has not chosen one. */
  | { source: 'typed'; raw: string; country: CountryCode | null }
  /** Already-canonical international digits, e.g. Meta's webhook `from`. */
  | { source: 'e164'; digits: string }
  /** Historical / Indian-only input. This is the guess, and it is named. */
  | { source: 'legacy-national'; raw: string };

export type PhoneParseReason =
  | 'EMPTY'
  | 'UNPARSEABLE'
  | 'COUNTRY_REQUIRED'
  | 'WRONG_COUNTRY'
  | 'UNKNOWN_COUNTRY';

export class PhoneParseError extends Error {
  readonly reason: PhoneParseReason;
  readonly field = 'phone' as const;

  constructor(reason: PhoneParseReason, message?: string) {
    super(message ?? PHONE_ERRORS[reason]);
    this.name = 'PhoneParseError';
    this.reason = reason;
  }
}

/**
 * The one set of sentences. The API, the forms and the landing page all read
 * from here so the same refusal cannot be worded three ways.
 */
export const PHONE_ERRORS: Record<PhoneParseReason, string> = {
  EMPTY: 'Enter a phone number',
  UNPARSEABLE: 'That does not look like a phone number',
  COUNTRY_REQUIRED: 'Select a country, or enter the number with its country code',
  WRONG_COUNTRY: 'That does not look like a valid number for the selected country',
  UNKNOWN_COUNTRY: 'That is not a country we recognise',
};

/** True for an ISO 3166-1 alpha-2 code libphonenumber knows. */
export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && isSupportedCountry(value.toUpperCase());
}

/**
 * Route a wire value to the right parse rule.
 *
 * A country means "read these digits in that country". No country means the
 * caller is one of the pre-existing Indian paths, and says so by name rather
 * than by omission.
 */
export function toPhoneInput(raw: string, country?: string | null): PhoneInput {
  if (country === null || country === undefined || country === '') {
    return { source: 'legacy-national', raw };
  }
  return { source: 'typed', raw, country: isCountryCode(country) ? country : (country as CountryCode) };
}

/** Country list for the picker, each with its dial code. */
export interface CountryOption {
  code: CountryCode;
  name: string;
  dialCode: string;
}

let countryCache: CountryOption[] | null = null;

export function listCountries(): CountryOption[] {
  if (countryCache) return countryCache;
  const display = new Intl.DisplayNames(['en'], { type: 'region' });
  countryCache = getCountries()
    .map((code) => ({
      code,
      name: safeRegionName(display, code),
      dialCode: `+${getCountryCallingCode(code)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return countryCache;
}

function safeRegionName(display: Intl.DisplayNames, code: CountryCode): string {
  try {
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Strips spaces, dashes, dots and brackets. Keeps a leading `+`. */
function tidy(raw: string): string {
  return raw.replace(/[\s\-().]/g, '');
}

export interface ParsedPhone {
  /** Canonical E.164 digits, no `+`. */
  e164: string;
  /** The region libphonenumber resolved, or null when it could not. */
  region: CountryCode | null;
}

/**
 * Parse a phone number into canonical digits.
 *
 * Throws PhoneParseError, never a bare Error: an untyped throw from a service
 * is mapped to a 500 by the global filter, which turns user input into an
 * outage.
 */
export function parsePhone(input: PhoneInput): ParsedPhone {
  switch (input.source) {
    case 'e164':
      // Meta's `from` is always international digits. This path is LENIENT on
      // purpose: dropping an inbound message is worse than storing a number
      // libphonenumber has no metadata for, so a 7-15 digit run that merely
      // fails validation is accepted as digits with an unknown region.
      return parseInbound(digitsOnly(input.digits));

    case 'legacy-national': {
      const raw = tidy(input.raw);
      if (raw === '') throw new PhoneParseError('EMPTY');
      // The historical Indian shapes, by name, in one place.
      if (/^91\d{10}$/.test(raw)) return parseInternational(raw);
      if (/^0\d{10}$/.test(raw)) return parseInternational(`91${raw.slice(1)}`);
      if (/^[6-9]\d{9}$/.test(raw)) return parseInternational(`91${raw}`);
      return parseInternational(digitsOnly(raw));
    }

    case 'typed': {
      const raw = tidy(input.raw);
      if (raw === '') throw new PhoneParseError('EMPTY');

      if (input.country !== null && !isCountryCode(input.country)) {
        throw new PhoneParseError('UNKNOWN_COUNTRY');
      }

      // An explicit `+` always wins over the selected country: a pasted US
      // number while India is chosen must store the US number.
      if (raw.startsWith('+')) return parseInternational(digitsOnly(raw));

      if (input.country === null) throw new PhoneParseError('COUNTRY_REQUIRED');

      // A number typed without a `+` is read in the chosen country. Two shapes
      // need care:
      //
      //  - a full international number pasted without its `+`
      //    (16502345678, 971501234567). The national read still "validates"
      //    because metadata is generous about digit counts, so a long string
      //    whose international read lands in a DIFFERENT country is taken as
      //    international. Anything 10 digits or shorter stays national: that
      //    is the one ambiguity the visible country selector is there to
      //    resolve, and 9876543210 must remain an Indian number.
      //  - a number that is simply wrong for the country: refused.
      const national = parsePhoneNumberFromString(raw, input.country);
      const international = parsePhoneNumberFromString(`+${digitsOnly(raw)}`);
      const looksPasted =
        digitsOnly(raw).length > 10 &&
        international?.isValid() === true &&
        international.country !== null &&
        international.country !== input.country;

      if (looksPasted && international) {
        return { e164: digitsOnly(international.number), region: international.country ?? null };
      }
      if (national?.isValid()) {
        return { e164: digitsOnly(national.number), region: national.country ?? input.country };
      }
      if (international?.isValid()) {
        return { e164: digitsOnly(international.number), region: international.country ?? null };
      }
      throw new PhoneParseError('WRONG_COUNTRY');
    }
  }
}

function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

function parseInbound(digits: string): ParsedPhone {
  if (digits === '') throw new PhoneParseError('EMPTY');
  if (digits.length < 7 || digits.length > 15) throw new PhoneParseError('UNPARSEABLE');
  const parsed = parsePhoneNumberFromString(`+${digits}`);
  return { e164: digits, region: parsed?.country ?? null };
}

function parseInternational(digits: string): ParsedPhone {
  if (digits === '') throw new PhoneParseError('EMPTY');
  const parsed = parsePhoneNumberFromString(`+${digits}`);
  if (!parsed || !parsed.isPossible()) throw new PhoneParseError('UNPARSEABLE');
  return { e164: digitsOnly(parsed.number), region: parsed.country ?? null };
}

/**
 * The two columns a phone write must set, produced together so a call site
 * cannot write one and forget the other. Both hold canonical digits.
 */
export function leadPhoneColumns(input: PhoneInput): { phone: string; phoneE164: string } {
  const { e164 } = parsePhone(input);
  return { phone: e164, phoneE164: e164 };
}

/** Non-throwing variant for rendering paths and search terms. */
export function tryParsePhone(
  input: PhoneInput,
): { ok: true; value: ParsedPhone } | { ok: false; reason: PhoneParseReason } {
  try {
    return { ok: true, value: parsePhone(input) };
  } catch (error) {
    if (error instanceof PhoneParseError) return { ok: false, reason: error.reason };
    throw error;
  }
}

/**
 * Render a stored number for a human.
 *
 * Never throws. Masked placeholders (`+919****9055`) and other unparseable
 * values pass through untouched: four screens call this inside a table row and
 * one bad row must not blank the list.
 */
export function formatPhone(
  stored: string | null | undefined,
  // Kept for call-site compatibility. Display is international for every
  // number now, so which country counts as "domestic" no longer changes
  // anything - the argument is accepted and ignored.
  _options: { domestic?: CountryCode } = {},
): string {
  if (!stored) return '';
  if (/[*#]/.test(stored)) return stored;

  const parsed = parsePhoneNumberFromString(`+${digitsOnly(stored)}`);

  if (!parsed || !parsed.isPossible()) return stored;

  // Always international. A lead can be anywhere now, so a bare national
  // string is ambiguous: "98765 43210" reads as local to whoever looks at it,
  // and a US number rendered nationally looks Indian. One form for every row.
  return parsed.formatInternational();
}

/** `tel:` href, or null when there is nothing dialable. */
export function telHref(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (/[*#]/.test(stored)) return null;
  const digits = digitsOnly(stored);
  if (digits.length < 7) return null;
  if (!parsePhoneNumberFromString(`+${digits}`)?.isPossible()) return null;
  return `tel:+${digits}`;
}

/**
 * Search terms for a phone column.
 *
 * A partial term must NOT go through the parser: "98" is not a number and
 * refusing it would 500 the list on the first keystroke. Returns the raw digit
 * run plus, when the term is a complete number in some country, the canonical
 * form, so both shapes match.
 */
export function phoneSearchTerms(
  term: string,
  options: { country?: CountryCode | null } = {},
): string[] {
  const raw = term.trim();
  if (raw === '') return [];
  const digits = digitsOnly(raw);
  const terms = new Set<string>();
  if (digits.length >= 3) terms.add(digits);

  if (digits.length >= 7) {
    const country = options.country ?? null;
    const parsed = country
      ? parsePhoneNumberFromString(raw, country)
      : parsePhoneNumberFromString(raw.startsWith('+') ? raw : `+${digits}`);
    if (parsed?.isPossible()) terms.add(digitsOnly(parsed.number));
  }
  return [...terms];
}

/** Region of a stored canonical number, or null when it cannot be resolved. */
export function regionOf(stored: string | null | undefined): CountryCode | null {
  const digits = (stored ?? '').replace(/\D/g, '');
  if (digits === '') return null;
  return parsePhoneNumberFromString(`+${digits}`)?.country ?? null;
}

/** The subscriber part of a stored number, for display inside a country. */
export function nationalDigitsOf(stored: string | null | undefined, country: CountryCode): string {
  const digits = (stored ?? '').replace(/\D/g, '');
  if (digits === '') return '';
  const parsed = parsePhoneNumberFromString(`+${digits}`, country);
  return parsed ? parsed.nationalNumber : digits;
}
