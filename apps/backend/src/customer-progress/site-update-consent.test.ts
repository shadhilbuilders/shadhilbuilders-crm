// Marketing consent for the site-update templates (2026-11-23).
//
// protects= a MARKETING template is only sent to a buyer who opted in, the
// newest ledger row wins (so a later opt-out beats an earlier opt-in), and a
// lead with no row is NOT treated as consenting.
// fails_when= "never asked" reads as yes - the population most likely to
// complain - or the template path sends regardless of consent while inside the
// 24h window (which is freeform and needs none).
import { describe, expect, it, vi } from 'vitest';

import { marketingConsent, newestMarketingConsentRow } from './site-update-consent';

const AT = new Date('2026-11-23T10:00:00.000Z');

// The full row, because the ledger reader now carries the provenance the panel
// shows and the dialog prefills; the answer tests only care about `granted`.
const txWith = (row: { granted: boolean } | null) => ({
  consent: {
    findFirst: vi.fn(async () =>
      row === null ? null : { ...row, grantedAt: AT, source: 'call_verbal', note: null },
    ),
  },
});

describe('marketingConsent', () => {
  it('reads the newest MARKETING row', async () => {
    const tx = txWith({ granted: true });
    expect(await marketingConsent(tx, 'lead-1')).toBe('granted');
    expect(tx.consent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leadId: 'lead-1', consentType: 'MARKETING' },
        // grantedAt desc, then createdAt: the ledger's newest answer decides.
        orderBy: [{ grantedAt: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  });

  it('a later opt-out wins', async () => {
    expect(await marketingConsent(txWith({ granted: false }), 'lead-1')).toBe('denied');
  });

  it('is NOT consent when the lead has no row at all', async () => {
    // The distinction that matters: an old lead with no consent record must not
    // be mailed as if it had opted in.
    expect(await marketingConsent(txWith(null), 'lead-1')).toBe('never-asked');
  });
});

describe('newestMarketingConsentRow', () => {
  it('carries the moment the answer was given, so the UI can say when', async () => {
    // The lead-detail panel and the send decision must read the ledger through
    // this one function; a second, hand-rolled ordering is how "granted"
    // survives an opt-out.
    const tx = txWith({ granted: true });
    expect(await newestMarketingConsentRow(tx, 'lead-1')).toEqual({
      granted: true,
      grantedAt: AT,
      source: 'call_verbal',
      note: null,
    });
    // Provenance rides along: the panel names the source and the dialog
    // prefills the note, so neither can be left out of the select.
    expect(tx.consent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { granted: true, grantedAt: true, source: true, note: true },
      }),
    );
    expect(tx.consent.findFirst).toHaveBeenCalledTimes(1);
  });

  it('is null, not a default row, when nobody has asked', async () => {
    expect(await newestMarketingConsentRow(txWith(null), 'lead-1')).toBeNull();
  });
});
