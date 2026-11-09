/**
 * Client-side image conversion. The plan calls for WebP output of all
 * captured photos so that:
 *   - iOS HEIC captures are normalized to a universal format
 *   - blob size is reduced (~400KB for a 12MP photo, vs 1.5-2MB for HEIC)
 *   - the IDB blob store can be read by any browser (no HEIC decoder)
 *
 * Implementation:
 *   - `normalizeToWebP` runs synchronously on the main thread. Use only
 *     when the caller has confirmed the photo is ready (post-`<input>`
 *     change event, not on each keystroke).
 *   - `normalizeOnIdle` is a wrapper that defers to `requestIdleCallback`
 *     when available, falling back to immediate execution. This is the
 *     recommended path for the lead-form photo capture (4B perf fix):
 *     100-300ms stall on a 4-year-old Android becomes a low-priority
 *     background task that the user doesn't notice.
 *
 * 2026-11-08 (site capture): two additions, both backward compatible.
 *   - `options.maxEdge` downscales the long edge before encoding. Omitted =
 *     today's exact behaviour (the offline lead-form path calls it with two
 *     arguments and must not change).
 *   - `OffscreenCanvas` is used when available and a DOM canvas otherwise.
 *     Safari before 16.4 has no `OffscreenCanvas`, and the previous
 *     implementation threw a ReferenceError there - which on a building site
 *     with an older iPhone meant "the upload button does nothing".
 *
 * THE TRAP, documented because it is invisible until it bites: a browser with
 * no WebP ENCODER silently returns a PNG from `convertToBlob`/`toBlob`. The
 * caller must read `blob.type` and never assume `image/webp`.
 */

/** The pure part: the rendered size for a source box, never upscaling. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  // `<=` keeps an image already at the cap at its exact size (no needless
  // re-encode) and guarantees we never grow a small photo.
  if (maxEdge <= 0 || longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type Canvas2DContext = {
  drawImage: (source: CanvasImageSource, dx: number, dy: number, dw?: number, dh?: number) => void;
};

type OffscreenCanvasLike = {
  width: number;
  height: number;
  getContext: (id: '2d') => Canvas2DContext | null;
  convertToBlob: (opts: { type: string; quality: number }) => Promise<Blob>;
};

type CanvasElementLike = {
  width: number;
  height: number;
  getContext: (id: '2d') => Canvas2DContext | null;
  toBlob: (cb: (blob: Blob | null) => void, type: string, quality: number) => void;
};

function encodeWithDomCanvas(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('normalizeToWebP: no OffscreenCanvas and no document available');
  }
  const canvas = doc.createElement('canvas') as unknown as CanvasElementLike;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('normalizeToWebP: 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('normalizeToWebP: canvas encoding produced no blob'));
          return;
        }
        resolve(blob);
      },
      'image/webp',
      quality,
    );
  });
}

export const normalizeToWebP = async (
  blob: Blob,
  quality = 0.85,
  options?: { maxEdge?: number },
): Promise<Blob> => {
  if (!blob.type.startsWith('image/')) {
    throw new Error(`normalizeToWebP: expected image blob, got ${blob.type}`);
  }
  const bitmap = await createImageBitmap(blob);
  const target =
    options?.maxEdge !== undefined
      ? fitWithin(bitmap.width, bitmap.height, options.maxEdge)
      : { width: bitmap.width, height: bitmap.height };

  const Offscreen = (
    globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvasLike }
  ).OffscreenCanvas;

  if (typeof Offscreen === 'function') {
    const canvas = new Offscreen(target.width, target.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('normalizeToWebP: OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    return await canvas.convertToBlob({ type: 'image/webp', quality });
  }

  // Safari < 16.4 (and jsdom): DOM canvas + toBlob.
  return encodeWithDomCanvas(bitmap, target.width, target.height, quality);
};

/**
 * `normalizeToWebP` deferred to `requestIdleCallback` when available.
 * On browsers without `requestIdleCallback` (older Safari, some test
 * environments), falls back to immediate execution.
 *
 * Returns a promise that resolves with the WebP blob. The caller can
 * show a "Saving..." state during the wait (the `PhotoStatusChip` from
 * the design review uses this exact state).
 */
export const normalizeOnIdle = async (
  blob: Blob,
  quality = 0.85,
  options?: { maxEdge?: number },
): Promise<Blob> => {
  const run = () => normalizeToWebP(blob, quality, options);
  const ric: ((cb: () => void, opts?: { timeout: number }) => number) | undefined = (
    globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof ric !== 'function') {
    return run();
  }
  return new Promise<Blob>((resolve, reject) => {
    ric(
      () => {
        run().then(resolve, reject);
      },
      { timeout: 1500 },
    );
  });
};
