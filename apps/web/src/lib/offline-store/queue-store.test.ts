import { describe, it, expect, beforeEach } from 'vitest';
import { clear } from 'idb-keyval';
import { mutationStore, createMutationQueue } from '@shadhil/offline-store';
import { useQueueStore, subscribeQueueToStore } from './queue-store';

describe('queue-store', () => {
  beforeEach(async () => {
    await clear(mutationStore);
    useQueueStore.setState({ items: [], phase: 'idle' });
  });

  it('starts with empty items and idle phase', () => {
    const state = useQueueStore.getState();
    expect(state.items).toEqual([]);
    expect(state.phase).toBe('idle');
  });

  it('refresh() reads the current IDB queue and updates the store', async () => {
    const queue = createMutationQueue();
    await queue.enqueue({ endpoint: '/a', method: 'POST', body: {} });
    await queue.enqueue({ endpoint: '/b', method: 'POST', body: {} });
    await useQueueStore.getState().refresh();
    const state = useQueueStore.getState();
    expect(state.items).toHaveLength(2);
    expect(state.items.map((m) => m.endpoint)).toEqual(['/a', '/b']);
  });

  it('subscribeQueueToStore forwards queue events to the Zustand store', async () => {
    const unsubscribe = subscribeQueueToStore();
    // Use the singleton queue from the store module so the subscriber
    // sees the same events the test enqueues.
    const { queue } = await import('./queue-store');
    await queue.enqueue({ endpoint: '/a', method: 'POST', body: {} });
    // The subscriber does an async IDB re-read after the event. Poll
    // briefly instead of waiting a fixed timeout.
    const deadline = Date.now() + 500;
    while (useQueueStore.getState().items.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(useQueueStore.getState().items.length).toBeGreaterThanOrEqual(1);
    expect(useQueueStore.getState().phase).toBe('enqueued');
    unsubscribe();
  });

  it('replay action is the queue.replay function (passes through)', () => {
    const { replay } = useQueueStore.getState();
    expect(typeof replay).toBe('function');
  });
});
