// Byte-level MIME sniffing for stored media (2026-11-06).
//
// WHY THIS EXISTS: the served `Content-Type` used to be inferred from the
// KEY's filename extension (`guessMime` in media.controller.ts). A filename
// is user-supplied and can lie - phones routinely produce a JPEG's bytes
// under a name ending `.PNG` (the browser reports `type: 'image/jpeg'`, but
// the camera roll kept the PNG name). Serving those bytes as `image/png`
// is not cosmetic: the web app sets `X-Content-Type-Options: nosniff`
// (apps/web/next.config.ts), so the browser REFUSES to render an image whose
// declared type contradicts its bytes. The bytes are the truth; the name is
// a label.

export type SniffedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/heic'
  | 'image/avif'
  | 'application/pdf'
  | 'video/mp4'
  | 'audio/mpeg';

function startsWithBytes(buf: Buffer, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const; // "GIF87a"
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const; // "GIF89a"
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46] as const; // "%PDF"

/**
 * Identify a media type from its leading bytes, or null when the format is
 * not one we recognise. Never guesses: an unrecognised buffer returns null so
 * the caller can fall back to the extension (or octet-stream).
 */
export function sniffMime(buf: Buffer): SniffedMime | null {
  if (startsWithBytes(buf, PNG_SIGNATURE)) return 'image/png';
  if (startsWithBytes(buf, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWithBytes(buf, GIF87A) || startsWithBytes(buf, GIF89A)) return 'image/gif';
  if (startsWithBytes(buf, PDF_SIGNATURE)) return 'application/pdf';

  // RIFF....WEBP - "RIFF" at 0, "WEBP" at 8.
  if (
    buf.length >= 12 &&
    startsWithBytes(buf, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp';
  }

  // ISO base media: size(4) + "ftyp" at offset 4. The brand at offset 8
  // decides WHICH family - iPhone photos are `heic`/`heix`/`mif1`, Android/
  // modern captures can be `avif`, everything else is treated as MP4 video.
  // Ordering matters: a bare `ftyp` check would classify a HEIC photo as a
  // video, which is exactly the kind of wrong-type-the-browser-drops bug this
  // module exists to prevent.
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'heic' || brand === 'heix' || brand === 'heim' || brand === 'heis' || brand === 'mif1' || brand === 'msf1') {
      return 'image/heic';
    }
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }

  // MPEG audio frame sync (11 set bits) - coarse but sufficient for chat audio.
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio/mpeg';

  return null;
}

/** True when the buffer's bytes are a PNG (used by the storage read guard). */
export function looksLikePng(buf: Buffer): boolean {
  return startsWithBytes(buf, PNG_SIGNATURE);
}

/** True when the buffer's bytes are a JPEG. */
export function looksLikeJpeg(buf: Buffer): boolean {
  return startsWithBytes(buf, JPEG_SIGNATURE);
}

export type MimeReconciliation = {
  /** The type to actually store and serve. */
  mimeType: SniffedMime;
  /**
   * True when the bytes disagreed with what the client declared. Callers log
   * this; it is never an error, because the client's value is a hint (a
   * browser's `File.type` derived from the name) and the bytes are fact.
   */
  declaredWasWrong: boolean;
};

/**
 * Decide the MIME type to record for an upload, preferring the BYTES over the
 * client's declaration (2026-11-06).
 *
 * Returns null when the bytes are not a recognised format - the caller turns
 * that into a 400, because storing an unidentifiable buffer would leave us
 * serving `application/octet-stream` for something the user called an image.
 *
 * This is the ROOT-CAUSE half of decision #101: the read path already serves
 * the sniffed type, but recording the wrong type at upload left the database
 * disagreeing with its own bytes, and `filename` reaching Meta's /media call
 * while the type said something else.
 */
export function reconcileUploadMime(
  buf: Buffer,
  declaredMimeType: string,
): MimeReconciliation | null {
  const sniffed = sniffMime(buf);
  if (sniffed === null) return null;
  return {
    mimeType: sniffed,
    declaredWasWrong: declaredMimeType.toLowerCase() !== sniffed,
  };
}
