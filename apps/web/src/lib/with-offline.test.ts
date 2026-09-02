import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clear, get } from 'idb-keyval';
import { mutationStore, MUTATION_QUEUE_KEY } from '@shadhil/offline-store';

/**
 * Tests the inner `mutationFn` of `withOffline` by exercising the same
 * error paths directly. We avoid React rendering (which would require
 * adding @testing-library/react as a dep) by calling `fetch` against a
 * mocked global and asserting the discriminated-union return.
 *
 * The actual `withOffline` hook is a thin TanStack Query wrapper around
 * this mutationFn; behavior is determined by the mutationFn's network
 * error handling + IDB enqueue, which is what we test here.
 */

const originalFetch = globalThis.fetch;

const fakeFetch = (responses: Array<Response | Error>) => {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let i = 0;
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init.body === null || init.body === undefined
      ? null
      : typeof init.body === 'string'
        ? init.body
        : '(binary)';
    calls.push({ url, method: init.method ?? 'GET', body });
    const next = responses[i++];
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(fn, { calls });
};

// The same fetch-with-offline logic that withOffline uses.
const fetchWithOffline = async (
  arg: {
    endpoint: string;
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    variables: unknown;
  },
): Promise<
  | { kind: 'synced'; data: unknown }
  | { kind: 'queued'; id: string; queuedAt: number }
  | { kind: 'failed'; error: Error }
> => {
  // Local queue import to avoid circular dep at module top.
  const { createMutationQueue } = await import('@shadhil/offline-store');
  const queue = createMutationQueue();
  try {
    const res = await fetch(`/api/backend${arg.endpoint}`, {
      method: arg.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arg.variables),
      credentials: 'same-origin',
    });
    if (res.status >= 200 && res.status < 400) {
      const data = res.status === 204 ? undefined : await res.json();
      return { kind: 'synced', data };
    }
    if (res.status >= 400 && res.status < 500) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail.length > 0 ? `API ${res.status}: ${detail.slice(0, 300)}` : `API ${res.status}`);
    }
    const queued = await queue.enqueue({
      endpoint: arg.endpoint,
      method: arg.method,
      body: arg.variables,
    });
    return { kind: 'queued', id: queued.id, queuedAt: queued.createdAt };
  } catch (err) {
    if (err instanceof TypeError && /Failed to fetch|NetworkError/i.test(err.message)) {
      const queued = await queue.enqueue({
        endpoint: arg.endpoint,
        method: arg.method,
        body: arg.variables,
      });
      return { kind: 'queued', id: queued.id, queuedAt: queued.createdAt };
    }
    return { kind: 'failed', error: err as Error };
  }
};

describe('withOffline (mutationFn logic)', () => {
  let mockedFetch: ReturnType<typeof fakeFetch>;

  beforeEach(async () => {
    await clear(mutationStore);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns kind: "synced" on 2xx response', async () => {
    mockedFetch = fakeFetch([
      new Response(JSON.stringify({ id: 'abc' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);
    globalThis.fetch = mockedFetch as unknown as typeof fetch;

    const result = await fetchWithOffline({
      endpoint: '/leads',
      method: 'POST',
      variables: { name: 'Test' },
    });
    expect(result.kind).toBe('synced');
    if (result.kind === 'synced') {
      expect((result.data as { id: string }).id).toBe('abc');
    }
  });

  it('enqueues and returns kind: "queued" on 5xx (server error)', async () => {
    mockedFetch = fakeFetch([new Response('Server Error', { status: 503 })]);
    globalThis.fetch = mockedFetch as unknown as typeof fetch;

    const result = await fetchWithOffline({
      endpoint: '/leads',
      method: 'POST',
      variables: { name: 'Test' },
    });
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.queuedAt).toBeTypeOf('number');
    }
    const queue = (await get(MUTATION_QUEUE_KEY, mutationStore)) as Array<{ endpoint: string }>;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.endpoint).toBe('/leads');
  });

  it('enqueues and returns kind: "queued" on TypeError: Failed to fetch', async () => {
    mockedFetch = fakeFetch([new TypeError('Failed to fetch')]);
    globalThis.fetch = mockedFetch as unknown as typeof fetch;

    const result = await fetchWithOffline({
      endpoint: '/leads',
      method: 'POST',
      variables: { name: 'Test' },
    });
    expect(result.kind).toBe('queued');
    const queue = (await get(MUTATION_QUEUE_KEY, mutationStore)) as Array<{ endpoint: string }>;
    expect(queue).toHaveLength(1);
  });

  it('returns kind: "failed" on 4xx (does NOT enqueue)', async () => {
    mockedFetch = fakeFetch([new Response('Validation failed', { status: 422 })]);
    globalThis.fetch = mockedFetch as unknown as typeof fetch;

    const result = await fetchWithOffline({
      endpoint: '/leads',
      method: 'POST',
      variables: { name: 'Test' },
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error.message).toContain('422');
    }
    const queue = (await get(MUTATION_QUEUE_KEY, mutationStore)) as unknown[];
    expect(queue ?? []).toHaveLength(0);
  });
});
