import { describe, expect, it } from 'vitest';

import {
  DOMESTIC_COUNTRY,
  PHONE_ERRORS,
  PhoneParseError,
  formatPhone,
  isCountryCode,
  isValidMobileNumber,
  leadPhoneColumns,
  limitPhoneTyping,
  listCountries,
  maxNationalDigits,
  mobileNationalLength,
  parsePhone,
  phoneErrorMessage,
  phoneSearchTerms,
  telHref,
  tryParsePhone,
} from '../src/phone';

describe('parsePhone - typed input', () => {
  it('reads a bare national number in the country that was chosen', () => {
    expect(parsePhone({ source: 'typed', raw: '9876543210', country: 'IN' })).toEqual({
      e164: '919876543210',
      region: 'IN',
    });
  });

  it('lets an explicit + win over the chosen country', () => {
    // The defect this feature exists for: India selected, a US number pasted.
    expect(parsePhone({ source: 'typed', raw: '+1 650 234 5678', country: 'IN' })).toEqual({
      e164: '16502345678',
      region: 'US',
    });
    expect(parsePhone({ source: 'typed', raw: '16502345678', country: 'IN' })).toEqual({
      e164: '16502345678',
      region: 'US',
    });
  });

  it('refuses a national number with no country instead of guessing India', () => {
    const error = tryParsePhone({ source: 'typed', raw: '9876543210', country: null });
    expect(error.ok).toBe(false);
    expect(error.ok === false && error.reason).toBe('COUNTRY_REQUIRED');
  });

  it('refuses a number that is not possible for the chosen country', () => {
    // 9 digits is a UAE mobile but not an Indian one.
    const result = tryParsePhone({ source: 'typed', raw: '501234567', country: 'IN' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('WRONG_COUNTRY');
  });

  it('accepts the same digits under the country they belong to', () => {
    expect(parsePhone({ source: 'typed', raw: '501234567', country: 'AE' })).toEqual({
      e164: '971501234567',
      region: 'AE',
    });
  });

  it('rejects an empty string and an unknown country', () => {
    expect(() => parsePhone({ source: 'typed', raw: '   ', country: 'IN' })).toThrow(
      PhoneParseError,
    );
    expect(() =>
      parsePhone({ source: 'typed', raw: '9876543210', country: 'ZZ' as never }),
    ).toThrow(PhoneParseError);
  });
});

describe('per-country mobile rules', () => {
  it('takes the national length from the country, not from a global 10', () => {
    expect(mobileNationalLength('IN')).toBe(10);
    expect(mobileNationalLength('US')).toBe(10);
    expect(mobileNationalLength('AE')).toBe(9);
    expect(mobileNationalLength('SG')).toBe(8);
  });

  it('refuses a 10-digit Indian LANDLINE: a lead phone must be a mobile', () => {
    // 1234567890 is a possible Indian number of the right length, which is why
    // the general metadata accepted it and it reached the leads table. It is not
    // a mobile, so nothing can be sent to it.
    const result = tryParsePhone({ source: 'typed', raw: '1234567890', country: 'IN' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('WRONG_COUNTRY');
  });

  it('applies each country rule to its own numbers', () => {
    // India: 10 digits starting 6-9. US: 10 digits starting 2-9.
    expect(parsePhone({ source: 'typed', raw: '9876543210', country: 'IN' })).toEqual({
      e164: '919876543210',
      region: 'IN',
    });
    expect(parsePhone({ source: 'typed', raw: '6502345678', country: 'US' })).toEqual({
      e164: '16502345678',
      region: 'US',
    });
    expect(tryParsePhone({ source: 'typed', raw: '1234567890', country: 'US' }).ok).toBe(false);
  });

  it('names the country and its length in the refusal', () => {
    const error = (() => {
      try {
        parsePhone({ source: 'typed', raw: '1234567890', country: 'IN' });
        return null;
      } catch (thrown) {
        return thrown as PhoneParseError;
      }
    })();
    expect(error?.message).toBe('That is not a valid mobile number for India (10 digits)');
    // Reasons that are not country-specific keep the one shared sentence.
    expect(phoneErrorMessage('EMPTY', 'IN')).toBe(PHONE_ERRORS.EMPTY);
  });

  it('gives the field a typing cap per country, and 15 where there is none', () => {
    expect(maxNationalDigits('IN')).toBe(10);
    expect(maxNationalDigits('AE')).toBe(9);
    expect(maxNationalDigits(null)).toBe(15);
    expect(maxNationalDigits('ZZ' as never)).toBe(15);
  });

  it('exposes the same rule the cap uses', () => {
    expect(isValidMobileNumber('9876543210', 'IN')).toBe(true);
    expect(isValidMobileNumber('1234567890', 'IN')).toBe(false);
    expect(isValidMobileNumber('', 'IN')).toBe(false);
  });

  it('stops typing at the country length, and lets an international paste through', () => {
    // India: ten digits, then the field stops taking keystrokes.
    expect(limitPhoneTyping('98765 4321', 'IN')).toBe('98765 4321');
    expect(limitPhoneTyping('98765 43210', 'IN')).toBe('98765 43210');
    // The 11th and 12th digits are dropped, separators kept.
    expect(limitPhoneTyping('98765 432100', 'IN')).toBe('98765 43210');
    expect(limitPhoneTyping('98765 4321000', 'IN')).toBe('98765 43210');
    // The same shape in a shorter country stops sooner.
    expect(limitPhoneTyping('9876543210', 'SG')).toBe('98765432');
    // A leading `+` declares its own country: a US number pasted while India
    // is selected must go through, and the server validates it as a US number.
    expect(limitPhoneTyping('+1 650 234 5678', 'IN')).toBe('+1 650 234 5678');
  });
});

describe('parsePhone - canonical and legacy input', () => {
  it('reads Meta webhook digits without a country', () => {
    expect(parsePhone({ source: 'e164', digits: '919876543210' })).toEqual({
      e164: '919876543210',
      region: 'IN',
    });
    expect(parsePhone({ source: 'e164', digits: '16502345678' })).toEqual({
      e164: '16502345678',
      region: 'US',
    });
  });

  it('keeps the historical Indian shapes reachable only by name', () => {
    const legacy = (raw: string) => parsePhone({ source: 'legacy-national', raw }).e164;
    expect(legacy('9876543210')).toBe('919876543210');
    expect(legacy('09876543210')).toBe('919876543210');
    expect(legacy('919876543210')).toBe('919876543210');
    expect(legacy('+91 98765 43210')).toBe('919876543210');
  });

  it('refuses a bare digit run that is not a full number', () => {
    expect(() => parsePhone({ source: 'e164', digits: '98765' })).toThrow(PhoneParseError);
  });
});

describe('leadPhoneColumns', () => {
  it('returns both columns from one call, holding the same canonical digits', () => {
    const columns = leadPhoneColumns({ source: 'typed', raw: '+971 50 123 4567', country: 'IN' });
    expect(columns).toEqual({ phone: '971501234567', phoneE164: '971501234567' });
  });
});

describe('display helpers never throw', () => {
  it('passes masked placeholders through untouched', () => {
    expect(formatPhone('+919****9055')).toBe('+919****9055');
    expect(telHref('+919****9055')).toBeNull();
  });

  it('shows every number in international form, so no lead reads as local', () => {
    expect(formatPhone('919876543210')).toBe('+91 98765 43210');
    expect(formatPhone('16502345678')).toBe('+1 650 234 5678');
    expect(formatPhone('16502345678', { domestic: 'US' })).toBe('+1 650 234 5678');
  });

  it('returns an empty string for nothing, and a dialable href for a real number', () => {
    expect(formatPhone(null)).toBe('');
    expect(telHref(null)).toBeNull();
    expect(telHref('919876543210')).toBe('tel:+919876543210');
    expect(telHref('16502345678')).toBe('tel:+16502345678');
  });
});

describe('search and country list', () => {
  it('returns a partial digit run as-is without parsing it', () => {
    expect(phoneSearchTerms('98')).toEqual([]);
    expect(phoneSearchTerms('9876')).toEqual(['9876']);
  });

  it('adds the canonical form for a complete number', () => {
    expect(phoneSearchTerms('9876543210', { country: 'IN' })).toEqual([
      '9876543210',
      '919876543210',
    ]);
    expect(phoneSearchTerms('+1 650 234 5678')).toEqual(['16502345678']);
  });

  it('knows real ISO codes and rejects invented ones', () => {
    expect(isCountryCode('IN')).toBe(true);
    expect(isCountryCode('ae')).toBe(true);
    expect(isCountryCode('ZZ')).toBe(false);
    expect(isCountryCode(42)).toBe(false);
  });

  it('lists countries with names and dial codes, India included', () => {
    const countries = listCountries();
    expect(countries.length).toBeGreaterThan(200);
    expect(countries.find((c) => c.code === DOMESTIC_COUNTRY)).toMatchObject({
      code: 'IN',
      name: 'India',
      dialCode: '+91',
    });
    expect(countries.find((c) => c.code === 'AE')).toMatchObject({ dialCode: '+971' });
  });
});
