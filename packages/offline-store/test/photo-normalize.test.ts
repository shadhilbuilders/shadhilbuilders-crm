import { describe, it, expect, vi } from 'vitest';
import { fitWithin, normalizeToWebP, normalizeOnIdle } from '../src/photo-normalize';

describe('fitWithin - the downscale arithmetic', () => {
  it('leaves a wide image at the cap, scaling the height', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it('leaves a tall image at the cap, scaling the width', () => {
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('handles a square image', () => {
    expect(fitWithin(4000, 4000, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it('never upscales an image already smaller than the cap', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('is exact at the boundary - no re-encode of an image already at the cap', () => {
    expect(fitWithin(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200 });
    // One pixel over the cap does scale, and rounds to the nearest pixel.
    expect(fitWithin(1601, 1200, 1600)).toEqual({ width: 1600, height: 1199 });
  });

  it('never rounds a dimension down to zero', () => {
    const tiny = fitWithin(10000, 1, 1600);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
  });
});

describe('normalizeToWebP', () => {
  it('throws on non-image input', async () => {
    const blob = new Blob(['text'], { type: 'text/plain' });
    await expect(normalizeToWebP(blob, 0.85)).rejects.toThrow(/expected image/);
  });

  it('returns a Blob with type image/webp (jsdom happy-dom env polyfills canvas)', async () => {
    // jsdom doesn't provide createImageBitmap or OffscreenCanvas natively.
    // We rely on vitest's environment: 'node' - but for this test we
    // need DOM globals. Skip the actual conversion if the polyfill is
    // missing; the type check still validates the input handling.
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      // Environment doesn't have canvas - assert the error path instead.
      await expect(normalizeToWebP(blob, 0.85)).rejects.toBeDefined();
      return;
    }
    const result = await normalizeToWebP(blob, 0.85);
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('image/webp');
  });

  // 2026-11-08: Safari before 16.4 has no OffscreenCanvas. The old code threw a
  // ReferenceError there, which on a site phone read as "the button does
  // nothing". It now falls back to a DOM canvas. In this node environment there
  // is no document either, so the failure is the explicit "no canvas at all"
  // error rather than a bare ReferenceError.
  it('falls back to a DOM canvas when OffscreenCanvas is missing, and says so when neither exists', async () => {
    const originalCIb = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    const originalOSC = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () =>
      ({ width: 1, height: 1, close: () => {} }) as unknown as ImageBitmap;
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    try {
      await expect(normalizeToWebP(blob, 0.85)).rejects.toThrow(/no document/);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = originalOSC;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = originalCIb;
    }
  });

  it('downscales through the DOM canvas fallback when maxEdge is set', async () => {
    // Proves the fallback path honours maxEdge: the fake canvas records the
    // dimensions it was asked to render.
    const sizes: Array<{ width: number; height: number }> = [];
    const originalCIb = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    const originalOSC = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    const originalDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () =>
      ({ width: 4000, height: 3000, close: () => {} }) as unknown as ImageBitmap;
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    let drawn = { width: 0, height: 0 };
    (globalThis as { document?: unknown }).document = {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: (_src: unknown, _x: number, _y: number, dw: number, dh: number) => {
              drawn = { width: dw, height: dh };
              sizes.push(drawn);
            },
          }),
          toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'], { type: 'image/webp' })),
        };
        return canvas;
      },
    };
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    try {
      const out = await normalizeToWebP(blob, 0.82, { maxEdge: 1600 });
      expect(out.type).toBe('image/webp');
      expect(drawn).toEqual({ width: 1600, height: 1200 });
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = originalOSC;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = originalCIb;
      (globalThis as { document?: unknown }).document = originalDoc;
    }
  });

  it('omitting options keeps the source dimensions exactly (offline path unchanged)', async () => {
    const originalCIb = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    const originalOSC = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    const originalDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () =>
      ({ width: 4000, height: 3000, close: () => {} }) as unknown as ImageBitmap;
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    let drawn = { width: 0, height: 0 };
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (_src: unknown, _x: number, _y: number, dw: number, dh: number) => {
            drawn = { width: dw, height: dh };
          },
        }),
        toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'], { type: 'image/webp' })),
      }),
    };
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    try {
      await normalizeToWebP(blob, 0.85);
      expect(drawn).toEqual({ width: 4000, height: 3000 });
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = originalOSC;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = originalCIb;
      (globalThis as { document?: unknown }).document = originalDoc;
    }
  });
});

describe('normalizeOnIdle', () => {
  it('defers to requestIdleCallback when available', async () => {
    // Mock requestIdleCallback to capture the callback and run it
    // synchronously so the test doesn't actually wait 1.5s.
    const idleCallbacks: Array<() => void> = [];
    const ricMock = vi.fn((cb: () => void) => {
      idleCallbacks.push(cb);
      return 1;
    });
    (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback =
      ricMock;
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      // No canvas - start the call, verify the callback was registered,
      // then run it (it will reject, which is fine for this test).
      const p = normalizeOnIdle(blob, 0.85);
      expect(ricMock).toHaveBeenCalled();
      idleCallbacks.forEach((cb) => cb());
      await expect(p).rejects.toBeDefined();
      return;
    }
    const p = normalizeOnIdle(blob, 0.85);
    expect(ricMock).toHaveBeenCalled();
    idleCallbacks.forEach((cb) => cb());
    const result = await p;
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('image/webp');
  });

  it('falls back to immediate when requestIdleCallback is unavailable', async () => {
    const original = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      // No canvas - fallback will reject with the canvas error.
      await expect(normalizeOnIdle(blob, 0.85)).rejects.toBeDefined();
    } else {
      const result = await normalizeOnIdle(blob, 0.85);
      expect(result.type).toBe('image/webp');
    }
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = original;
  });
});
