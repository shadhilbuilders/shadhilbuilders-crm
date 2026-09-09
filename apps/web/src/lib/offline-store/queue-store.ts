'use client';

/**
 * Queue store - Zustand-based single source of truth for the mutation
 * queue's view-model state (items + phase). Replaces the anti-pattern
 * of `window.__shadhilOfflineReplay` global (Eng review 1B).
 *
 * Why Zustand: the project already uses Zustand (`zustand@5.0.15` in
 * apps/web/package.json), so no new dep. The store is small and
 * read-only-from-React perspective; mutations go through actions.
 *
 * Wiring:
 *   - The OfflineQueueBadge (in AppHeader) reads `items` and `count`.
 *   - The page-side replay handler subscribes via `setStatus` to
 *     know when the SW has finished a replay batch and items changed.
 *   - The SW doesn't touch this store directly; it posts a message
 *     via `client.postMessage({ type: 'replay-done', items })` and the
 *     page-side handler (mounted once in app/layout.tsx) updates the
 *     store.
 */

import { create } from 'zustand';
import { createMutationQueue, type Mutation } from '@shadhil/offline-store';

export const queue = createMutationQueue();

type QueueState = {
  items: Mutation[];
  // Last phase emitted by the queue. UI can react (e.g. show a "Syncing
  // 3 items..." toast while phase === 'replaying').
  phase: 'idle' | 'enqueued' | 'replaying' | 'replayed' | 'pruned';
  // Bumped on every state change so non-React listeners (the SW
  // message handler) can react without subscribing to the store.
  lastChangeAt: number;
  // Actions
  setStatus: (phase: QueueState['phase'], items: Mutation[]) => void;
  // Force a re-read from IDB and update the store. Used on app boot
  // and after SW messages.
  refresh: () => Promise<void>;
  // Page-side replay (Safari fallback when Background Sync is
  // unavailable). Returns the same shape as the SW's replay result.
  replay: typeof queue.replay;
};

export const useQueueStore = create<QueueState>((set) => ({
  items: [],
  phase: 'idle',
  lastChangeAt: Date.now(),
  setStatus: (phase, items) =>
    set({ phase, items, lastChangeAt: Date.now() }),
  refresh: async () => {
    const items = await queue.all();
    set({ items, lastChangeAt: Date.now() });
  },
  replay: queue.replay,
}));

/**
 * Bridge: subscribe to the queue's pub-sub events and forward them to
 * the Zustand store. Called once at app boot (in `app/layout.tsx` or
 * the root provider). Returns the unsubscribe function.
 *
 * The SW also posts a message after each replay round; the
 * ServiceWorkerRegistrar listens for that and calls
 * `useQueueStore.getState().refresh()` to pull the latest state.
 */
export const subscribeQueueToStore = (): (() => void) =>
  queue.subscribe((state) => {
    // Re-read the queue to get the canonical items list (the pub-sub
    // event only carries phase + the item that triggered the event,
    // not the full array).
    void queue.all().then((items) => {
      useQueueStore.setState({ phase: state.phase, items, lastChangeAt: Date.now() });
    });
  });
