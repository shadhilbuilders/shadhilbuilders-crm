// Public landing-form contract: the phone field must reject garbage HERE.
//
// Before 2026-11-19 the rule was `.min(7).max(20)` - a length check only - so
// `abcdefg123` passed this schema and only failed a layer down when the
// service re-parsed onto CreateLeadDtoSchema. That late failure surfaced as a
// 500 (see apps/backend/src/common/parse-service-body.ts). Rejecting it at the
// public boundary keeps the message on the field the visitor typed.
import { CreateLeadDtoSchema, PhoneSchema } from '@shadhil/api-types';
import { describe, expect, it } from 'vitest';

import { PublicCreateLeadDtoSchema } from '../src/public-leads';

function parsePhone(phone: string) {
  return PublicCreateLeadDtoSchema.safeParse({ fullName: 'Asha', phone });
}

describe('PublicCreateLeadDtoSchema.phone', () => {
  it('accepts a plain 10-digit Indian mobile', () => {
    expect(parsePhone('9876543210').success).toBe(true);
  });

  it('accepts E164 with a + and separators', () => {
    for (const value of [
      '+919876543210',
      '919876543210',
      '09876543210',
      '98765 43210',
      '987-654-3210',
      '(044) 2833-3333',
      '+1 (415) 555-0123',
    ]) {
      expect(parsePhone(value).success, value).toBe(true);
    }
  });

  it('rejects letters (the original hole)', () => {
    // Passed the old `.min(7).max(20)` length-only rule.
    expect(parsePhone('abcdefg123').success).toBe(false);
  });

  it('rejects values shorter than 7 digits', () => {
    expect(parsePhone('98765').success).toBe(false);
    expect(parsePhone('123456').success).toBe(false);
  });

  it('rejects more than 15 digits (the server ceiling)', () => {
    // A 20-char length rule would have admitted these; PhoneSchema caps at 15.
    expect(parsePhone('12345678901234567890').success).toBe(false);
    expect(parsePhone('1234567890123456789').success).toBe(false);
  });

  it('rejects a blank phone (required on the public form)', () => {
    expect(parsePhone('').success).toBe(false);
  });

  it('agrees with the real PhoneSchema on the shapes it accepts', () => {
    // The public schema must not advertise a contract the internal one
    // rejects. Anything this accepts should survive PhoneSchema too.
    for (const value of ['9876543210', '+919876543210', '98765 43210']) {
      expect(parsePhone(value).success, value).toBe(true);
      expect(PhoneSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('is at least as strict as CreateLeadDtoSchema for letters', () => {
    expect(CreateLeadDtoSchema.shape.phone.safeParse('abcdefg123').success).toBe(false);
    expect(parsePhone('abcdefg123').success).toBe(false);
  });
});
