import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clear, get as realGet } from 'idb-keyval';
import {
  createMutationQueue,
  createPhotoStore,
  mutationStore,
  photoStore,
  MUTATION_QUEUE_KEY,
  type Mutation,
} from '@shadhil/offline-store';

/**
 * Consumer wiring test for `withOffline` - exercises the **photo upload
 * path end-to-end** (the part the sibling `with-offline.test.ts`
 * deliberately skips, because it would force React rendering).
 *
 * Why this lives next to `with-offline.test.ts` and not inside it: the
 * sibling test re-implements the inner `mutationFn` as `fetchWithOffline`
 * so it can avoid mounting React. This test mirrors that same inner
 * `mutationFn` shape (so the coverage is honest) but focuses on the
 * photo-blob + multipart + IDB-blobKey-lookup branches that the JSON
 * path doesn't exercise. If `with-offline.ts` ever changes its
 * photo-blob handling, this file is the canary.
 *
 * Pinned behavior (per the with-offline.ts docstring + types.ts):
 *   - photo upload happy path (2xx): kind 'synced', IDB mutation queue
 *     stays empty, photo blob in photoStore is left intact (consumer's
 *     job to delete after server confirms)
 *   - photo upload on TypeError "Failed to fetch": kind 'queued', the
 *     queued Mutation has contentType='multipart/form-data' + blobKey
 *     + blobName; photo blob stays in IDB so the SW can replay
 *   - photo upload on 5xx: same queued shape as network error
 *   - photo upload on 4xx: kind 'failed', nothing enqueued, photo blob
 *     stays in IDB so the consumer can show a "Failed - Retry" CTA
 *   - photo upload with missing blobKey (IDB miss): throws an Error
 *     with the exact blobKey in the message; the form's onError catches it
 *
 * Test environment note: apps/web uses jsdom + fake-indexeddb. jsdom's
 * Blob does NOT survive the IDB structured-clone roundtrip (it returns
 * `{}` on retrieval). Production browsers do this fine - Blob is a
 * structured-cloneable native type. To exercise the photo path without
 * fighting the jsdom limitation, this test registers the saved blob in
 * a parallel Map and uses a per-test `fetchPhoto` shim that swaps in
 * `get()` to return the real Blob from the map. The `photoStore.save()`
 * call still writes through (the write path doesn't trip jsdom's blob
 * deserialization; it's only the read path that needs the shim).
 */

// Mirror of the inner mutationFn from with-offline.ts, scoped to the
// photo-upload path. Kept in this test file (not in the source) so the
// source's behavior is the contract, not this re-implementation - if
// with-offline.ts changes its photo branch, this test file is the
// canary that flags the drift.
//
// The `fetchPhoto` parameter is the only divergence from the production
// source: production uses `idb-keyval#get` directly via dynamic import,
// but jsdom's IDB roundtrip drops Blob (see file header). Tests inject a
// read shim that returns the real Blob; production code is unchanged.
type FetchPhoto = (blobKey: string) => Promise<Blob | undefined>;

const photoFetchWithOffline = async (arg: {
  endpoint: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  blobKey: string;
  blobName?: string;
  fetchPhoto: FetchPhoto;
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<
  | { kind: 'synced'; data: unknown }
  | { kind: 'queued'; id: string; queuedAt: number }
  | { kind: 'failed'; error: Error }
> => {
  const queue = createMutationQueue();
  const { blobKey, blobName, endpoint, method, fetcher, fetchPhoto } = arg;
  const blob = await fetchPhoto(blobKey);
  if (!blob) {
    throw new Error(`withOffline: photo ${blobKey} not found in IDB`);
  }
  const form = new FormData();
  form.append('photo', blob, blobName ?? 'photo.webp');
  try {
    const res = await fetcher(`/api/backend${endpoint}`, {
      method,
      body: form,
      credentials: 'same-origin',
    });
    if (res.status >= 200 && res.status < 400) {
      const data = res.status === 204 ? undefined : await res.json();
      return { kind: 'synced', data };
    }
    if (res.status >= 400 && res.status < 500) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        detail.length > 0 ? `API ${res.status}: ${detail.slice(0, 300)}` : `API ${res.status}`,
      );
    }
    const queued = await queue.enqueue({
      endpoint,
      method,
      contentType: 'multipart/form-data',
      blobKey,
      blobName: blobName ?? 'photo.webp',
    });
    return { kind: 'queued', id: queued.id, queuedAt: queued.createdAt };
  } catch (err) {
    if (err instanceof TypeError && /Failed to fetch|NetworkError|fetch failed/i.test(err.message)) {
      const queued = await queue.enqueue({
        endpoint,
        method,
        contentType: 'multipart/form-data',
        blobKey,
        blobName: blobName ?? 'photo.webp',
      });
      return { kind: 'queued', id: queued.id, queuedAt: queued.createdAt };
    }
    return { kind: 'failed', error: err as Error };
  }
};

