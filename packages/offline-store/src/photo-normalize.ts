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
 */
export const normalizeToWebP = async (blob: Blob, quality = 0.85): Promise<Blob> => {
  if (!blob.type.startsWith('image/')) {
    throw new Error(`normalizeToWebP: expected image blob, got ${blob.type}`);
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('normalizeToWebP: OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  return await canvas.convertToBlob({ type: 'image/webp', quality });
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
export const normalizeOnIdle = async (blob: Blob, quality = 0.85): Promise<Blob> => {
  const run = () => normalizeToWebP(blob, quality);
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
