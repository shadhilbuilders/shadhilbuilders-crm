// sniff-mime.ts - byte-level content-type detection for stored media.
//
// WHY: the served Content-Type used to come from the key's filename
// extension, which is user-supplied. Phones name a JPEG `IMG_2676.PNG`; with
// `X-Content-Type-Options: nosniff` the browser then refuses to render it.
// The magic number is the only trustworthy source.
import { describe, expect, it } from 'vitest';

import { looksLikeJpeg, looksLikePng, reconcileUploadMime, sniffMime } from './sniff-mime';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a......', 'binary');
const PDF = Buffer.from('%PDF-1.7\n', 'binary');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'binary'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'binary'),
]);
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'binary')]);
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64]);

/** Build an ISO-BMFF header (`....ftyp<brand>`) for the given brand. */
function ftyp(brand: string): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp', 'binary'), Buffer.from(brand, 'binary')]);
}

const HEIC = ftyp('heic');
const AVIF = ftyp('avif');

describe('sniffMime', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['application/pdf', PDF],
    ['image/webp', WEBP],
    ['video/mp4', MP4],
    ['audio/mpeg', MP3],
    ['image/heic', HEIC],
    ['image/avif', AVIF],
  ])('identifies %s from its magic bytes', (expected, buf) => {
    expect(sniffMime(buf)).toBe(expected);
  });

  // A bare `ftyp` check would classify an iPhone photo as a video. The brand
  // at offset 8 is what distinguishes them.
  it('distinguishes HEIC/AVIF photos from MP4 video sharing the ftyp box', () => {
    expect(sniffMime(ftyp('heix'))).toBe('image/heic'); // older iPhone brand
    expect(sniffMime(ftyp('mif1'))).toBe('image/heic'); // HEIF container
    expect(sniffMime(ftyp('avif'))).toBe('image/avif');
    expect(sniffMime(ftyp('isom'))).toBe('video/mp4');
    expect(sniffMime(ftyp('mp42'))).toBe('video/mp4');
  });

  it('returns null for an unrecognised buffer rather than guessing', () => {
    expect(sniffMime(Buffer.from('hello world'))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });

  it('does not confuse a short prefix with a full signature', () => {
    // A truncated PNG header (4 bytes) is not a PNG.
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('requires "WEBP" at offset 8, not just RIFF', () => {
    const wavLike = Buffer.concat([
      Buffer.from('RIFF', 'binary'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'binary'),
    ]);
    expect(sniffMime(wavLike)).toBeNull();
  });
});

describe('looksLikePng / looksLikeJpeg', () => {
  it('agree with the full sniffer for their own formats', () => {
    expect(looksLikePng(PNG)).toBe(true);
    expect(looksLikeJpeg(JPEG)).toBe(true);
    expect(looksLikePng(JPEG)).toBe(false);
    expect(looksLikeJpeg(PNG)).toBe(false);
  });

  it('are false for empty and unrelated buffers', () => {
    expect(looksLikePng(Buffer.alloc(0))).toBe(false);
    expect(looksLikeJpeg(Buffer.alloc(0))).toBe(false);
    expect(looksLikePng(Buffer.from('nope'))).toBe(false);
  });
});

// The ROOT-CAUSE half of decision #101: the upload path trusted the browser's
// File.type (derived from the FILENAME), so a phone's JPEG-under-a-.PNG-name
// was recorded as image/png and stored bytes disagreed with the row forever.
describe('reconcileUploadMime - bytes beat the client declaration', () => {
  it('records the BYTES when the client lied about the type', () => {
    // The real incident: a JPEG's bytes declared as image/png.
    const out = reconcileUploadMime(JPEG, 'image/png');
    expect(out).toEqual({ mimeType: 'image/jpeg', declaredWasWrong: true });
  });

  it('agrees with an honest client (no false alarms)', () => {
    expect(reconcileUploadMime(PNG, 'image/png')).toEqual({ mimeType: 'image/png', declaredWasWrong: false });
    expect(reconcileUploadMime(JPEG, 'image/jpeg')).toEqual({ mimeType: 'image/jpeg', declaredWasWrong: false });
    expect(reconcileUploadMime(WEBP, 'image/webp')).toEqual({ mimeType: 'image/webp', declaredWasWrong: false });
  });

  it('ignores case and parameters in the declared type', () => {
    expect(reconcileUploadMime(JPEG, 'IMAGE/JPEG')?.declaredWasWrong).toBe(false);
    expect(reconcileUploadMime(PNG, 'image/png; charset=binary')?.declaredWasWrong).toBe(true);
  });

  // Returned as null so the caller can 400 rather than persist a row we cannot
  // serve a correct Content-Type for.
  it('returns null for an unidentifiable buffer', () => {
    expect(reconcileUploadMime(Buffer.from('not an image'), 'image/png')).toBeNull();
    expect(reconcileUploadMime(Buffer.alloc(0), 'image/jpeg')).toBeNull();
  });

  it('identifies HEIC so the caller can reject it with an actionable message', () => {
    expect(reconcileUploadMime(HEIC, 'image/heic')).toEqual({ mimeType: 'image/heic', declaredWasWrong: false });
    // Even when the client calls it jpeg, the bytes win - the caller then
    // rejects it instead of storing an unrenderable photo.
    expect(reconcileUploadMime(HEIC, 'image/jpeg')).toEqual({ mimeType: 'image/heic', declaredWasWrong: true });
  });
});
