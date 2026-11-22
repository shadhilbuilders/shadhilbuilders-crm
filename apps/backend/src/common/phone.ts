import { BadRequestException } from '@nestjs/common';
import {
  PHONE_ERRORS,
  PhoneParseError,
  parsePhone,
  toPhoneInput,
  type CountryCode,
} from '@shadhil/api-types';

/**
 * Canonical phone digits for a write, or null for "no number".
 *
 * Every service that stores a phone goes through this so the two rules cannot
 * drift: blank means null, and anything else is parsed exactly once with the
 * country the caller supplied. A refusal becomes a 400 carrying the same
 * sentence the form shows, not a 500.
 */
export function canonicalPhoneOrThrow(
  raw: string | null | undefined,
  country?: string | null,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw.trim() === '') return null;

  try {
    return parsePhone(toPhoneInput(raw, country as CountryCode | null)).e164;
  } catch (error) {
    if (error instanceof PhoneParseError) {
      throw new BadRequestException(PHONE_ERRORS[error.reason]);
    }
    throw error;
  }
}
