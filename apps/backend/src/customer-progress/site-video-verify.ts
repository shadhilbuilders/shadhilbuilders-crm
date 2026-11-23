import { Logger } from '@nestjs/common';
// Server-side verification of an uploaded clip and its poster (plan section 8).
//
// The client's claims are hints; these checks make them facts. Size comes from
// the storage layer's own `stat`, privacy from the object's flag, and the
// container from the first bytes actually stored. Every refusal is a typed
// error from the catalog, and every storage FAILURE (as opposed to "not
// there") surfaces as the retryable STORAGE_UNAVAILABLE, never as a misleading
// 404.
import { CodedException } from '../common/errors/coded-exception';
import { MAX_VIDEO_BYTES } from '../storage/storage.limits';
import { sniffMime } from '../storage/sniff-mime';
import type { StorageProvider } from '../storage/storage.provider';
import { siteVideoError } from './site-video.errors';

const logger = new Logger('SiteVideoVerify');

/** A poster is a still frame at 1280px and JPEG q0.8; 2MiB is generous. */
export const POSTER_MAX_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 64;
const POSTER_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Run a storage call; a typed error passes through, anything else is an outage. */
export async function guardStorage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof CodedException) throw err;
    // The provider's message can carry endpoints or paths: log it, never return it.
    logger.error(
      `[site-video] storage call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw siteVideoError('STORAGE_UNAVAILABLE');
  }
}

/** The first `HEAD_BYTES` of an object, or null when it does not exist. */
async function readHead(storage: StorageProvider, key: string): Promise<Buffer | null> {
  const out = await storage.readStream(key, { start: 0, end: HEAD_BYTES - 1 });
  if (out === null || out.body === null) return null;
  const reader = out.body.getReader();
  const chunks: Buffer[] = [];
  let have = 0;
  try {
    while (have < HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      have += value.byteLength;
    }
  } finally {
    // Upstream may have ignored the range and be streaming the whole file:
    // stop reading after the head instead of pulling megabytes for 64 bytes.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, HEAD_BYTES);
}

/** Verify the clip. Returns the SERVER-measured size. */
export async function verifyClip(
  storage: StorageProvider,
  key: string,
  claimedSize: number,
): Promise<{ size: number }> {
  const info = await guardStorage(() => storage.stat(key));
  if (info === null) throw siteVideoError('VIDEO_UPLOAD_NOT_FOUND');
  if (!info.isPrivate) throw siteVideoError('VIDEO_NOT_PRIVATE');
  if (info.size > MAX_VIDEO_BYTES) {
    throw siteVideoError('VIDEO_TOO_LARGE', { maxBytes: MAX_VIDEO_BYTES });
  }
  if (info.size === 0 || info.size !== claimedSize) throw siteVideoError('VIDEO_SIZE_MISMATCH');

  const head = await guardStorage(() => readHead(storage, key));
  if (head === null) throw siteVideoError('VIDEO_UPLOAD_NOT_FOUND');
  const sniffed = sniffMime(head);
  if (sniffed !== 'video/mp4') {
    throw siteVideoError('VIDEO_CONTAINER_UNSUPPORTED', { detected: sniffed ?? 'unknown' });
  }
  return { size: info.size };
}

/** Verify the poster is a private, small, real image. */
export async function verifyPoster(storage: StorageProvider, key: string): Promise<void> {
  const info = await guardStorage(() => storage.stat(key));
  if (info === null) throw siteVideoError('VIDEO_UPLOAD_NOT_FOUND');
  if (!info.isPrivate) throw siteVideoError('VIDEO_NOT_PRIVATE');
  if (info.size === 0 || info.size > POSTER_MAX_BYTES) throw siteVideoError('VIDEO_POSTER_INVALID');

  const head = await guardStorage(() => readHead(storage, key));
  if (head === null) throw siteVideoError('VIDEO_UPLOAD_NOT_FOUND');
  const sniffed = sniffMime(head);
  if (sniffed === null || !POSTER_TYPES.has(sniffed)) throw siteVideoError('VIDEO_POSTER_INVALID');
}
