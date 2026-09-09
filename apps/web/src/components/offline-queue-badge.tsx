'use client';

import { useEffect, useState } from 'react';
import { LuCloudOff, LuClock, LuCircleAlert, LuSettings } from '@paalstack/react-icons/lu';
import { Badge, Button, PopoverContent, PopoverRoot, PopoverTrigger } from '@paalstack/react-ui';
import { useQueryClient } from '@tanstack/react-query';

import { useQueueStore } from '@/lib/offline-store/queue-store';
import { subscribeQueueToStore } from '@/lib/offline-store/queue-store';

const RETRY_THRESHOLD = 3;

const formatRelative = (ms: number): string => {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
};

export const OfflineQueueBadge = () => {
  const items = useQueueStore((s) => s.items);
  const replay = useQueueStore((s) => s.replay);
  // T-D4: replayed writes change server state (a queued outcome can
  // flip the parent lead to VISITED). After a successful replay, the
  // affected queries are invalidated so the UI reflects reality
  // without a full reload.
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  // Subscribe to the queue's pub-sub events once on mount. The store
  // also reads items via Zustand selectors, but the pub-sub bridge
  // ensures the store is hydrated on first paint (the IDB read is
  // async, the components render before it completes).
  useEffect(() => {
    const unsubscribe = subscribeQueueToStore();
    // Force a re-read on mount so the badge has data on first paint.
    void useQueueStore.getState().refresh();
    return unsubscribe;
  }, []);

  if (items.length === 0) return null;

  const failedCount = items.filter((m) => m.lastError).length;
  const showBackgroundHint = items.filter((m) => (m.retries ?? 0) >= RETRY_THRESHOLD).length >= RETRY_THRESHOLD;

  const handleRetry = async () => {
    try {
      const result = await replay(async (m) => {
        const headers: Record<string, string> = {};
        let body: BodyInit;
        if (m.contentType === 'multipart/form-data' && m.blobKey) {
          const { photoStore } = await import('@shadhil/offline-store');
          const { get } = await import('idb-keyval');
          const blob = (await get(m.blobKey, photoStore)) as Blob | undefined;
          if (!blob) throw new Error('Photo not found');
          const form = new FormData();
          form.append('photo', blob, m.blobName ?? 'photo.webp');
          body = form;
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(m.body);
        }
        // Replay through the BFF (`/api/bff/*`): the route handler reads
        // the better-auth session cookie, mints the HS256 JWT, and
        // proxies to the backend with `Authorization: Bearer ...`. The
        // old `/api/backend` rewrite target had two defects (found
        // during T-D4): it dropped the global `api` prefix (404) and
        // carried no auth (the JWT guard requires Bearer). Page-side
        // replays now converge with the normal BFF fetch path.
        const res = await fetch(`/api/bff${m.endpoint}`, {
          method: m.method,
          headers,
          body,
          credentials: 'same-origin',
        });
        return { status: res.status };
      });

      // T-D4: after a successful replay, invalidate the affected
      // queries so the UI reflects the synced server state without a
      // full reload.
      if (result.succeeded > 0) {
        void queryClient.invalidateQueries({ queryKey: ['visits'] });
        void queryClient.invalidateQueries({ queryKey: ['leads'] });
      }
    } catch {
      // Replay is best-effort; the SW will retry on the next Background
      // Sync or page-side online event.
    }
  };

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${items.length} pending offline change${items.length === 1 ? '' : 's'}`}
            className="relative inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LuCloudOff className="h-4 w-4" aria-hidden="true" />
            <Badge
              variant={failedCount > 0 ? 'destructive' : 'secondary'}
              className="absolute -top-1 -right-1 h-5 min-w-5 px-1 text-[10px]"
            >
              {items.length > 9 ? '9+' : items.length}
            </Badge>
            {/* O-6: visually-hidden live region for SR announcements */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {items.length} pending offline change{items.length === 1 ? '' : 's'}
              {failedCount > 0 ? `, ${failedCount} failed` : ''}
            </span>
          </button>
        }
      />
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">Offline queue</p>
          <p className="text-muted-foreground text-xs">
            {items.length} pending · {failedCount} failed
          </p>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1" role="list">
          {items.map((m) => {
            const isFailed = Boolean(m.lastError);
            return (
              <li
                key={m.id}
                className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
              >
                {isFailed ? (
                  <LuCircleAlert className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <LuClock className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    <span className="font-mono text-xs">{m.method}</span>{' '}
                    <span className="text-muted-foreground">{m.endpoint}</span>
                  </p>
                  <p className="text-muted-foreground text-xs" suppressHydrationWarning>
                    {formatRelative(m.createdAt)}
                  </p>
                </div>
                {isFailed ? (
                  <Button size="sm" variant="ghost" onClick={() => void handleRetry()}>
                    Retry all
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {showBackgroundHint ? (
          <div className="border-t bg-muted/30 p-2">
            <p className="text-muted-foreground mb-1.5 text-xs">
              <LuSettings className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Background sync may be limited on this device
            </p>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => {
                if (/android/i.test(navigator.userAgent)) {
                  window.location.href = 'intent://settings#Intent;scheme=android-app;end';
                } else {
                  window.open('https://support.apple.com/guide/iphone/iph3dd5f53c/ios', '_blank');
                }
              }}
            >
              Open settings
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </PopoverRoot>
  );
};
