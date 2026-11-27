// @vitest-environment node
// Unit tests for the phone helpers (lib/phone.ts).
//
// Since 2026-11-22 these helpers are a THIN ADAPTER over
// `@shadhil/api-types/phone`: parsing, canonicalisation and display live
// there. What is pinned here is (a) the adapter's own contract - the shapes it
// must keep working for the CRM's stored data, and (b) the two form rules: the
// SHAPE rule (`PhoneInputSchema`) and, since 2026-11-27, the COUNTRY rule
// (`phoneNumberMessage` / `refinePhonePair`) that runs the server's parser
// client-side so an invalid number reports under the field instead of as a
// toast.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  OptionalPhoneInputSchema,
  PhoneCountrySchema,
  PhoneInputSchema,
  countryOfStored,
  formatPhone,
  isValidPhoneInput,
  phoneFieldMessage,
  phoneNumberMessage,
  refinePhonePair,
  telUrl,
  toPhoneInputValue,
} from './phone';

describe('telUrl', () => {
  it('adds the + and the country code to canonical stored digits', () => {
    expect(telUrl('919876543210')).toBe('tel:+919876543210');
  });

  it('dials a legacy bare 10-digit mobile as the Indian number it is', () => {
    // Seed rows still hold this shape. Dialling it without a country code made
    // a handset treat `91` as part of the subscriber number.
    expect(telUrl('9876543210')).toBe('tel:+919876543210');
  });

  it('strips spaces/dashes/parens and trusts an explicit +', () => {
    expect(telUrl('(+91) 98765-43210')).toBe('tel:+919876543210');
    expect(telUrl('+919876543210')).toBe('tel:+919876543210');
  });

  it('returns an EMPTY href (not null) for masked placeholders', () => {
    expect(telUrl('919****3210')).toBe('');
  });

  it('returns an empty href for empty input', () => {
    expect(telUrl('')).toBe('');
  });

  it('refuses a number no dialler could use instead of guessing', () => {
    // 1234567890 is not an Indian mobile, and the shared parser will not read
    // it as another country's number either - so there is nothing to dial.
    expect(telUrl('1234567890')).toBe('');
  });

  it('never throws on unparseable input', () => {
    // PhoneNumber renders whatever the API returned; a malformed row must not
    // crash the whole table.
    expect(() => telUrl('not-a-number')).not.toThrow();
    expect(telUrl('not-a-number')).toBe('');
  });
});

describe('formatPhone', () => {
  it('formats canonical digits in the domestic national format', () => {
    // One display form for every row: the dial code is always visible, so a
    // foreign lead never reads as a local number.
    expect(formatPhone('919876543210')).toBe('+91 98765 43210');
  });

  it('formats a legacy bare 10-digit mobile the same way', () => {
    expect(formatPhone('9876500009')).toBe('+91 98765 00009');
  });

  it('formats an explicit +91 value', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
  });

  it('shows a foreign number with its country code', () => {
    // Every number carries its dial code, so a US lead cannot read as local.
    expect(formatPhone('14155550123')).toBe('+1 415 555 0123');
    expect(formatPhone('+14155550123')).toBe('+1 415 555 0123');
  });

  it('passes masked placeholders through untouched', () => {
    expect(formatPhone('919****3210')).toBe('919****3210');
    expect(formatPhone('+919****3210')).toBe('+919****3210');
  });

  it('falls back to raw for unknown shapes', () => {
    expect(formatPhone('not-a-number')).toBe('not-a-number');
  });

  it('renders an empty string for an absent value', () => {
    expect(formatPhone('')).toBe('');
  });
});

