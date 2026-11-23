// The WhatsApp greeting slot (build-sequence step 8, owner decision 2026-11-23).
//
// protects= a customer is greeted by their FIRST name, and anything that is not
// plainly a name becomes the neutral "there" instead of being printed at them.
// fails_when= "Sir", a phone number, an email or an initial reaches the message,
// or an empty/missing name produces an empty template parameter (Meta rejects a
// template whose parameter count does not match, and an empty value is not an
// omission).
import { describe, expect, it } from 'vitest';

import { greetingName, NEUTRAL_GREETING } from './site-update-greeting';

describe('greetingName', () => {
  it('takes the first name and drops the rest', () => {
    expect(greetingName('Asha Nair')).toBe('Asha');
    expect(greetingName('  Ravi   Kumar  ')).toBe('Ravi');
  });

  it('keeps the stored capitalisation, because Meta prints it verbatim', () => {
    expect(greetingName('asha')).toBe('asha');
  });

  it('falls back for titles and placeholders', () => {
    for (const raw of ['Sir', 'Madam', "Ma'am", 'Customer', 'Client', 'Test', 'Unknown', 'Mr.']) {
      expect(greetingName(raw)).toBe(NEUTRAL_GREETING);
    }
  });

  it('falls back when the field holds something that is not a name', () => {
    expect(greetingName('9876543210')).toBe(NEUTRAL_GREETING);
    expect(greetingName('Flat 12')).toBe(NEUTRAL_GREETING);
    expect(greetingName('asha@example.com')).toBe(NEUTRAL_GREETING);
    expect(greetingName('A. K.')).toBe(NEUTRAL_GREETING);
    expect(greetingName('A')).toBe(NEUTRAL_GREETING);
  });

  it('never returns an empty string, which Meta would reject', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(greetingName(raw)).toBe(NEUTRAL_GREETING);
    }
  });
});