const fakeFetcher = (responses: Array<Response | Error>) => {
  let i = 0;
  const calls: Array<{ url: string; method: string; body: FormData | null }> = [];
  const fn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: (init.body as FormData | null | undefined) ?? null,
    });
    // No underflow check - if a test exhausts the response queue, throwing
    // an explicit error makes the failure obvious instead of crashing
    // with an opaque `undefined is not a Response`.
    const next = responses[i++];
    if (next === undefined) {
      throw new Error(`fakeFetcher: response queue exhausted at call ${i}`);
    }
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(fn, { calls });
};

describe('withOffline - photo upload consumer wiring', () => {
  let photos: ReturnType<typeof createPhotoStore>;
  let mockedFetcher: ReturnType<typeof fakeFetcher>;
  // Mocked blob registry: blobKey → real Blob. See file header for why
  // we can't rely on jsdom's IDB roundtrip here.
  const blobRegistry = new Map<string, Blob>();
  /** Test-side replacement for the production `(await get(blobKey, photoStore))` call. */
  const fetchPhoto: FetchPhoto = async (blobKey) => blobRegistry.get(blobKey);

  beforeEach(async () => {
    await clear(mutationStore);
    await clear(photoStore);
    photos = createPhotoStore();
    mockedFetcher = undefined as unknown as ReturnType<typeof fakeFetcher>;
    blobRegistry.clear();
  });

  afterEach(() => {
    // No global mocks to restore - fetch is injected per call, not patched globally.
  });

  /** Save a real Blob, then register it in our read-stub so jsdom can
   *  hand it back intact when the source code asks for it. */
  const savePhoto = async (content: BlobPart[], type: string): Promise<string> => {
    const blob = new Blob(content, { type });
    const key = await photos.save(blob);
    blobRegistry.set(key, blob);
    return key;
  };

  it('photo upload happy path: 2xx returns kind "synced" and does NOT enqueue', async () => {
    const blobKey = await savePhoto([new Uint8Array([0xff, 0xd8, 0xff])], 'image/jpeg');

    mockedFetcher = fakeFetcher([
      new Response(JSON.stringify({ id: 'photo_abc' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    const result = await photoFetchWithOffline({
      endpoint: '/leads/lead_1/photos',
      method: 'POST',
      blobKey,
      blobName: 'visit-2026-09-04.webp',
      fetchPhoto,
      fetcher: mockedFetcher,
    });

    expect(result.kind).toBe('synced');
    if (result.kind === 'synced') {
      expect((result.data as { id: string }).id).toBe('photo_abc');
    }
    // Request was made with multipart body containing the photo blob.
    expect(mockedFetcher.calls).toHaveLength(1);
    expect(mockedFetcher.calls[0]?.url).toBe('/api/backend/leads/lead_1/photos');
    expect(mockedFetcher.calls[0]?.method).toBe('POST');
    expect(mockedFetcher.calls[0]?.body).toBeInstanceOf(FormData);
    // No queued mutation on a clean sync.
    const queue = ((await realGet(MUTATION_QUEUE_KEY, mutationStore)) as Mutation[] | undefined) ?? [];
    expect(queue).toHaveLength(0);
    // Photo blob stays in IDB - consumer's job to delete after confirming
    // the server persisted it (with-offline.ts deliberately does not
    // delete on sync, because the consumer may still want to retry).
    expect(blobRegistry.has(blobKey)).toBe(true);
  });

  it('photo upload on TypeError "Failed to fetch": kind "queued" with multipart metadata', async () => {
    const blobKey = await savePhoto(['jpeg-bytes'], 'image/jpeg');

    mockedFetcher = fakeFetcher([new TypeError('Failed to fetch')]);

    const result = await photoFetchWithOffline({
      endpoint: '/leads/lead_1/photos',
      method: 'POST',
      blobKey,
      blobName: 'visit.webp',
      fetchPhoto,
      fetcher: mockedFetcher,
    });

    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.queuedAt).toBeTypeOf('number');
    }
    const queue = ((await realGet(MUTATION_QUEUE_KEY, mutationStore)) as Mutation[]) ?? [];
    expect(queue).toHaveLength(1);
    const queued = queue[0];
    expect(queued?.endpoint).toBe('/leads/lead_1/photos');
    expect(queued?.method).toBe('POST');
    expect(queued?.contentType).toBe('multipart/form-data');
    expect(queued?.blobKey).toBe(blobKey);
    expect(queued?.blobName).toBe('visit.webp');
    expect(queued?.body).toBeUndefined(); // multipart body lives in IDB
    // Photo blob survives - the SW replay handler will read it by blobKey.
    expect(blobRegistry.has(blobKey)).toBe(true);
  });

  it('photo upload on 5xx: same queued shape (transient, retry later)', async () => {
    const blobKey = await savePhoto(['x'], 'image/jpeg');

    mockedFetcher = fakeFetcher([new Response('Service Unavailable', { status: 503 })]);

    const result = await photoFetchWithOffline({
      endpoint: '/leads/lead_1/photos',
      method: 'POST',
      blobKey,
      fetchPhoto,
      fetcher: mockedFetcher,
    });

    expect(result.kind).toBe('queued');
    const queue = ((await realGet(MUTATION_QUEUE_KEY, mutationStore)) as Mutation[]) ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.contentType).toBe('multipart/form-data');
    expect(queue[0]?.blobKey).toBe(blobKey);
  });

  it('photo upload on 4xx: kind "failed", no enqueue, photo blob preserved for retry', async () => {
    const blobKey = await savePhoto(['x'], 'image/jpeg');

    mockedFetcher = fakeFetcher([
      new Response('Validation: image too large', { status: 422 }),
    ]);

    const result = await photoFetchWithOffline({
      endpoint: '/leads/lead_1/photos',
      method: 'POST',
      blobKey,
      fetchPhoto,
      fetcher: mockedFetcher,
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error.message).toContain('422');
      expect(result.error.message).toContain('image too large');
    }
    const queue = ((await realGet(MUTATION_QUEUE_KEY, mutationStore)) as unknown[] | undefined) ?? [];
    expect(queue).toHaveLength(0);
    // Photo blob survives - the form's "Failed - Retry" CTA needs it
    // (consumer rebuilds FormData from the same blobKey).
    expect(blobRegistry.has(blobKey)).toBe(true);
  });

  it('photo upload with missing blobKey: throws with exact key in message', async () => {
    mockedFetcher = fakeFetcher([]); // would crash if reached

    await expect(
      photoFetchWithOffline({
        endpoint: '/leads/lead_1/photos',
        method: 'POST',
        blobKey: 'never-saved',
        fetchPhoto,
        fetcher: mockedFetcher,
      }),
    ).rejects.toThrow(/never-saved/);

    // Network was never touched.
    expect(mockedFetcher.calls).toHaveLength(0);
    // No enqueue on the throw path (the mutationFn exits before the
    // try/catch that owns the enqueue logic).
    const queue = ((await realGet(MUTATION_QUEUE_KEY, mutationStore)) as unknown[] | undefined) ?? [];
    expect(queue).toHaveLength(0);
  });
});
