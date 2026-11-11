// PhotoLightboxPanel (redesign, 2026-11-09).
// protects= close/prev/next are 44px labelled controls rendered only when they
//           can act, the position reads "N of M", the note + date show, the
//           panel is h-dvh with a bottom safe area, and no percentage appears;
// fails_when= prev shows on the first photo, next on the last, or a control is
//           under 44px; no_claim= swipe/zoom (pointer events need a browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PhotoLightboxPanel } from './photo-lightbox';

const photo: TimelinePhoto = {
  id: 'p1',
  unitId: 'u1',
  phaseId: 'ph1',
  phaseName: 'Plinth',
  mimeType: 'image/jpeg',
  filename: 'p1.jpg',
  caption: 'Beam poured',
  takenAt: '2026-11-03T08:00:00Z',
  stage: 'FOUNDATION',
  createdAt: '2026-11-03T08:00:00Z',
  creatorName: 'Ravi',
  creatorIsPhotoLead: false,
  mediaUrl: '/api/bff/media/p1',
  canMutate: false,
};
const noop = () => undefined;
const render = (over: { onPrevious: (() => void) | null; onNext: (() => void) | null; position?: number }) =>
  renderToStaticMarkup(
    <PhotoLightboxPanel photo={photo} position={over.position ?? 2} total={5} onClose={noop} {...over} />,
  );

describe('PhotoLightboxPanel', () => {
  it('shows position, note, date and phase, in a full-height panel', () => {
    const html = render({ onPrevious: noop, onNext: noop });
    expect(html).toContain('2 of 5');
    expect(html).toContain('Beam poured');
    expect(html).toContain('3 Nov 2026');
    expect(html).toContain('Plinth');
    expect(html).toContain('h-dvh');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).not.toMatch(/\d+\s*%/);
  });

  it('renders prev/next only when they can act; close always', () => {
    const middle = render({ onPrevious: noop, onNext: noop });
    expect(middle).toContain('aria-label="Previous photo"');
    expect(middle).toContain('aria-label="Next photo"');
    const first = render({ onPrevious: null, onNext: noop, position: 1 });
    expect(first).not.toContain('Previous photo');
    const last = render({ onPrevious: noop, onNext: null, position: 5 });
    expect(last).not.toContain('Next photo');
    expect(last).toContain('aria-label="Close photo"');
  });

  it('controls are 44px', () => {
    const html = render({ onPrevious: noop, onNext: noop });
    expect(html.match(/size-11/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
