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
