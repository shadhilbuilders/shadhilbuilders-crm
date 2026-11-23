// Poster frame for a clip (plan section 6). Always produces a JPEG: the server
// refuses a video without one, and a failed frame grab must never lose a take.
// A real frame when the canvas allows it, otherwise a neutral placeholder, so
// the save path never branches on "no poster".
import { POSTER_MAX_BYTES } from './constants';

const MAX_EDGE = 720;
const QUALITIES = [0.8, 0.6, 0.4] as const;
const PLACEHOLDER_SIZE = { width: 320, height: 180 } as const;
// A mid grey: this is image data baked into a file, not a themed UI colour.
const PLACEHOLDER_FILL = 'rgb(115, 115, 115)';

export interface PosterDeps {
  createCanvas(width: number, height: number): HTMLCanvasElement;
}

export const browserPosterDeps: PosterDeps = {
  createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/** Encode, stepping quality down until it fits the server's poster cap. */
async function encodeWithinCap(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const quality of QUALITIES) {
    const blob = await toJpeg(canvas, quality);
    if (
      blob !== null &&
      blob.type === 'image/jpeg' &&
      blob.size > 0 &&
      blob.size <= POSTER_MAX_BYTES
    ) {
      return blob;
    }
  }
  return null;
}

/** Scale to fit MAX_EDGE, never up. */
export function posterSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { ...PLACEHOLDER_SIZE };
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function frameFrom(video: HTMLVideoElement, deps: PosterDeps): Promise<Blob | null> {
  const { width, height } = posterSize(video.videoWidth, video.videoHeight);
  if (video.videoWidth <= 0) return null;
  const canvas = deps.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return encodeWithinCap(canvas);
}

async function placeholder(deps: PosterDeps): Promise<Blob> {
  const canvas = deps.createCanvas(PLACEHOLDER_SIZE.width, PLACEHOLDER_SIZE.height);
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = PLACEHOLDER_FILL;
    ctx.fillRect(0, 0, PLACEHOLDER_SIZE.width, PLACEHOLDER_SIZE.height);
  }
  const blob = await encodeWithinCap(canvas);
  if (blob === null) throw new Error('Could not encode a poster image');
  return blob;
}

/**
 * The poster for a `video` element that has loaded a frame. A drawing error
 * (tainted canvas, decode failure, no canvas support) falls back to the
 * placeholder; only a browser that cannot encode ANY JPEG rejects, and the caller
 * treats that as a failed save with the poster copy.
 */
export async function makePoster(
  video: HTMLVideoElement | null,
  deps: PosterDeps = browserPosterDeps,
): Promise<Blob> {
  if (video !== null) {
    try {
      const frame = await frameFrom(video, deps);
      if (frame !== null) return frame;
    } catch {
      /* fall through to the placeholder */
    }
  }
  return placeholder(deps);
}
