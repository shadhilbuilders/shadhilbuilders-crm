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
 *   value: dehydrated QueryClient state (functions stripped: queryFn,
 *          retry, retryDelay, etc.) + our buster/timestamp envelope.
 *
 * `buster` is a per-load UUID; bumping it forces a full cache wipe on
 * the next boot. Useful for forcing a refresh after a schema migration.
 *
 * Round 26 fix (2026-09-03): the old persistCache serialized the full
 * Query objects from `qc.getQueryCache().getAll()`, which carried
 * `options.queryFn`,`retryDelay`, etc. into IndexedDB. IDB can't
 * structured-clone functions → DataCloneError on every persist. Replaced
 * with `dehydrate()` / `hydrate()` (TanStack's serialization helpers,
 * which strip non-cloneable fields by design) and dropped the custom
 * `retryDelay` function from defaults — TanStack's built-in default is
 * the same exponential backoff (`Math.min(1000 * 2 ** n, 30000)`).
 */
import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query';
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

// The dehydrated shape is intentionally `unknown` from our side.
// `dehydrate` returns a `{ mutations, queries }` snapshot with functions
// stripped; `hydrate` accepts the same shape.
type PersistedShape = {
  timestamp: number;
  buster: string;
  cacheState: unknown;
};

let lastPersistedTimestamp = 0;

const persistCache = async (qc: QueryClient) => {
  // Only write if the cache actually changed (compare to the timestamp
  // we wrote last time). Avoids the 1s-throttled-everything baseline
  // of the old throttled persister. `dehydrate` strips non-cloneable
  // fields (queryFn, retry, retryDelay, etc.) before we hand the
  // payload to IDB — see Round 26 in DECISION-CHANGELOG.
  const snapshot = dehydrate(qc);
  const hasState =
    snapshot.queries.length > 0 || snapshot.mutations.length > 0;
  if (!hasState && lastPersistedTimestamp === 0) return;
  const payload: PersistedShape = {
    timestamp: Date.now(),
    buster: BUSTER,
    cacheState: snapshot,
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
  const persisted = (await idbGet(RQ_CACHE_KEY, rqCacheStore)) as
    | PersistedShape
    | undefined;
  if (!persisted || persisted.cacheState === undefined || persisted.cacheState === null) {
    return false;
  }
  // Bump buster (or version mismatch) → wipe and start fresh.
  const currentBuster = (await idbGet(BUSTER_KEY, rqCacheStore)) as string | undefined;
  if (currentBuster !== persisted.buster) {
    return false;
  }
  // `hydrate` re-seeds the QueryClient from a dehydrated snapshot.
  // It only restores query state (data/status/error, observer counts,
  // queryHash); queryFn, retry, retryDelay come from the live
  // QueryClient defaults at observation time. This is the official
  // TanStack way to do offline cache restore.
  hydrate(qc, persisted.cacheState as Parameters<typeof hydrate>[1]);
  return true;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // retryDelay intentionally omitted — TanStack's default is
      // `Math.min(1000 * 2 ** attemptIndex, 30000)`, which is what we
      // want. Putting a function here previously broke IDB persistence
      // (Round 26: DataCloneError on structured-clone).
      staleTime: 5 * 60 * 1000,
      // T21 (PR3): 30s gcTime caps how long an unresolved query sticks
      // around. Combined with T29 (AbortSignal forwarding in
      // `apis/client.ts`), a query that takes longer than 30s gets
      // GC'd AND its in-flight fetch is cancelled. Prevents the
      // "skeleton-pulse-forever" failure mode (CEO §2 1A).
      gcTime: 30 * 1000,
      refetchOnWindowFocus: process.env.NODE_ENV === 'production',
      refetchOnReconnect: true,
      refetchOnMount: true,
      // T21: dev-mode warning when a query is GC'd at the 30s
      // threshold. The QueryCache subscription below logs the
      // queryKey + the GC reason so a developer can see which
      // endpoint is timing out.
    },
    mutations: { retry: 0 },
  },
});

// T21: subscribe to the query cache and warn when a query is removed
// (which happens on GC after the 30s timeout). Production builds skip
// the warning to avoid noise in real deployments.
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'removed') {
      const query = event.query;
      // Only warn if the query was actively fetching (not an
      // intentional unmount with no data loss).
      if (query.state.fetchStatus === 'fetching') {
        // eslint-disable-next-line no-console
        console.warn(
          `[query] GC'd while still fetching — exceeded 30s timeout. ` +
            `queryKey=${JSON.stringify(query.queryKey)}`,
        );
      }
    }
  });
}

/** Create a separate query client for testing. */
export const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });