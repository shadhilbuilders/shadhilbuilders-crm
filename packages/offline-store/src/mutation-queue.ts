import { get, set } from 'idb-keyval';
import { mutationStore, MUTATION_QUEUE_KEY } from './idb-stores';
import type { Mutation, OfflineState, ReplayResult } from './types';

export type { Mutation, OfflineState, ReplayResult } from './types';

/**
 * IDB-backed FIFO queue of pending mutations.
 *
 * Persistence: the queue is a single array stored under MUTATION_QUEUE_KEY
 * in the `mutationStore` IDB object store. Every enqueue / replay / prune
 * re-reads and re-writes the whole array (the queue is small — typical
 * PWA session has <50 items). The trade-off: simple code, predictable
 * ordering, no partial-write risk.
 *
 * Concurrency: single-writer assumption. The SW replay handler and the
 * page's `withOffline` wrapper may both call `replay()` at the same time
 * (the SW after a Background Sync, the page after an `online` event).
 * Both reads and writes are sequential awaits so we won't interleave, but
 * the last writer wins. This is acceptable for the MVP — Expo (Week 8+)
 * will introduce a proper queue serialization if it becomes a problem.
 *
 * Replay classification (per the plan's flow):
 *   - 2xx: success, remove from queue
 *   - 3xx: treat as success, remove (server redirect; caller should
 *     refetch the canonical URL via TanStack Query, not via this queue)
 *   - 4xx: client error, do NOT retry (e.g. validation, auth). Mark with
 *     `lastError` and leave in queue for UI to surface (and the user to
 *     resolve manually).
 *   - 5xx + network errors: transient, increment `retries`, leave in
 *     queue for next replay. The page/SW will retry on the next
 *     `online` event or Background Sync trigger.
 */
export const createMutationQueue = () => {
  const subscribers = new Set<(s: OfflineState) => void>();

  const notify = (phase: OfflineState['phase'], item?: Mutation) => {
    const state: OfflineState = { phase, item, count: 0 };
    subscribers.forEach((fn) => fn(state));
  };

  const loadAll = async (): Promise<Mutation[]> => {
    return (await get<Mutation[]>(MUTATION_QUEUE_KEY, mutationStore)) ?? [];
  };

  const saveAll = async (mutations: Mutation[]): Promise<void> => {
    await set(MUTATION_QUEUE_KEY, mutations, mutationStore);
  };

  return {
    /**
     * Add a mutation to the queue. Generates an id and timestamp if
     * missing. Triggers an `enqueued` notification.
     */
    async enqueue(input: Omit<Mutation, 'id' | 'createdAt' | 'retries'>): Promise<Mutation> {
      const queued: Mutation = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        retries: 0,
      };
      const all = await loadAll();
      all.push(queued);
      await saveAll(all);
      notify('enqueued', queued);
      return queued;
    },

    /** Return all queued mutations in FIFO order. */
    async all(): Promise<Mutation[]> {
      return loadAll();
    },

    /**
     * Run each queued mutation through the fetcher. See class docstring
     * for the status code classification. Returns counts for UI to show
     * "3 synced, 1 failed, 2 retrying" toasts.
     */
    async replay(
      fetcher: (m: Mutation) => Promise<{ status: number }>,
    ): Promise<ReplayResult> {
      const all = await loadAll();
      const succeeded: Mutation[] = [];
      const failed: Mutation[] = [];
      const retried: Mutation[] = [];
      const remaining: Mutation[] = [];

      for (const m of all) {
        notify('replaying', m);
        try {
          const res = await fetcher(m);
          if (res.status >= 200 && res.status < 400) {
            succeeded.push(m);
          } else if (res.status >= 400 && res.status < 500) {
            // Client error: don't retry. Surface via lastError so the UI
            // can show a "Failed — Retry" CTA (the user must fix the
            // underlying problem, e.g. re-login, correct the data).
            m.lastError = `HTTP ${res.status}`;
            failed.push(m);
            remaining.push(m);
          } else {
            // 5xx or any other non-2xx/3xx/4xx: transient, increment.
            m.retries += 1;
            m.lastError = `HTTP ${res.status}`;
            retried.push(m);
            remaining.push(m);
          }
        } catch (err) {
          // Network error (TypeError: Failed to fetch, AbortError, etc.)
          m.retries += 1;
          m.lastError = err instanceof Error ? err.message : String(err);
          retried.push(m);
          remaining.push(m);
        }
      }

      await saveAll(remaining);
      notify('replayed');
      return { succeeded: succeeded.length, failed, retried: retried.length };
    },

    /**
     * Remove a single mutation by id. Used when the user manually
     * dismisses a failed mutation, or when a 4xx is confirmed as
     * unfixable.
     */
    async prune(id: string): Promise<void> {
      const all = await loadAll();
      await saveAll(all.filter((m) => m.id !== id));
      notify('pruned');
    },

    /**
     * Subscribe to queue state changes. Returns an unsubscribe function.
     * Pages drive UI (toasts, badge count) from these events.
     */
    subscribe(fn: (s: OfflineState) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
};

export type MutationQueue = ReturnType<typeof createMutationQueue>;
