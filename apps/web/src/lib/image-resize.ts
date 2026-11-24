// Browser-side size guard for a profile photo (2026-11-24).
//
// WHY THIS EXISTS: neither app carries an image pipeline (`sharp` is absent from
// both `apps/web` and `apps/backend` node_modules), so the only place a 4 MB
// camera photo can be shrunk is the browser. POST /api/media accepts up to 10 MiB,
// which is a ceiling, not a target: a face photo belongs at ~40 to 90 KB.
//
// The split matters: `squareCrop` is pure arithmetic (unit-tested without a DOM),
// `resizeToSquareJpeg` is the thin DOM half that can only fail in ways the caller
// must show to the user. A silent failure here is the worst outcome, so every
// refusal is a typed `AvatarImageError` with a `reason` the UI can speak.

/** Longest edge of the stored avatar, in pixels. */
export const AVATAR_MAX_EDGE = 512;

/** JPEG quality. 0.85 is the point where a face still looks sharp at 512. */
const JPEG_QUALITY = 0.85;

/**
 * How long an `<img>`-based decode may take before it is treated as failed.
 *
 * Not paranoia: a stalled decode fires neither `load` nor `error` in some
 * webviews, and without this the upload button would sit disabled forever with
 * no message. A real file decodes in milliseconds.
 */
const DECODE_TIMEOUT_MS = 4000;

export type AvatarImageErrorReason =
  /** The browser could not decode the bytes (HEIC on a desktop, corrupt file). */
  | 'decode-failed'
  /** Canvas produced no bytes at all. */
  | 'encode-failed';

export class AvatarImageError extends Error {
  constructor(
    readonly reason: AvatarImageErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'AvatarImageError';
  }
}

export interface SquareCrop {
  /** Source x of the square, in source pixels. */
  sx: number;
  /** Source y of the square, in source pixels. */
  sy: number;
  /** Side of the square taken from the source. */
  side: number;
  /** Side of the output square in CSS pixels. */
  out: number;
}

/**
 * Centre-crop the largest square the source allows, then cap it at `max`.
 *
 * Never upscales: a 300x300 avatar stays 300, because blowing it up to 512 adds
 * bytes and no detail. A zero-sized source returns a 1px square rather than
 * dividing by zero.
 */
export function squareCrop(
  source: { width: number; height: number },
  max: number = AVATAR_MAX_EDGE,
): SquareCrop {
  const width = Number.isFinite(source.width) ? Math.max(1, Math.floor(source.width)) : 1;
  const height = Number.isFinite(source.height) ? Math.max(1, Math.floor(source.height)) : 1;
  const side = Math.min(width, height);
  return {
    sx: Math.floor((width - side) / 2),
    sy: Math.floor((height - side) / 2),
    side,
    out: Math.min(side, Math.max(1, Math.floor(max))),
  };
}

type Drawable = CanvasImageSource & { width: number; height: number };

/**
 * Decode a picked file, centre-crop it to a square and re-encode it as JPEG.
 *
 * Throws `AvatarImageError('decode-failed')` when the browser cannot read the
 * bytes and `('encode-failed')` when the canvas returns nothing. Any other
 * throw is a real bug and is left alone.
 */
export async function resizeToSquareJpeg(file: File, max: number = AVATAR_MAX_EDGE): Promise<Blob> {
  const drawable = await decode(file);
  const { sx, sy, side, out } = squareCrop(drawable, max);

  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new AvatarImageError('encode-failed', 'Your browser could not prepare the photo.');
  }
  // White matte: a PNG with transparency becomes a black square in JPEG
  // otherwise, and a face on black is worse than no photo.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, sx, sy, side, side, 0, 0, out, out);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
  });
  if (blob === null) {
    throw new AvatarImageError('encode-failed', 'Your browser could not prepare the photo.');
  }
  return blob;
}

/**
 * Decode through `createImageBitmap` when the browser has it, else through an
 * `<img>` element. Safari and every Chromium build have the former; jsdom has
 * neither, which is why the failure is typed rather than thrown raw.
 */
async function decode(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try {
      return (await createImageBitmap(file)) as Drawable;
    } catch {
      throw new AvatarImageError(
        'decode-failed',
        'That image could not be read. Try a JPEG or PNG photo.',
      );
    }
  }

  if (typeof Image === 'function' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        const timer = setTimeout(() => {
          reject(new Error('img decode timed out'));
        }, DECODE_TIMEOUT_MS);
        el.onload = () => {
          clearTimeout(timer);
          resolve(el);
        };
        el.onerror = () => {
          clearTimeout(timer);
          reject(new Error('img decode failed'));
        };
        el.src = url;
      });
      return img as unknown as Drawable;
    } catch {
      throw new AvatarImageError(
        'decode-failed',
        'That image could not be read. Try a JPEG or PNG photo.',
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  throw new AvatarImageError('decode-failed', 'This browser cannot prepare images.');
}