describe('toPhoneInputValue', () => {
  // The field takes canonical digits now, so nothing is shortened: shortening
  // is what made a normalised lead number lose its country code on the first
  // keystroke (the Defect 1 corruption path).
  it('returns canonical digits unchanged', () => {
    expect(toPhoneInputValue('919876543210')).toBe('919876543210');
  });

  it('lifts a legacy bare mobile to canonical digits', () => {
    expect(toPhoneInputValue('9876543210')).toBe('919876543210');
  });

  it('drops a leading + (the field stores digits, not a dial string)', () => {
    expect(toPhoneInputValue('+919876543210')).toBe('919876543210');
  });

  it('keeps a foreign number as it is', () => {
    expect(toPhoneInputValue('14155550123')).toBe('14155550123');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(toPhoneInputValue(null)).toBe('');
    expect(toPhoneInputValue(undefined)).toBe('');
    expect(toPhoneInputValue('')).toBe('');
  });
});

describe('countryOfStored', () => {
  it('resolves the region of a canonical number', () => {
    expect(countryOfStored('919876543210')).toBe('IN');
    expect(countryOfStored('14155550123')).toBe('US');
  });

  it('reads a legacy bare mobile as domestic, not as a foreign country', () => {
    // Parsed naively, a bare 10-digit Indian number resolves to +98 (Iran).
    expect(countryOfStored('9876543210')).toBe('IN');
  });

  it('returns null when there is nothing to resolve', () => {
    expect(countryOfStored('')).toBeNull();
    expect(countryOfStored(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Form rules - SHAPE ONLY
// ---------------------------------------------------------------------------
// Country rules run server-side (`parsePhone` with `phoneCountry`). The field
// only refuses what no country could accept, so these expectations are about
// shape and nothing else.
describe('isValidPhoneInput', () => {
  it('accepts numbers from any country', () => {
    for (const value of [
      '919876543210', // canonical Indian
      '9876543210', // legacy bare Indian
      '+919876543210', // explicit E.164
      '+14155550123', // US
      '+65 6123 4567', // Singapore, punctuation included
      '61234567', // an 8-digit national number
    ]) {
      expect(isValidPhoneInput(value), value).toBe(true);
    }
  });

  it('rejects a value that is not a number at all', () => {
    for (const value of ['abc', 'not-a-number', '98765abc', '--']) {
      expect(isValidPhoneInput(value), value).toBe(false);
    }
  });

  it('rejects values outside the E.164 digit range', () => {
    expect(isValidPhoneInput('123456')).toBe(false); // 6 digits
    expect(isValidPhoneInput('1234567890123456')).toBe(false); // 16 digits
  });

  it("treats an empty string as valid (blank is the caller's decision)", () => {
    expect(isValidPhoneInput('')).toBe(true);
    expect(isValidPhoneInput('   ')).toBe(true);
  });
});

describe('PhoneInputSchema', () => {
  it('passes a valid number through WITHOUT transforming it', () => {
    // The critical difference from the wire `PhoneSchema`, which normalizes to
    // `91XXXXXXXXXX`: revalidation must never rewrite what the operator typed.
    const result = PhoneInputSchema.safeParse('9876543210');
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe('9876543210');
  });

  it('does not prepend a country code', () => {
    const result = PhoneInputSchema.safeParse('+14155550123');
    expect(result.success && result.data).toBe('+14155550123');
  });

  it('fails a malformed value with the shared field message', () => {
    const result = PhoneInputSchema.safeParse('not-a-number');
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toBe(phoneFieldMessage);
  });

  it('allows the empty string so optional fields stay untouched', () => {
    expect(PhoneInputSchema.safeParse('').success).toBe(true);
  });

  it('does not accept an ABSENT phone', () => {
    expect(PhoneInputSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('OptionalPhoneInputSchema', () => {
  it('accepts an ABSENT phone (omitted key)', () => {
    expect(OptionalPhoneInputSchema.safeParse(undefined).success).toBe(true);
  });

  it('accepts a blank phone (meaning "clear it")', () => {
    expect(OptionalPhoneInputSchema.safeParse('').success).toBe(true);
  });

  it('still rejects a malformed phone when one IS provided', () => {
    expect(OptionalPhoneInputSchema.safeParse('abcdefg').success).toBe(false);
    expect(OptionalPhoneInputSchema.safeParse('123').success).toBe(false);
  });

  it('accepts a valid phone', () => {
    expect(OptionalPhoneInputSchema.safeParse('9876543210').success).toBe(true);
  });

  it('differs from PhoneInputSchema only on undefined', () => {
    expect(PhoneInputSchema.safeParse(undefined).success).toBe(false);
    expect(OptionalPhoneInputSchema.safeParse(undefined).success).toBe(true);
    for (const value of ['', '9876543210', 'abcdefg']) {
      expect(PhoneInputSchema.safeParse(value).success).toBe(
        OptionalPhoneInputSchema.safeParse(value).success,
      );
    }
  });
});

describe('phoneNumberMessage (the country rule)', () => {
  it('accepts a valid mobile typed nationally', () => {
    expect(phoneNumberMessage('9876543210', 'IN')).toBeNull();
    // The field hands over formatted text, so spaces have to survive.
    expect(phoneNumberMessage('98765 43210', 'IN')).toBeNull();
    expect(phoneNumberMessage('919876543210', 'IN')).toBeNull();
  });

  it('accepts a number that carries its own country', () => {
    // A US number pasted while India is on the trigger is the case the field
    // exists to support; refusing it as "not Indian" would be wrong.
    expect(phoneNumberMessage('+16505550123', 'IN')).toBeNull();
  });

  it('refuses digits that are not a mobile in the selected country', () => {
    // `1234567890` passes the 7-15 digit shape rule, which is why it used to
    // reach the API and come back as a toast. The sentence is the server's own.
    expect(phoneNumberMessage('1234567890', 'IN')).toBe(
      'That is not a valid mobile number for India (10 digits)',
    );
  });

  it('keeps the shared shape sentence for something that is not a number', () => {
    expect(phoneNumberMessage('9876', 'IN')).toBe(phoneFieldMessage);
    expect(phoneNumberMessage('call me maybe', 'IN')).toBe(phoneFieldMessage);
  });

  it('treats blank as acceptable - required-ness is the caller decision', () => {
    expect(phoneNumberMessage('', 'IN')).toBeNull();
    expect(phoneNumberMessage(null, 'IN')).toBeNull();
  });

  it('reads a number in the country it is given, not the domestic one', () => {
    // 10 national digits are a US mobile and NOT an Indian one (India needs
    // 6-9 to start); the rule has to follow the trigger, not default to IN.
    expect(phoneNumberMessage('4155550123', 'US')).toBeNull();
  });
});

describe('refinePhonePair (the form-level rule)', () => {
  function pairSchema(options: { required?: boolean } = {}) {
    return z
      .object({
        phone: PhoneInputSchema.optional(),
        phoneCountry: PhoneCountrySchema.optional(),
      })
      .superRefine((values, ctx) => refinePhonePair(values, ctx, options));
  }

  it('reports a wrong-country number ON the phone field', () => {
    const result = pairSchema().safeParse({ phone: '1234567890', phoneCountry: 'IN' });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['phone']);
    expect(issues[0]?.message).toBe('That is not a valid mobile number for India (10 digits)');
  });

  it('does not double-report a value the shape rule already refused', () => {
    const result = pairSchema().safeParse({ phone: '9876', phoneCountry: 'IN' });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(phoneFieldMessage);
  });

  it('leaves a valid pair alone', () => {
    expect(pairSchema().safeParse({ phone: '9876543210', phoneCountry: 'IN' }).success).toBe(true);
  });

  it('requires a number only when the caller asks for it', () => {
    const optional = pairSchema().safeParse({ phone: '', phoneCountry: 'IN' });
    expect(optional.success).toBe(true);

    const required = pairSchema({ required: true }).safeParse({ phone: '', phoneCountry: 'IN' });
    expect(required.success).toBe(false);
    const issues = required.success ? [] : required.error.issues;
    expect(issues[0]?.path).toEqual(['phone']);
    expect(issues[0]?.message).toBe('Enter a phone number');
  });
});
