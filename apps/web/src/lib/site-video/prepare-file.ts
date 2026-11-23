// Validate and prepare a video chosen from the gallery (plan section 6, picker).
//
// The recorder cannot be trusted to produce a bad file; a gallery can. The same
// three rules the server enforces are checked here FIRST so the engineer gets a
// sentence now instead of after a 13 MB upload: it is an MP4 (not QuickTime or
// WebM), it fits the size cap, and it is no longer than 45 seconds. The server
// still checks all three again.
import { ApiError } from '@/apis/client';

import { MAX_VIDEO_BYTES, MAX_VIDEO_MS, MIN_VIDEO_MS } from './constants';
import { CONTAINER_UNSUPPORTED_ERROR } from './errors';
import type { Clip } from './recorder-machine';

/** Brands the server accepts as `video/mp4` (mirrors storage/sniff-mime.ts). */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'msdh',
  'M4V ',
  'M4VH',
  'M4VP',
  '3gp4',
  '3gp5',
  '3gp6',
  '3gp7',
  '3ge6',
  '3ge7',
  '3gg6',
  '3g2a',
]);

const fail = (code: string, message: string): ApiError =>
  new ApiError(message, 400, code, undefined, false);

export interface PrepareDeps {
  /** First bytes of the file, enough for the ftyp box. */
  head(file: Blob): Promise<Uint8Array>;
  /** Duration in ms and a decoded frame element, or null duration if it cannot be read. */
  probe(file: Blob): Promise<{ durationMs: number | null; video: HTMLVideoElement | null }>;
  makePoster(video: HTMLVideoElement | null): Promise<Blob>;
}

export function brandOf(head: Uint8Array): string | null {
  if (head.length < 12) return null;
  const text = (from: number) => String.fromCharCode(...head.subarray(from, from + 4));
  return text(4) === 'ftyp' ? text(8) : null;
}

export async function prepareVideoFile(file: File, deps: PrepareDeps): Promise<Clip> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw fail('VIDEO_TOO_LARGE', 'That video is too large.');
  }
  const brand = brandOf(await deps.head(file.slice(0, 64)));
  if (brand === null || !MP4_BRANDS.has(brand)) {
    // QuickTime ('qt  ') from an iPhone library is refused on purpose: Meta will not take it.
    throw fail('VIDEO_CONTAINER_UNSUPPORTED', CONTAINER_UNSUPPORTED_ERROR);
  }
  const { durationMs, video } = await deps.probe(file);
  if (durationMs === null) {
    throw fail('VIDEO_CONTAINER_UNSUPPORTED', CONTAINER_UNSUPPORTED_ERROR);
  }
  if (durationMs > MAX_VIDEO_MS) throw fail('VIDEO_TOO_LONG', 'That clip is too long.');
  if (durationMs < MIN_VIDEO_MS) throw fail('VIDEO_TOO_LONG', 'That clip is too short.');
  const poster = await deps.makePoster(video);
  // `hasAudio` is not knowable from a file in the browser without decoding it;
  // false is the honest answer and the server does not use it for anything unsafe.
  return { blob: file, durationMs, hasAudio: false, poster };
}

export function browserPrepareDeps(makePoster: PrepareDeps['makePoster']): PrepareDeps {
  return {
    head: async (file) => new Uint8Array(await file.arrayBuffer()),
    makePoster,
    probe(file) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        const done = (durationMs: number | null, el: HTMLVideoElement | null) => {
          window.clearTimeout(timer);
          resolve({ durationMs, video: el });
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        };
        const timer = window.setTimeout(() => done(null, null), 5_000);
        video.onerror = () => done(null, null);
        video.onloadeddata = () => {
          const ms = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
          video.onseeked = () => done(ms, video);
          video.currentTime = Math.min(0.1, video.duration || 0.1);
        };
        video.src = url;
      });
    },
  };
}
