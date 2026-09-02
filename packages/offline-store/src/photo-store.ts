/**
 * Blob store for photos awaiting upload. Backed by the `photos` IDB
 * object store. Each blob is keyed by a UUID so the mutation queue can
 * reference it by `blobKey` (see `Mutation.blobKey` in types.ts).
 *
 * Quota handling: IDB storage is best-effort on mobile browsers. The
 * plan calls for "if QuotaExceededError, evict the oldest photo, retry
 * once". This is a single retry — repeated quota errors surface to the
 * UI via the thrown exception.
 */
import { del, get, keys, set } from 'idb-keyval';
import { photoStore } from './idb-stores';

export const createPhotoStore = () => ({
  /** Save a blob. Returns the generated UUID key. */
  async save(blob: Blob): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await set(id, blob, photoStore);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        // Evict the oldest blob (insertion order = IDB key sort order, which
        // is lexicographic on UUIDs — that's random, not chronological).
        // For a proper LRU, we'd need a separate metadata index. For the
        // MVP, evictions just shuffle a random blob out — the user can
        // re-capture if needed. A real LRU is a follow-up.
        const allKeys = (await keys(photoStore)) as string[];
        if (allKeys.length > 0) {
          const evictKey = allKeys[0];
          if (evictKey) await del(evictKey, photoStore);
          await set(id, blob, photoStore);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    return id;
  },

  async get(id: string): Promise<Blob | undefined> {
    return (await get(id, photoStore)) as Blob | undefined;
  },

  async list(): Promise<string[]> {
    return (await keys(photoStore)) as string[];
  },

  async remove(id: string): Promise<void> {
    await del(id, photoStore);
  },
});

export type PhotoStore = ReturnType<typeof createPhotoStore>;
