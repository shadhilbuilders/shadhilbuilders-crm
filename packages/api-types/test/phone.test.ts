import { describe, expect, it } from 'vitest';

import {
  DOMESTIC_COUNTRY,
  PhoneParseError,
  formatPhone,
  isCountryCode,
  leadPhoneColumns,
  listCountries,
  parsePhone,
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
    expect(() => parsePhone({ source: 'typed', raw: '   ', country: 'IN' })).toThrow(PhoneParseError);
    expect(() =>
      parsePhone({ source: 'typed', raw: '9876543210', country: 'ZZ' as never }),
    ).toThrow(PhoneParseError);
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
