// Buyer-facing WhatsApp status on a staff row (build-sequence step 8).
//
// protects= a staff row says how the send ended in plain words, an outcome the
// buyer must not be confused by is never invented, and a row with no delivery
// information renders nothing instead of an ambiguous "not sent".
// fails_when= the buyer's own timeline grows our bookkeeping, a null status
// renders a word, or a raw enum reaches the screen.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-progress';

import { SitePhotoCard } from './SitePhotoFeed';

const base: TimelinePhoto = {
  id: 'p1',
  unitId: 'unit-1',
  phaseId: 'phase-b',
  phaseName: 'Phase B',
  mimeType: 'image/jpeg',
  filename: 'site.jpg',
  caption: 'Slab poured',
  takenAt: '2026-11-08T04:12:00.000Z',
  stage: 'STRUCTURE',
  createdAt: '2026-11-08T04:12:00.000Z',
  creatorName: 'Ravi Kumar',
  creatorIsPhotoLead: false,
  mediaUrl: '/api/bff/media/org/x/site.jpg',
  canMutate: true,
};

const NOW = new Date('2026-11-09T04:12:00.000Z');
const card = (over: Partial<TimelinePhoto>) =>
  renderToStaticMarkup(
    <SitePhotoCard
      photo={{ ...base, ...over }}
      index={0}
      unitLabel="B-101"
      now={NOW}
      onOpen={() => undefined}
    />,
  );

describe('staff delivery status', () => {
  it('says a sent update reached the buyer', () => {
    expect(card({ whatsappStatus: 'SENT' })).toContain('Sent to buyer');
  });

  it('explains a closed window without sounding like an error', () => {
    const html = card({ whatsappStatus: 'SKIPPED_WINDOW' });
    expect(html).toContain('Not sent: buyer window closed');
  });

  it('says a unit with no buyer was skipped, not that delivery failed', () => {
    expect(card({ whatsappStatus: 'SKIPPED_NO_BUYER' })).toContain('no buyer on this unit');
  });

  it('names each failure outcome in words, never the enum', () => {
    expect(card({ whatsappStatus: 'SKIPPED_NO_TEMPLATE' })).toContain('no approved template');
    const failed = card({ whatsappStatus: 'FAILED' });
    expect(failed).toContain('Not sent: delivery failed');
    expect(failed).not.toContain('FAILED</span>');
  });

  it('says a switched-off leg was a choice, not a template gap or a failure', () => {
    // SITE_UPDATE_WHATSAPP=off. The words must not blame a missing template or a
    // failed send, because neither happened; the operator stopped it.
    const html = card({ whatsappStatus: 'SKIPPED_DISABLED' });
    expect(html).toContain('Not sent: buyer updates switched off');
    expect(html).not.toContain('no approved template');
    expect(html).not.toContain('delivery failed');
  });

  it('renders nothing when there is no delivery information', () => {
    for (const status of [null, undefined]) {
      const html = card({ whatsappStatus: status });
      expect(html).not.toContain('progress-whatsapp');
    }
  });
});
