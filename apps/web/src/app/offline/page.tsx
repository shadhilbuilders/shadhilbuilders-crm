'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@paalstack/react-ui';
import { LuCloudOff } from '@paalstack/react-icons/lu';

import { get, keys } from 'idb-keyval';
import { rqCacheStore, RQ_CACHE_KEY } from '@shadhil/offline-store';

/**
 * Three-state offline fallback page (D2):
 *   A. No cache yet — first-ever offline visit (private mode, cleared
 *      storage, fresh install). Single Retry button.
 *   B. Cached view available — returning user. Two buttons: View cached
 *      leads (primary, → /leads) and Retry.
 *
 * Per eng review 3C, this component is unit-tested for both states.
 */
type CachedState = { hasCache: boolean; lastSyncedAt: number | null };

const OfflinePage = () => {
  const [state, setState] = useState<CachedState | null>(null);

  useEffect(() => {
    // Inspect the rqCache store. If `RQ_CACHE_KEY` is present, the user
    // has a persisted TanStack Query cache. The cached entries don't
    // matter for THIS page — we just need to know "do we have anything
    // to show the user or are we starting from zero?"
    Promise.all([keys(rqCacheStore), get(RQ_CACHE_KEY, rqCacheStore)])
      .then(([_allKeys, rqCache]) => {
        const lastSyncedAt =
          rqCache && typeof rqCache === 'object' && 'timestamp' in rqCache
            ? (rqCache as { timestamp: number }).timestamp
            : null;
        setState({ hasCache: Boolean(lastSyncedAt), lastSyncedAt });
      })
      .catch(() => setState({ hasCache: false, lastSyncedAt: null }));
  }, []);

  if (state === null) {
    return null;
  }

  // State A: no cache yet
  if (!state.hasCache) {
    return (
      <main className="container mx-auto flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
        <LuCloudOff className="text-muted-foreground h-12 w-12" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Offline</h1>
        <p className="text-muted-foreground max-w-sm">
          Open Shadhil CRM online once to enable offline access.
        </p>
        <Button onClick={() => location.reload()} size="lg" className="min-h-11 min-w-32">
          Retry
        </Button>
      </main>
    );
  }

  // State B: cached view available
  const lastSynced = state.lastSyncedAt
    ? new Date(state.lastSyncedAt).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'recently';

  return (
    <main className="container mx-auto flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <LuCloudOff className="text-muted-foreground h-12 w-12" aria-hidden="true" />
      <h1 className="text-2xl font-semibold">You're offline</h1>
      <p className="text-muted-foreground max-w-sm">
        Last synced {lastSynced}. Cached leads and visits are still available.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link
          href="/leads"
          className="bg-primary text-primary-foreground inline-flex min-h-11 items-center justify-center rounded-md px-6 font-medium"
        >
          View cached leads
        </Link>
        <Button
          onClick={() => location.reload()}
          variant="outline"
          size="lg"
          className="min-h-11 min-w-32"
        >
          Retry
        </Button>
      </div>
    </main>
  );
};

export default OfflinePage;
