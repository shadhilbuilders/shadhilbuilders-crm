// PhoneNumberInput - digit-only sanitizer contract.
//
// The input behavior (sanitizing keystrokes to digits-only, capping at
// `max`) is client state verified in-browser; renderToStaticMarkup pins
// the initial input contract (type=tel, inputMode=numeric, maxLength,
// data-qa). The pure `digitsOnly` helper is unit-tested directly - that's
// where the actual stripping/capping logic lives and is the cheapest,
// highest-signal coverage.
//
// The default `max` is 10: the user types a bare 10-digit Indian mobile
// (no +91) and PhoneSchema prepends `91` at the persistence layer.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { digitsOnly, PhoneNumberInput } from './PhoneNumberInput';

describe('digitsOnly(value, max)', () => {
  it('strips all non-digits', () => {
    expect(digitsOnly('+91 98765 43210', 12)).toBe('919876543210');
    expect(digitsOnly('abc123!@#-', 12)).toBe('123');
  });
  it('caps at the max length', () => {
    expect(digitsOnly('987654321098765', 10)).toBe('9876543210');
    expect(digitsOnly('9876543210', 10)).toBe('9876543210');
  });
  it('handles already-short input unchanged', () => {
    expect(digitsOnly('91', 10)).toBe('91');
  });
  it('returns empty string for no digits', () => {
    expect(digitsOnly('---( )', 10)).toBe('');
  });
});

describe('PhoneNumberInput (rendered input contract)', () => {
  it('renders a tel input with numeric mode, maxLength, and data-qa', () => {
    const html = renderToStaticMarkup(
      <PhoneNumberInput value="9876543210" data-qa="lead-phone" placeholder="9876543210" />,
    );
    expect(html).toContain('type="tel"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('maxLength="10"');
    expect(html).toContain('data-qa="lead-phone"');
    expect(html).toContain('value="9876543210"');
    expect(html).toContain('placeholder="9876543210"');
  });
  it('defaults max to 10 (10-digit mobile, 91 prepended at DB level)', () => {
    const html = renderToStaticMarkup(<PhoneNumberInput value="" />);
    expect(html).toContain('maxLength="10"');
  });
  it('honors an explicit max override', () => {
    const html = renderToStaticMarkup(<PhoneNumberInput value="" max={12} />);
    expect(html).toContain('maxLength="12"');
  });
});
