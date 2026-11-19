// @vitest-environment node
// Unit tests for the phone helpers (lib/phone.ts), shared by the
// PhoneNumber component and every phone-rendering surface.
import { describe, expect, it } from 'vitest';

import { formatPhone, telUrl } from './phone';

describe('telUrl', () => {
  it('builds tel: from a plain 10-digit number', () => {
    expect(telUrl('9876543210')).toBe('tel:9876543210');
  });

  it('strips spaces/dashes/parens', () => {
    expect(telUrl('(+91) 98765-43210')).toBe('tel:+919876543210');
  });

  it('keeps an existing + in E164', () => {
    expect(telUrl('+919876543210')).toBe('tel:+919876543210');
  });

  // 2026-11-18 (Defect 2): the digits-only STORED form must gain the `+`,
  // otherwise a handset dials the country code as part of the subscriber
  // number. Every API-created lead holds this shape.
  it('adds the + to the digits-only stored form (91 + 10 digits)', () => {
    expect(telUrl('919876543210')).toBe('tel:+919876543210');
  });

  it('does NOT add a + to a bare 10-digit local number', () => {
    // `tel:+9876543210` would be country code 9 - a different number.
    expect(telUrl('9876543210')).not.toContain('+');
  });

  it('returns empty href for masked placeholders (not dialable)', () => {
    expect(telUrl('+919****3210')).toBe('');
    expect(telUrl('+141****2671')).toBe('');
  });

  it('returns empty href for empty input', () => {
    expect(telUrl('')).toBe('');
  });

  // PhoneNumber renders whatever the API returned; a malformed row must not
  // crash the whole table, so telUrl stays tolerant rather than normalizing.
  it('never throws on unparseable input', () => {
    expect(() => telUrl('not-a-number')).not.toThrow();
    expect(telUrl('not-a-number')).toBe('');
  });
});

describe('formatPhone', () => {
  it('formats a plain 10-digit Indian number', () => {
    expect(formatPhone('9876500009')).toBe('98765 00009');
  });

  it('formats +91 E164', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
  });

  // Defect 2: the shape every API-created lead actually stores. Seed data
  // used 10 digits, which is why this was invisible in demos.
  it('formats the digits-only stored form (91 + 10 digits)', () => {
    expect(formatPhone('919876543210')).toBe('+91 98765 43210');
  });

  it('passes unrecognized foreign E164 through unchanged', () => {
    expect(formatPhone('+14155550123')).toBe('+14155550123');
  });

  it('passes a no-plus foreign number through unchanged', () => {
    expect(formatPhone('14155550123')).toBe('14155550123');
  });

  it('passes masked placeholders through untouched', () => {
    expect(formatPhone('+919****3210')).toBe('+919****3210');
    expect(formatPhone('+141****2671')).toBe('+141****2671');
  });

  it('falls back to raw for unknown shapes', () => {
    expect(formatPhone('not-a-number')).toBe('not-a-number');
  });
});

// ---------------------------------------------------------------------------
// PhoneInputSchema - the CLIENT-side field rule (2026-11-19)
// ---------------------------------------------------------------------------
// The forms used to declare `phone: z.string().optional()`, so a mistyped
// number was accepted locally and only rejected by the API as a toast. These
// pin that (a) the rule matches what the server normalizer accepts, and
// (b) it does NOT transform the value - transforming is what rewrote the
// input mid-keystroke (Defect 1 / phone.ts).
import {
  OptionalPhoneInputSchema,
  PhoneInputSchema,
  isValidPhoneInput,
  phoneFieldMessage,
} from './phone';

describe('isValidPhoneInput', () => {
  it('accepts the shapes the server normalizer accepts', () => {
    for (const value of [
      '9876543210', // 10-digit Indian mobile
      '09876543210', // leading 0
      '919876543210', // already normalized
      '+919876543210', // explicit E164
      '14155550123', // international
    ]) {
      expect(isValidPhoneInput(value), value).toBe(true);
    }
  });

  it('rejects a partial number being typed', () => {
    // The floor is a full 10 digits: anything shorter is a number still being
    // typed. It used to be 7 (the international fallback was `\d{7,15}`), which
    // is how a 7-digit phone could be submitted.
    for (const value of ['9', '98765', '987654', '9876543', '987654321']) {
      expect(isValidPhoneInput(value), value).toBe(false);
    }
  });

  it('rejects a 7-digit value instead of reading it as international', () => {
    expect(isValidPhoneInput('9876543')).toBe(false);
  });

  it('rejects non-numeric garbage', () => {
    for (const value of ['abc', 'not-a-number', '98765abc']) {
      expect(isValidPhoneInput(value), value).toBe(false);
    }
  });

  it("treats an empty string as valid (blank is the caller's decision)", () => {
    // The settings / create-user forms allow clearing a number; marking blank
    // invalid would paint a red border on an untouched optional field.
    expect(isValidPhoneInput('')).toBe(true);
    expect(isValidPhoneInput('   ')).toBe(true);
  });
});

describe('PhoneInputSchema', () => {
  it('passes a valid number through WITHOUT transforming it', () => {
    // The critical difference from PhoneSchema: the value the user typed
    // comes back unchanged, so revalidation cannot rewrite the input.
    const result = PhoneInputSchema.safeParse('9876543210');
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe('9876543210');
  });

  it('does not prepend 91 the way PhoneSchema does', () => {
    const result = PhoneInputSchema.safeParse('+919876543210');
    expect(result.success && result.data).toBe('+919876543210');
  });

  it('fails a partial number with a readable message', () => {
    const result = PhoneInputSchema.safeParse('98765');
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toBe(phoneFieldMessage);
  });

  it('fails a 7-digit number, which used to be submitted as international', () => {
    // The field-level rule every phone form resolver uses (lead create, lead
    // edit, create user, settings). This is the behaviour the form submit hangs
    // off, so pin it here and not only on the predicate.
    const result = PhoneInputSchema.safeParse('9876543');
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toBe(phoneFieldMessage);
  });

  it('allows the empty string so optional fields stay untouched', () => {
    expect(PhoneInputSchema.safeParse('').success).toBe(true);
  });
});

describe('OptionalPhoneInputSchema', () => {
  // Regression (2026-11-19): substituting the format rule for the old
  // `z.string().optional()` silently turned every OPTIONAL phone into a
  // REQUIRED one. The CreateUserForm schema tests caught it; this pins the
  // distinction at the source so the next swap cannot repeat it.
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
    // The required variant must NOT accept a missing key - that is the whole
    // reason both exist.
    expect(PhoneInputSchema.safeParse(undefined).success).toBe(false);
    expect(OptionalPhoneInputSchema.safeParse(undefined).success).toBe(true);
    for (const value of ['', '9876543210', 'abcdefg']) {
      expect(PhoneInputSchema.safeParse(value).success).toBe(
        OptionalPhoneInputSchema.safeParse(value).success,
      );
    }
  });
});
