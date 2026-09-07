'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@paalstack/react-ui';
import { LuCloudOff } from '@paalstack/react-icons/lu';

import { get, keys } from 'idb-keyval';

import { AuthTopBar } from '@/components/auth-top-bar';
import { rqCacheStore, RQ_CACHE_KEY } from '@shadhil/offline-store';

// T-ProjectSwitch: work-surface links on the offline page point at the
// DEFAULT project (Metro Heights). The registry is read from the offline
// RQ cache; if absent the link keeps the template path (the proxy bounces
// unauthenticated users to /login anyway once online).
const DEFAULT_PROJECT_SLUG = 'shadhil-metro-heights';

function projectLeadHrefFromCache(cache: unknown): string {
  try {
    // PersistedShape: { timestamp, buster, cacheState: dehydrated }
    const dehydrated = (cache as { cacheState?: { queries?: unknown[] } })
      .cacheState;
    for (const q of dehydrated?.queries ?? []) {
      const qk = (q as { queryKey?: unknown[] }).queryKey;
      if (!Array.isArray(qk) || qk[0] !== 'projects') continue;
      // useProjects stores ProjectListItem[] directly as state.data.
      const list = (q as { state?: { data?: unknown } }).state?.data;
      if (!Array.isArray(list)) continue;
      const hit =
        list.find(
          (p) =>
            p !== null &&
            typeof p === 'object' &&
            (p as { slug?: unknown }).slug === DEFAULT_PROJECT_SLUG,
        ) ?? list[0];
      const id = (hit as { id?: unknown } | null)?.id;
      return typeof id === 'string' ? `/${id}/leads` : '/leads';
    }
  } catch {
    // cache shape drift - template link is the safe fallback
  }
  return '/leads';
}

/**
 * Three-state offline fallback page (D2):
 *   A. No cache yet - first-ever offline visit (private mode, cleared
 *      storage, fresh install). Single Retry button.
 *   B. Cached view available - returning user. Two buttons: View cached
 *      leads (primary, → /leads) and Retry.
 *
 * Per eng review 3C, this component is unit-tested for both states.
 */
type CachedState = {
  hasCache: boolean;
  lastSyncedAt: number | null;
  /** T-ProjectSwitch: project-scoped leads link from the cached registry. */
  leadHref: string;
};

const OfflinePage = () => {
  const [state, setState] = useState<CachedState | null>(null);

  useEffect(() => {
    // Inspect the rqCache store. If `RQ_CACHE_KEY` is present, the user
    // has a persisted TanStack Query cache. The cached entries don't
    // matter for THIS page - we just need to know "do we have anything
    // to show the user or are we starting from zero?"
    Promise.all([keys(rqCacheStore), get(RQ_CACHE_KEY, rqCacheStore)])
      .then(([_allKeys, rqCache]) => {
        const lastSyncedAt =
          rqCache && typeof rqCache === 'object' && 'timestamp' in rqCache
            ? (rqCache as { timestamp: number }).timestamp
            : null;
        setState({
          hasCache: Boolean(lastSyncedAt),
          lastSyncedAt,
          leadHref: projectLeadHrefFromCache(rqCache),
        });
      })
      .catch(() =>
        setState({ hasCache: false, lastSyncedAt: null, leadHref: '/leads' }),
      );
  }, []);

  if (state === null) {
    return null;
  }

  // State A: no cache yet
  if (!state.hasCache) {
    return (
      <div className="bg-background flex min-h-[100dvh] flex-col">
        <AuthTopBar />
        <main className="container mx-auto flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
          <LuCloudOff className="text-muted-foreground h-12 w-12" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">Offline</h1>
          <p className="text-muted-foreground max-w-sm">
            Open Shadhil CRM online once to enable offline access.
          </p>
          <Button onClick={() => location.reload()} size="lg" className="min-h-11 min-w-32">
            Retry
          </Button>
        </main>
      </div>
    );
  }

  // State B: cached view available
  const leadHref = state.leadHref;
  const lastSynced = state.lastSyncedAt
    ? new Date(state.lastSyncedAt).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'recently';

  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <AuthTopBar />
      <main className="container mx-auto flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <LuCloudOff className="text-muted-foreground h-12 w-12" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">You're offline</h1>
        <p className="text-muted-foreground max-w-sm">
          Last synced {lastSynced}. Cached leads and visits are still available.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href={leadHref}
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
    </div>
  );
};

export default OfflinePage;
