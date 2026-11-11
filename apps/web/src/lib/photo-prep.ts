// Photo preparation for the site capture flow (2026-11-08).
//
// THE PROBLEM THIS SOLVES: the server is strict and correct - it sniffs the
// leading bytes and rejects HEIC/AVIF with an actionable 400. An iPhone in its
// default HEIC mode therefore hit a dead end standing in a half-built villa,
// being told to go change a phone setting. The defect was always on the client,
// which relabelled the declared type instead of converting the bytes.
//
// So: convert BEFORE the photo leaves the phone. A 12MP capture becomes a
// 1600px WebP, typically 200-400KB instead of 2-5MB of base64, which is what
// makes the upload survive site signal.
//
// NO FALLBACK PATH. Every failure is a typed error with its own copy, because
// silently uploading the original bytes is exactly the behaviour this file
// exists to remove. The caller maps the code to one sentence and uploads
// nothing.
import { normalizeToWebP } from '@shadhil/offline-store';

/** Long edge cap. Never lower: the lightbox is full screen and the feed crops
 *  to 4:3, so 1600px is the floor for a legible full-screen view. */
export const MAX_EDGE = 1600;
/** WebP quality. Below this a construction photo's rebar and mortar joints go
 *  mushy at full screen. */
export const WEBP_QUALITY = 0.82;
/** Post-conversion cap. Over this, the conversion did not happen. Mirrors the
 *  server's MAX_UPLOAD_BYTES intent without importing a backend module. */
export const MAX_PREPARED_BYTES = 10 * 1024 * 1024;

/** The server's allowlist. Anything outside it is an error, not an upload. */
export const SERVER_MIME_ALLOWLIST = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type ServerMimeType = (typeof SERVER_MIME_ALLOWLIST)[number];

export type PrepareErrorCode = 'decode_failed' | 'unsupported_output' | 'too_large';

/** Typed failure. `code` is exhaustive so the caller's copy map cannot fall
 *  through to a generic message. */
export class PreparePhotoError extends Error {
  readonly code: PrepareErrorCode;

  constructor(code: PrepareErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PreparePhotoError';
    this.code = code;
  }
}

export type PreparedPhoto = {
  base64: string;
  mimeType: ServerMimeType;
  filename: string;
  takenAt: string;
  source: 'camera' | 'gallery';
  byteLength: number;
  width: number;
  height: number;
};

/** The extension that matches the REAL output type. */
export function extensionForMime(mime: string): string | null {
  switch (mime) {
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    default:
      return null;
  }
}

/** True when the browser's output type is one the server accepts. */
export function isServerMime(mime: string): mime is ServerMimeType {
  return (SERVER_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

/**
 * Swap a filename's extension for the one that matches the bytes.
 *
 * This is the mismatch the slice exists to kill: a `.HEIC` name over WebP bytes
 * is exactly what `reconcileUploadMime` used to catch on the server (by
 * rejecting the upload), and it is what made the stored row disagree with its
 * own content before that guard existed.
 */
export function filenameForMime(originalName: string, mime: string): string {
  const ext = extensionForMime(mime);
  // Strip the LAST extension only, and never treat a leading dot as one:
  // ".hidden" has no extension, it is a name.
  const dot = originalName.lastIndexOf('.');
  const rawStem = dot > 0 ? originalName.slice(0, dot) : originalName;
  // A leading dot is part of the name (".hidden"), not an empty stem.
  const stem = rawStem.trim().replace(/^\.+/, '');
  const safeStem = stem.length > 0 ? stem : 'site-photo';
  return ext === null ? safeStem : `${safeStem}.${ext}`;
}

/** Read a Blob as bare base64 (no data: prefix) - what the API expects. */
function readBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new PreparePhotoError('decode_failed', 'read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert one picked file into something the server will store.
 *
 * `takenAt` is `file.lastModified` (with its offset): EXIF capture time is a
 * separate item and deliberately not read here.
 */
export async function prepareProgressPhoto(
  file: File,
  opts: { source: 'camera' | 'gallery' },
): Promise<PreparedPhoto> {
  let converted: Blob;
  try {
    converted = await normalizeToWebP(file, WEBP_QUALITY, { maxEdge: MAX_EDGE });
  } catch {
    // The browser could not decode these bytes at all (a HEIC on a browser with
    // no HEIC decoder, a corrupt file, a PDF that passed the picker).
    throw new PreparePhotoError('decode_failed', 'This phone cannot read that photo format.');
  }

  // A browser with no WebP ENCODER silently returns a PNG. Read the type; never
  // assume.
  if (!isServerMime(converted.type)) {
    throw new PreparePhotoError(
      'unsupported_output',
      `conversion produced ${converted.type || 'an unknown type'}`,
    );
  }

  if (converted.size > MAX_PREPARED_BYTES) {
    throw new PreparePhotoError('too_large', 'photo is over 10MB after conversion');
  }

  const base64 = await readBase64(converted);
  if (base64.length === 0) throw new PreparePhotoError('decode_failed', 'empty read');

  const dimensions = await readDimensions(converted);

  return {
    base64,
    mimeType: converted.type,
    filename: filenameForMime(file.name, converted.type),
    takenAt: new Date(file.lastModified).toISOString(),
    source: opts.source,
    byteLength: converted.size,
    width: dimensions.width,
    height: dimensions.height,
  };
}

/** Best-effort intrinsic size for the preview's reserved box. Never throws: a
 *  photo that converted is uploadable whether or not we can measure it. */
async function readDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/** The one sentence a typed failure shows. Exhaustive by construction. */
export const PREPARE_ERROR_MESSAGE: Record<PrepareErrorCode, string> = {
  decode_failed: 'This phone cannot read that photo format. Use the camera button instead.',
  unsupported_output: 'That file is not a JPEG, PNG or WebP image.',
  too_large: 'That photo is too large to upload.',
};

/** Message for any thrown value from {@link prepareProgressPhoto}. */
export function prepareErrorMessage(err: unknown): string {
  if (err instanceof PreparePhotoError) return PREPARE_ERROR_MESSAGE[err.code];
  return 'That photo could not be prepared.';
}
