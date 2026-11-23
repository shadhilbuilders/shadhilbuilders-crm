// Video rows in the site feed and lightbox (plan section 7).
//
// protects= a video tile shows its poster with a play glyph and duration, is ONE
// button with a "Video, N seconds" name (no <video> inside the feed), photos are
// untouched, and the lightbox switches to a controls-on, no-autoplay,
// preload-none player only for a playable video, with a download fallback when
// the browser cannot decode it.
// fails_when= a <video> appears in the feed, a photo grows a play glyph, the
// player autoplays or preloads, a purged clip renders a dead player, or the
// accessible name loses the duration.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { TimelinePhoto } from '@/hooks/queries/customer-progress';
import { isPlayableVideo } from '@/lib/site-video/is-video';

import { SitePhotoCard } from './SitePhotoFeed';
import { SitePhotoViewerPanel } from './SitePhotoViewer';
import { SiteVideoPlayer } from './SiteVideoPlayer';

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
  mediaUrl: '/api/bff/media/org/x/poster.jpg',
  canMutate: false,
};
const video: TimelinePhoto = {
  ...base,
  id: 'v1',
  kind: 'VIDEO',
  mimeType: 'video/mp4',
  filename: 'clip.mp4',
  videoUrl: '/api/bff/media/org/x/clip.mp4',
  durationMs: 24_000,
  hasAudio: false,
};
const NOW = new Date('2026-11-09T04:12:00.000Z');

const card = (photo: TimelinePhoto) =>
  renderToStaticMarkup(
    <SitePhotoCard photo={photo} index={0} unitLabel="B-101" now={NOW} onOpen={() => undefined} />,
  );
const panel = (photo: TimelinePhoto) =>
  renderToStaticMarkup(
    <SitePhotoViewerPanel
      photo={photo}
      unitNumber="B-101"
      onClose={() => undefined}
      hasPrevious={false}
      hasNext={false}
      onPrevious={() => undefined}
      onNext={() => undefined}
    />,
  );

describe('isPlayableVideo', () => {
  it('needs the VIDEO kind AND a clip URL', () => {
    expect(isPlayableVideo(video)).toBe(true);
    expect(isPlayableVideo(base)).toBe(false);
    expect(isPlayableVideo({ ...video, videoUrl: null })).toBe(false);
    expect(isPlayableVideo({ ...video, videoUrl: '' })).toBe(false);
  });
});

describe('feed tile', () => {
  it('shows the poster, a play glyph and the duration, named "Video, 24 seconds"', () => {
    const html = card(video);
    expect(html).toContain('src="/api/bff/media/org/x/poster.jpg"');
    expect(html).toContain('data-qa="video-tile-badge"');
    expect(html).toContain('0:24');
    expect(html.toLowerCase()).toContain('video, 24 seconds');
    expect(html).toContain('aria-hidden="true"');
  });

  it('is one button and never nests a <video> element in the feed', () => {
    const html = card(video);
    expect(html).not.toContain('<video');
    expect(html.match(/data-qa="site-photo-open"/g)).toHaveLength(1);
  });

  it('leaves a photo exactly as it was', () => {
    const html = card(base);
    expect(html).not.toContain('video-tile-badge');
    expect(html).toContain('Open the photo from');
  });
});

describe('lightbox', () => {
  it('plays a video with controls, no autoplay, preload none and the poster', () => {
    const html = panel(video);
    expect(html).toContain('data-qa="video-player"');
    expect(html).toContain('src="/api/bff/media/org/x/clip.mp4"');
    expect(html).toContain('poster="/api/bff/media/org/x/poster.jpg"');
    expect(html).toContain('controls');
    expect(html).toContain('preload="none"');
    expect(html).toMatch(/playsinline/i);
    expect(html).not.toContain('autoplay');
    expect(html).toContain('aria-label="Close video"');
  });

  it('shows a photo as an image, and a clip with no URL as its poster, never a dead player', () => {
    expect(panel(base)).not.toContain('<video');
    const purged = panel({ ...video, videoUrl: null });
    expect(purged).not.toContain('<video');
    expect(purged).toContain('aria-label="Close photo"');
  });
});

describe('SiteVideoPlayer fallback', () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('swaps to one sentence and a download link when the browser cannot decode', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <SiteVideoPlayer
          src="/clip.mp4"
          poster="/poster.jpg"
          durationMs={24_000}
          filename="clip.mp4"
        />,
      );
    });
    const el = container.querySelector('video') as HTMLVideoElement;
    expect(el).not.toBeNull();
    await act(async () => {
      el.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('[data-qa="video-unplayable"]')?.textContent).toMatch(
      /can.t play in your browser/i,
    );
    expect(container.querySelector('[data-qa="video-download"]')?.getAttribute('href')).toBe(
      '/clip.mp4',
    );
  });
});
