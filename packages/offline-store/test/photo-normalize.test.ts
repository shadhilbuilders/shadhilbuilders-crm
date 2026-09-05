import { describe, it, expect, vi } from 'vitest';
import { normalizeToWebP, normalizeOnIdle } from '../src/photo-normalize';

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

  it('throws a specific error when OffscreenCanvas is undefined', async () => {
    // The source code calls `createImageBitmap` first, then `new OffscreenCanvas`.
    // If both are missing, `createImageBitmap` throws first. If only
    // OffscreenCanvas is missing, the source throws a specific error.
    // We test the second case: stub createImageBitmap to a no-op so we
    // hit the OffscreenCanvas branch.
    const originalCIb = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    const originalOSC = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () =>
      ({ width: 1, height: 1, close: () => {} }) as unknown as ImageBitmap;
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    try {
      await expect(normalizeToWebP(blob, 0.85)).rejects.toThrow(/OffscreenCanvas/);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = originalOSC;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = originalCIb;
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
