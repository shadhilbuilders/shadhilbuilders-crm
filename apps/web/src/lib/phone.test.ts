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

  it('returns empty href for masked placeholders (not dialable)', () => {
    expect(telUrl('+919****3210')).toBe('');
    expect(telUrl('+141****2671')).toBe('');
  });

  it('returns empty href for empty input', () => {
    expect(telUrl('')).toBe('');
  });
});

describe('formatPhone', () => {
  it('formats a plain 10-digit Indian number', () => {
    expect(formatPhone('9876500009')).toBe('98765 00009');
  });

  it('formats +91 E164', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
  });

  it('passes unrecognized foreign E164 through unchanged', () => {
    expect(formatPhone('+14155550123')).toBe('+14155550123');
  });

  it('passes masked placeholders through untouched', () => {
    expect(formatPhone('+919****3210')).toBe('+919****3210');
    expect(formatPhone('+141****2671')).toBe('+141****2671');
  });

  it('falls back to raw for unknown shapes', () => {
    expect(formatPhone('not-a-number')).toBe('not-a-number');
  });
});
