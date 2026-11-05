// T-LEAD-FACTS (2026-11-05): evidence pricing. Pure, no DB.
import { describe, expect, it } from 'vitest';

import {
  BAND_FLOOR,
  canonicalValue,
  scoreEvidence,
  sameValue,
  type Evidence,
} from './lead-evidence';

const evidence = (
  kind: Evidence['kind'],
  detail = 'probe',
): Evidence => ({ kind, detail });

describe('scoreEvidence', () => {
  it('stores nothing without evidence', () => {
    const scored = scoreEvidence([]);
    expect(scored.score).toBe(0);
    expect(scored.band).toBeNull();
    expect(scored.rationale).toBe('No evidence.');
  });

  it('prices a WhatsApp profile name as POSSIBLE only - it is what they typed into their own phone', () => {
    const scored = scoreEvidence([evidence('whatsapp.profile-name')]);
    expect(scored.band).toBe('POSSIBLE');
    expect(scored.hasPrimary).toBe(false);
    expect(scored.rationale).toMatch(/WhatsApp profile name/);
    expect(scored.rationale).toMatch(/nothing that identifies them directly/);
  });

  it('two weak observations multiply, they do not add', () => {
    const scored = scoreEvidence([
      evidence('whatsapp.profile-name'), // 0.40
      evidence('whatsapp.message-mentions'), // 0.45
    ]);
    // 1 - (0.6 * 0.55) = 0.67, not 0.85.
    expect(scored.score).toBeCloseTo(0.67, 3);
    expect(scored.band).toBe('PROBABLE');
  });

  it('a primary source can carry a fact alone', () => {
    const scored = scoreEvidence([evidence('lead.reply-from-number')]);
    expect(scored.score).toBeCloseTo(0.9, 3);
    expect(scored.band).toBe('VERIFIED');
    expect(scored.hasPrimary).toBe(true);
  });

  it('several weak sources can out-score the band floor but never reach VERIFIED without a primary', () => {
    const scored = scoreEvidence([
      evidence('call.note-mentions'), // 0.55
      evidence('whatsapp.message-mentions'), // 0.45
      evidence('whatsapp.profile-name'), // 0.40
    ]);
    expect(scored.score).toBeGreaterThanOrEqual(BAND_FLOOR.VERIFIED);
    expect(scored.hasPrimary).toBe(false);
    expect(scored.band).toBe('PROBABLE');
  });

  it('a contradiction holds the fact instead of shading the score', () => {
    const scored = scoreEvidence([
      evidence('lead.reply-from-number'),
      evidence('contradiction', 'the enquiry form names a different person'),
    ]);
    expect(scored.band).toBeNull();
    expect(scored.rationale).toBe(
      'Held: the enquiry form names a different person.',
    );
  });

  it('never claims certainty', () => {
    const scored = scoreEvidence([
      evidence('lead.reply-from-number'),
      evidence('enquiry.form-email'),
      evidence('booking.contact-match'),
      evidence('site-visit.signin'),
    ]);
    expect(scored.score).toBeLessThan(1);
    expect(scored.band).toBe('VERIFIED');
  });
});

describe('canonicalValue / sameValue', () => {
  it('ignores case and repeated whitespace', () => {
    expect(sameValue('Ramesh  Kumar', ' ramesh kumar ')).toBe(true);
  });

  it('compares a URL as an address, not as a string', () => {
    expect(
      sameValue('https://www.LinkedIn.com/in/ramesh/', 'linkedin.com/in/ramesh'),
    ).toBe(true);
    expect(
      sameValue('https://x.com/ramesh?ref=wa', 'https://twitter.com/ramesh/'),
    ).toBe(true);
  });

  it('keeps a different path different', () => {
    expect(sameValue('linkedin.com/in/ramesh', 'linkedin.com/in/rameshk')).toBe(
      false,
    );
    expect(canonicalValue('  Lead  ')).toBe('lead');
  });
});
