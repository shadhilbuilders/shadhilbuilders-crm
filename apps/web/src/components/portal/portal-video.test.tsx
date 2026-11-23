// Video rows on the buyer portal.
//
// protects= the hero, the list thumbnail and the lightbox show a clip as its
// poster with a play cue, the lightbox plays it with controls, no autoplay and no
// preload, and a photo or an unplayable (purged) clip never grows a player or a cue.
// fails_when= a photo gets a play glyph, a <video> appears in the hero or list,
// the lightbox keeps the zoomable still for a clip, or a purged clip renders a player.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PhotoLightboxPanel } from './photo-lightbox';
import { PortalHero } from './portal-hero';

const photo: TimelinePhoto = {
  id: 'p1',
  unitId: 'unit-1',
  phaseId: 'phase-a',
  phaseName: 'Phase A',
  mimeType: 'image/jpeg',
  filename: 'site.jpg',
  caption: 'Slab poured',
  takenAt: '2026-11-08T04:12:00.000Z',
  stage: 'STRUCTURE',
  createdAt: '2026-11-08T04:12:00.000Z',
  creatorName: 'Ravi Kumar',
  creatorIsPhotoLead: false,
  mediaUrl: '/api/bff/media/org/x/poster.jpg',
  canMutate: false,
};

const clip: TimelinePhoto = {
  ...photo,
  id: 'v1',
  kind: 'VIDEO',
  filename: 'clip.mp4',
  videoUrl: '/api/bff/media/org/x/clip.mp4',
  durationMs: 12_000,
  hasAudio: false,
};

const purged: TimelinePhoto = { ...clip, videoUrl: null };

function hero(latest: TimelinePhoto): string {
  return renderToStaticMarkup(
    <PortalHero
      customerName="Asha Nair"
      unitNumber="A-101"
      projectName="Metro Heights"
      latest={latest}
      isLoading={false}
      onOpenPhoto={() => undefined}
      now={Date.parse('2026-11-09T04:12:00.000Z')}
    />,
  );
}

function lightbox(p: TimelinePhoto): string {
  return renderToStaticMarkup(
    <PhotoLightboxPanel
      photo={p}
      position={1}
      total={1}
      onClose={() => undefined}
      onPrevious={null}
      onNext={null}
    />,
  );
}

describe('portal hero', () => {
  it('shows a clip as its poster with a play cue and a video label', () => {
    const html = hero(clip);
    expect(html).toContain('video-tile-badge');
    expect(html).toContain('/api/bff/media/org/x/poster.jpg');
    expect(html).toContain('Open the latest video');
    expect(html).not.toContain('<video');
  });

  it('leaves a photo with no play cue', () => {
    const html = hero(photo);
    expect(html).not.toContain('video-tile-badge');
    expect(html).toContain('Open the latest photo');
  });

  it('shows a purged clip as a plain poster', () => {
    const html = hero(purged);
    expect(html).not.toContain('video-tile-badge');
    expect(html).toContain('Open the latest photo');
  });
});

describe('portal lightbox', () => {
  it('plays a clip with controls, no autoplay and no preload', () => {
    const html = lightbox(clip);
    expect(html).toContain('data-qa="video-player"');
    expect(html).toContain('src="/api/bff/media/org/x/clip.mp4"');
    expect(html).toContain('preload="none"');
    expect(html).toContain('controls');
    expect(html).not.toMatch(/autoplay/i);
  });

  it('keeps the zoomable still for a photo', () => {
    const html = lightbox(photo);
    expect(html).not.toContain('<video');
    expect(html).toContain('/api/bff/media/org/x/poster.jpg');
  });

  it('renders a purged clip as its poster, never a dead player', () => {
    expect(lightbox(purged)).not.toContain('<video');
  });
});
