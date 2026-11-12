// prepareProgressPhoto (2026-11-08): converting at capture time is the whole
// reason a phone HEIC upload works at all.
//
// protects= the conversion result's REAL type decides the upload's mimeType and
//           filename, every failure is a typed error with its own sentence, and
//           nothing falls back to uploading the original bytes;
// fails_when= a HEIC name is kept over WebP bytes, a PNG-returning browser is
//           uploaded as "webp", an oversized conversion is sent anyway, or a
//           decode failure degrades into a silent original-bytes upload;
// no_claim= the actual decode happens in a real browser's image pipeline; here
//           `normalizeToWebP` is mocked, so a green run says the mapping and
//           the error taxonomy are right - not that the encoder exists.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  normalizeToWebP: vi.fn(),
}));

vi.mock('@shadhil/offline-store', () => ({
  normalizeToWebP: mocks.normalizeToWebP,
}));

import {
  extensionForMime,
  filenameForMime,
  isServerMime,
  MAX_EDGE,
  PREPARE_ERROR_MESSAGE,
  prepareProgressPhoto,
  prepareErrorMessage,
  PreparePhotoError,
  WEBP_QUALITY,
} from './photo-prep';

/** A file whose bytes we never actually decode (normalizeToWebP is mocked). */
function fileOf(name: string, type = 'image/heic', size = 4_000_000): File {
  return new File([new Uint8Array(size)], name, {
    type,
    lastModified: Date.UTC(2026, 10, 6, 4, 30),
  });
}

function webpBlob(size = 300_000): Blob {
  return new Blob([new Uint8Array(size)], { type: 'image/webp' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.normalizeToWebP.mockResolvedValue(webpBlob());
  // jsdom has no createImageBitmap; the helper is best-effort and must not make
  // a good conversion fail.
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});

describe('extensionForMime / isServerMime', () => {
  it('maps the server allowlist to the matching extension', () => {
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/heic')).toBeNull();
  });

  it('accepts exactly the three server types', () => {
    expect(isServerMime('image/webp')).toBe(true);
    expect(isServerMime('image/jpeg')).toBe(true);
    expect(isServerMime('image/png')).toBe(true);
    expect(isServerMime('image/heic')).toBe(false);
    expect(isServerMime('image/avif')).toBe(false);
    expect(isServerMime('')).toBe(false);
  });
});

describe('filenameForMime', () => {
  it('kills the HEIC-name-over-WebP-bytes mismatch', () => {
    expect(filenameForMime('IMG_2676.HEIC', 'image/webp')).toBe('IMG_2676.webp');
  });

  it('handles names with no extension and multi-dot names', () => {
    expect(filenameForMime('screenshot', 'image/webp')).toBe('screenshot.webp');
    expect(filenameForMime('site.photo.today.png', 'image/webp')).toBe('site.photo.today.webp');
  });

  it('falls back to a real stem rather than producing ".webp"', () => {
    expect(filenameForMime('.hidden', 'image/webp')).toBe('hidden.webp');
    expect(filenameForMime('', 'image/webp')).toBe('site-photo.webp');
  });
});

describe('prepareProgressPhoto', () => {
  it('converts at the documented size and quality', async () => {
    await prepareProgressPhoto(fileOf('slab.jpg', 'image/jpeg', 200_000), { source: 'camera' });
    expect(mocks.normalizeToWebP).toHaveBeenCalledWith(expect.anything(), WEBP_QUALITY, {
      maxEdge: MAX_EDGE,
    });
  });

  it('takes the mimeType and filename from the RESULT, not the input', async () => {
    const prepared = await prepareProgressPhoto(fileOf('IMG_2676.HEIC'), { source: 'gallery' });
    expect(prepared.mimeType).toBe('image/webp');
    expect(prepared.filename).toBe('IMG_2676.webp');
    expect(prepared.byteLength).toBe(300_000);
    expect(prepared.source).toBe('gallery');
  });

  it('keeps takenAt as the file lastModified with an offset', async () => {
    const prepared = await prepareProgressPhoto(fileOf('slab.jpg'), { source: 'camera' });
    expect(prepared.takenAt).toBe('2026-11-06T04:30:00.000Z');
    expect(prepared.takenAt).toMatch(/(?:Z|[+-]\d{2}:?\d{2})$/);
  });

  it('carries real base64 with no data: prefix', async () => {
    const prepared = await prepareProgressPhoto(fileOf('slab.jpg'), { source: 'camera' });
    expect(prepared.base64.length).toBeGreaterThan(0);
    expect(prepared.base64.startsWith('data:')).toBe(false);
  });

  it('reports decode_failed when the browser cannot read the bytes', async () => {
    mocks.normalizeToWebP.mockRejectedValueOnce(new Error('boom'));
    const err = await prepareProgressPhoto(fileOf('IMG_2676.HEIC'), { source: 'gallery' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PreparePhotoError);
    expect((err as PreparePhotoError).code).toBe('decode_failed');
    expect(prepareErrorMessage(err)).toBe(PREPARE_ERROR_MESSAGE.decode_failed);
  });

  it('reports unsupported_output when the encoder silently returns a PNG-capable type it cannot store', async () => {
    // A browser with no WebP encoder hands back PNG - which IS storable, so the
    // case that must fail is a type outside the server allowlist entirely.
    mocks.normalizeToWebP.mockResolvedValueOnce(new Blob(['x'], { type: 'image/gif' }));
    const err = await prepareProgressPhoto(fileOf('slab.jpg'), { source: 'camera' }).catch(
      (e: unknown) => e,
    );
    expect((err as PreparePhotoError).code).toBe('unsupported_output');
  });

  it('accepts a PNG fallback, because the server stores PNG', async () => {
    mocks.normalizeToWebP.mockResolvedValueOnce(
      new Blob([new Uint8Array(1000)], { type: 'image/png' }),
    );
    const prepared = await prepareProgressPhoto(fileOf('slab.jpg'), { source: 'camera' });
    expect(prepared.mimeType).toBe('image/png');
    expect(prepared.filename).toBe('slab.png');
  });

  it('reports too_large instead of uploading a conversion that did not happen', async () => {
    mocks.normalizeToWebP.mockResolvedValueOnce(webpBlob(11 * 1024 * 1024));
    const err = await prepareProgressPhoto(fileOf('slab.jpg'), { source: 'camera' }).catch(
      (e: unknown) => e,
    );
    expect((err as PreparePhotoError).code).toBe('too_large');
  });

  it('never falls back to the original file on any failure', async () => {
    // The three failure paths above all throw; this asserts the contract at the
    // API surface: a rejection, never a resolved "prepared" original.
    for (const reject of [
      () => mocks.normalizeToWebP.mockRejectedValueOnce(new Error('x')),
      () => mocks.normalizeToWebP.mockResolvedValueOnce(new Blob(['x'], { type: 'image/gif' })),
      () => mocks.normalizeToWebP.mockResolvedValueOnce(webpBlob(20 * 1024 * 1024)),
    ]) {
      reject();
      await expect(
        prepareProgressPhoto(fileOf('slab.jpg'), { source: 'camera' }),
      ).rejects.toBeInstanceOf(PreparePhotoError);
    }
  });
});
