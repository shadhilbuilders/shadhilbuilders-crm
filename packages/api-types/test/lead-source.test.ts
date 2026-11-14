// T-LEAD-SOURCES (2026-11-05): one vocabulary, one normaliser.
//
// The reason this is tested at all: `Lead.source` is matched EXACTLY by the
// manager-assignment engine, so 'facebook' and 'META_AD' are two different
// routing keys. A spelling that slips through unmapped does not error, it just
// sends the lead to whatever the fallback owner is.
import { describe, expect, it } from 'vitest';

import { LEAD_SOURCES, LeadSourceSchema, normalizeLeadSource } from '../src/lead-source';

describe('LEAD_SOURCES', () => {
  it('accepts every canonical token', () => {
    for (const source of LEAD_SOURCES) {
      expect(LeadSourceSchema.safeParse(source).success).toBe(true);
    }
  });
});

describe('normalizeLeadSource', () => {
  it('treats a missing channel as LANDING - what the form has always sent', () => {
    expect(normalizeLeadSource(undefined)).toBe('LANDING');
    expect(normalizeLeadSource(null)).toBe('LANDING');
    expect(normalizeLeadSource('')).toBe('LANDING');
    expect(normalizeLeadSource('   ')).toBe('LANDING');
  });

  it('passes a canonical token through, whatever its case', () => {
    expect(normalizeLeadSource('META_AD')).toBe('META_AD');
    expect(normalizeLeadSource('meta_ad')).toBe('META_AD');
    expect(normalizeLeadSource('  Housing  ')).toBe('HOUSING');
    expect(normalizeLeadSource('99acres')).toBe('99ACRES');
  });

  it('folds Facebook and Instagram onto META_AD - one ad system, one routing rule', () => {
    for (const raw of ['facebook', 'FB', 'facebook.com', 'instagram', 'insta', 'ig', 'meta']) {
      expect(normalizeLeadSource(raw)).toBe('META_AD');
    }
  });

  it('folds the portals, with or without their domain', () => {
    expect(normalizeLeadSource('housing.com')).toBe('HOUSING');
    expect(normalizeLeadSource('Housing.com')).toBe('HOUSING');
    expect(normalizeLeadSource('magicbricks')).toBe('MAGICBRICKS');
    expect(normalizeLeadSource('magicbricks.com')).toBe('MAGICBRICKS');
    expect(normalizeLeadSource('99acres.com')).toBe('99ACRES');
  });

  it('folds the offline channels', () => {
    expect(normalizeLeadSource('walk-in')).toBe('WALK_IN');
    expect(normalizeLeadSource('walk in')).toBe('WALK_IN');
    expect(normalizeLeadSource('walkin')).toBe('WALK_IN');
    expect(normalizeLeadSource('referral')).toBe('REFERRAL');
  });

  it('treats an owned channel by whatever the caller calls it', () => {
    expect(normalizeLeadSource('website')).toBe('WEBSITE');
    expect(normalizeLeadSource('organic')).toBe('WEBSITE');
    expect(normalizeLeadSource('landing-page')).toBe('LANDING');
  });

  it('never rejects: an unknown channel becomes OTHER', () => {
    expect(normalizeLeadSource('some-new-portal-2027')).toBe('OTHER');
    expect(normalizeLeadSource('whatsapp-ad')).toBe('OTHER');
  });

  it('always returns a value the enum accepts', () => {
    for (const raw of [undefined, 'fb', 'housing.com', 'nonsense', ' META ']) {
      expect(LeadSourceSchema.safeParse(normalizeLeadSource(raw)).success).toBe(true);
    }
  });
});
