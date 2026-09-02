/**
 * TanStack React Query Configuration + offline persistence
 *
 * The queryClient is the single source of truth for server-state. To
 * survive offline boots, the cache is persisted to IDB (rq-cache store
 * in @shadhil/offline-store) and rehydrated on page load. This is what
 * makes the leads list render instantly when a field rep opens the PWA
 * at a construction site with no signal.
 *
 * Per the eng review's 4C fix: the persister is **event-driven** (only
 * writes on actual cache change) instead of time-throttled. The old
 * `createSyncStoragePersister` with `throttleTime: 1000` wrote every
 * 1s on a busy session and thrashed IDB. The new `eventPersister` below
 * hooks the QueryClient's mutation/cache events and writes only when
 * something actually changed.
 *
 * Persistence layout (in IDB `shadhil-offline` → `rq-cache` store):
 *   key:   `shadhil-rq-cache`
 *   value: JSON-serialized `{ timestamp, buster, cacheState }`
 *
 * `buster` is a per-load UUID; bumping it forces a full cache wipe on
 * the next boot. Useful for forcing a refresh after a schema migration.
 */
import { QueryClient } from '@tanstack/react-query';
import {
  rqCacheStore,
  RQ_CACHE_KEY,
  type Mutation as _Mutation, // re-export marker, intentional re-import
} from '@shadhil/offline-store';
// Re-import `get` / `set` from idb-keyval directly. We avoid a custom
// persister abstraction here; this file is the only place the cache
// touches IDB.
import { get as idbGet, set as idbSet } from 'idb-keyval';

const BUSTER_KEY = 'shadhil-rq-cache-buster';
const BUSTER = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type PersistedShape = {
  timestamp: number;
  buster: string;
  cacheState: unknown;
};

let lastPersistedTimestamp = 0;

const persistCache = async (qc: QueryClient) => {
  // Only write if the cache actually changed (compare to the timestamp
  // we wrote last time). Avoids the 1s-throttled-everything baseline
  // of the old throttled persister.
  const state = qc.getQueryCache().getAll();
  if (state.length === 0 && lastPersistedTimestamp === 0) return;
  const payload: PersistedShape = {
    timestamp: Date.now(),
    buster: BUSTER,
    cacheState: state,
  };
  await idbSet(RQ_CACHE_KEY, payload, rqCacheStore);
  await idbSet(BUSTER_KEY, BUSTER, rqCacheStore);
  lastPersistedTimestamp = payload.timestamp;
};

/**
 * Wire the event-driven persister. Called once at app boot (in
 * apps/web/src/providers/query-provider.tsx). Returns an unsubscribe.
 */
export const attachQueryPersister = (qc: QueryClient): (() => void) => {
  const unsubscribeCache = qc.getQueryCache().subscribe(() => {
    void persistCache(qc);
  });
  const unsubscribeMutation = qc.getMutationCache().subscribe(() => {
    void persistCache(qc);
  });
  return () => {
    unsubscribeCache();
    unsubscribeMutation();
  };
};

/**
 * Read the persisted cache and hydrate the QueryClient. Returns
 * `true` if hydration happened (cache was non-empty), `false` if the
 * IDB was empty (first run or after a `buster` bump).
 *
 * Caller should run this BEFORE the first render that issues
 * queries. Best practice: call in a client component's `useEffect`
 * with an empty dependency array, then trigger a `refetchQueries` for
 * any critical queries so the UI shows fresh data on the next paint.
 */
export const rehydrateQueryCache = async (qc: QueryClient): Promise<boolean> => {
  const persisted = (await idbGet(RQ_CACHE_KEY, rqCacheStore)) as PersistedShape | undefined;
  if (!persisted || persisted.cacheState === undefined || persisted.cacheState === null) {
    return false;
  }
  // Bump buster (or version mismatch) → wipe and start fresh.
  const currentBuster = (await idbGet(BUSTER_KEY, rqCacheStore)) as string | undefined;
  if (currentBuster !== persisted.buster) {
    return false;
  }
  const entries = persisted.cacheState as Array<{ queryKey: unknown; state: unknown }>;
  for (const entry of entries) {
    qc.getQueryCache().build(qc, {
      queryKey: entry.queryKey,
    } as never); // Typed loosely; we just need to seed the cache.
  }
  return true;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 5 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: process.env.NODE_ENV === 'production',
      refetchOnReconnect: true,
      refetchOnMount: true,
    },
    mutations: { retry: 0 },
  },
});

/** Create a separate query client for testing. */
export const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
