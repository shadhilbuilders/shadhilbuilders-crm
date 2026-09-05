import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clear, get } from 'idb-keyval';
import { createMutationQueue, type Mutation } from '../src/mutation-queue';
import { mutationStore, MUTATION_QUEUE_KEY } from '../src/idb-stores';

describe('mutation-queue', () => {
  beforeEach(async () => {
    await clear(mutationStore);
  });

  it('enqueues a mutation with a generated id and timestamp', async () => {
    const q = createMutationQueue();
    const queued = await q.enqueue({ endpoint: '/leads', method: 'POST', body: { name: 'A' } });
    expect(queued.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(queued.createdAt).toBeTypeOf('number');
    expect(queued.retries).toBe(0);
  });

  it('lists all queued mutations in FIFO order', async () => {
    const q = createMutationQueue();
    await q.enqueue({ endpoint: '/a', method: 'POST', body: {} });
    await q.enqueue({ endpoint: '/b', method: 'POST', body: {} });
    const all = await q.all();
    expect(all.map((m) => m.endpoint)).toEqual(['/a', '/b']);
  });

  it('replays against a fetcher: 2xx removes, 4xx marks failed, 5xx retries', async () => {
    const q = createMutationQueue();
    await q.enqueue({ endpoint: '/ok', method: 'POST', body: {} });
    await q.enqueue({ endpoint: '/client-err', method: 'POST', body: {} });
    await q.enqueue({ endpoint: '/server-err', method: 'POST', body: {} });

    const fetcher = vi.fn(async (m: Mutation) => {
      if (m.endpoint === '/ok') return { status: 201 };
      if (m.endpoint === '/client-err') return { status: 400 };
      return { status: 500 };
    });

    const result = await q.replay(fetcher);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.endpoint).toBe('/client-err');
    expect(result.failed[0]?.lastError).toContain('400');
    expect(result.retried).toBe(1);

    // Verify the queue state after replay: ok removed, client-err kept as
    // failed, server-err kept with incremented retries.
    const remaining = await q.all();
    expect(remaining).toHaveLength(2);
    const server = remaining.find((m) => m.endpoint === '/server-err');
    expect(server?.retries).toBe(1);
    const client = remaining.find((m) => m.endpoint === '/client-err');
    expect(client?.lastError).toContain('400');
    expect(client?.retries).toBe(0); // client errors don't retry
  });

  it('increments retries and re-throws on network error (5xx/network)', async () => {
    const q = createMutationQueue();
    await q.enqueue({ endpoint: '/net-err', method: 'POST', body: {} });

    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    const result = await q.replay(fetcher);
    expect(result.retried).toBe(1);

    const remaining = await q.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.retries).toBe(1);
    expect(remaining[0]?.lastError).toContain('Failed to fetch');
  });

  it('notifies subscribers on state change', async () => {
    const q = createMutationQueue();
    const phases: string[] = [];
    q.subscribe((s) => phases.push(s.phase));
    await q.enqueue({ endpoint: '/a', method: 'POST', body: {} });
    expect(phases).toContain('enqueued');
  });

  it('persists across queue instance creation (shared IDB)', async () => {
    const q1 = createMutationQueue();
    await q1.enqueue({ endpoint: '/x', method: 'POST', body: {} });

    // New instance reads from the same IDB store.
    const q2 = createMutationQueue();
    const all = await q2.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.endpoint).toBe('/x');
  });

  it('prune removes a single mutation by id', async () => {
    const q = createMutationQueue();
    const m = await q.enqueue({ endpoint: '/to-remove', method: 'POST', body: {} });
    await q.enqueue({ endpoint: '/to-keep', method: 'POST', body: {} });
    await q.prune(m.id);
    const remaining = await q.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.endpoint).toBe('/to-keep');
  });
});

// T-D4 - enqueueUnique: dedupe-aware enqueue for offline outcome writes.
describe('mutation-queue.enqueueUnique (T-D4 dedupe)', () => {
  beforeEach(async () => {
    await clear(mutationStore);
  });

  it('first call enqueues a fresh entry with a dedupeKey', async () => {
    const q = createMutationQueue();
    const m = await q.enqueueUnique({
      dedupeKey: 'outcome:v1:COMPLETED',
      endpoint: '/visits/v1/outcome',
      method: 'PATCH',
      body: { visitId: 'v1', outcome: 'COMPLETED' },
    });
    expect(m.dedupeKey).toBe('outcome:v1:COMPLETED');
    expect(m.retries).toBe(0);
    const all = await q.all();
    expect(all).toHaveLength(1);
  });

  it('same dedupeKey replaces the payload, keeps id/createdAt (last-write-wins)', async () => {
    const q = createMutationQueue();
    const first = await q.enqueueUnique({
      dedupeKey: 'outcome:v1:COMPLETED',
      endpoint: '/visits/v1/outcome',
      method: 'PATCH',
      body: { visitId: 'v1', outcome: 'COMPLETED', notes: 'tap 1' },
    });
    const second = await q.enqueueUnique({
      dedupeKey: 'outcome:v1:COMPLETED',
      endpoint: '/visits/v1/outcome',
      method: 'PATCH',
      body: { visitId: 'v1', outcome: 'COMPLETED', notes: 'tap 3' },
    });
    // Same logical entry - id and createdAt are stable.
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    // Payload is the LATEST tap.
    expect((second.body as { notes: string }).notes).toBe('tap 3');
    // Still exactly one entry in the queue.
    const all = await q.all();
    expect(all).toHaveLength(1);
  });

  it('different dedupeKeys stack as separate entries', async () => {
    const q = createMutationQueue();
    await q.enqueueUnique({
      dedupeKey: 'outcome:v1:COMPLETED',
      endpoint: '/visits/v1/outcome',
      method: 'PATCH',
      body: {},
    });
    await q.enqueueUnique({
      dedupeKey: 'outcome:v2:COMPLETED',
      endpoint: '/visits/v2/outcome',
      method: 'PATCH',
      body: {},
    });
    const all = await q.all();
    expect(all).toHaveLength(2);
  });

  it('different outcome values for the same visit are separate entries', async () => {
    const q = createMutationQueue();
    await q.enqueueUnique({
      dedupeKey: 'outcome:v1:NO_SHOW',
      endpoint: '/visits/v1/outcome',
      method: 'PATCH',
      body: { outcome: 'NO_SHOW' },
    });
    await q.enqueueUnique({
      dedupeKey: 'outcome:v1:COMPLETED',
      endpoint: '/visits/v1/outcome',
      method: 'PATCH',
      body: { outcome: 'COMPLETED' },
    });
    const all = await q.all();
    expect(all).toHaveLength(2);
  });

  it('enqueueUnique entries replay normally through the same fetcher path', async () => {
    const q = createMutationQueue();
    await q.enqueueUnique({
      dedupeKey: 'outcome:v1:COMPLETED',
      endpoint: '/ok',
      method: 'PATCH',
      body: {},
    });
    const fetcher = vi.fn(async () => ({ status: 200 }));
    const result = await q.replay(fetcher);
    expect(result.succeeded).toBe(1);
    const all = await q.all();
    expect(all).toHaveLength(0);
  });
});
