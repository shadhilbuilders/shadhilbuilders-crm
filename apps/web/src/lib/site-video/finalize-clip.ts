// Turn a raw recording into a `Clip`: the real poster frame (or the placeholder),
// attached BEFORE the preview, so every clip that reaches the review screen can be
// saved. The video element is injected; the browser one loads the blob, seeks to a
// frame and waits for it, with a timeout so a decoder that never fires cannot hang
// the screen.
import { makePoster } from './poster';
import type { Clip } from './recorder-machine';
import type { RawTake } from './recorder-engine';

export interface FinalizeDeps {
  /** A video element with a decoded frame, or null if it could not be loaded in time. */
  loadFrame(blob: Blob): Promise<HTMLVideoElement | null>;
  makePoster(video: HTMLVideoElement | null): Promise<Blob>;
}

export async function finalizeClip(take: RawTake, deps: FinalizeDeps): Promise<Clip> {
  const video = await deps.loadFrame(take.blob).catch(() => null);
  const poster = await deps.makePoster(video);
  return { blob: take.blob, durationMs: take.durationMs, hasAudio: take.hasAudio, poster };
}

const FRAME_TIMEOUT_MS = 3_000;

export function browserFinalizeDeps(): FinalizeDeps {
  return {
    makePoster: (video) => makePoster(video),
    loadFrame(blob) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        const done = (result: HTMLVideoElement | null) => {
          window.clearTimeout(timer);
          resolve(result);
          // The frame is already drawn by the caller when it resolves; revoke after.
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        };
        const timer = window.setTimeout(() => done(null), FRAME_TIMEOUT_MS);
        video.onloadeddata = () => {
          // A frame slightly in: the very first one is often black.
          video.onseeked = () => done(video);
          video.currentTime = 0.1;
        };
        video.onerror = () => done(null);
        video.src = url;
      });
    },
  };
}
