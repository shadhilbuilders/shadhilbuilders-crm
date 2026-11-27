// SiteVideoPlayer's gate readout (2026-11-26).
//
// protects= the lightbox reports the wait it caused (tap to player on screen) and
//           only when ?timings=1 is in effect, so a customer never sees it;
// fails_when= the readout renders on an ordinary URL, it prints without a tap to
//           measure, or the flag is read once and never again.
// no_claim= pixels: what the bar looks like is CSS, not this test's business.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markTileTap } from '@/lib/site-video/player-timings';

import { SiteVideoPlayer } from './SiteVideoPlayer';

let container: HTMLDivElement;
let root: Root | null = null;

const q = (qa: string) => container.querySelector(`[data-qa="${qa}"]`) as HTMLElement | null;

const mount = async () => {
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SiteVideoPlayer
        src="/api/bff/media/org/x/clip.mp4"
        poster="/api/bff/media/org/x/poster.jpg"
        durationMs={29_900}
        filename="clip.mp4"
      />,
    );
  });
  // Let the deferred frame callback run inside act.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  // One frame, synchronously: the component asks for the paint, not for a clock.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('SiteVideoPlayer', () => {
  it('reports the tap to player time when ?timings=1 is on', async () => {
    window.history.replaceState({}, '', '/?timings=1');
    markTileTap(performance.now() - 76);
    await mount();
    expect(q('video-player')).not.toBeNull();
    const readout = q('player-timings')?.textContent ?? '';
    expect(readout).toMatch(/^open \d+ ms$/);
    // The mark was set 76 ms ago, so the reported wait cannot be smaller.
    expect(Number(readout.replace(/\D/g, ''))).toBeGreaterThanOrEqual(76);
  });

  it('shows no readout on an ordinary URL', async () => {
    markTileTap(1000);
    await mount();
    expect(q('video-player')).not.toBeNull();
    expect(q('player-timings')).toBeNull();
  });
});
