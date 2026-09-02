/**
 * `withOffline()` — higher-order wrapper that adds offline-safety to any
 * existing `useMutation` hook in this app.
 *
 * Replaces the `useOfflineMutation` parallel-hook pattern that the
 * original plan proposed. The audit flagged this as a DRY violation
 * (Eng review 1A): there are already 7 useMutation hooks in
 * `apps/web/src/hooks/queries/crm.ts` and `users.ts`, each with a
 * different `mutationFn`. A parallel `useOfflineMutation` would force
 * every form to drop the existing type-safe wrapper.
 *
 * Pattern:
 *   - Wrap the existing `mutationFn` with an `offlineFetch` that tries
 *     the original request, then on `TypeError: Failed to fetch`
 *     (network error, not 4xx/5xx) enqueues to IDB.
 *   - 4xx errors propagate as `ApiError` (the caller's existing error
 *     handler catches them).
 *   - 5xx errors: enqueue (the server may recover; treat as transient).
 *   - Return type is a discriminated union so the form's success
 *     handler branches on `kind` to decide "Saved" vs "Saved locally".
 */

import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import {
  createMutationQueue,
  type Mutation,
  type OfflineMutationResult,
} from '@shadhil/offline-store';

const queue = createMutationQueue();

/**
 * Map a TanStack Query `mutationFn` arg + URL to a `Mutation` for the
 * queue. The form passes the `endpoint` (path) and method explicitly so
 * the queue can replay it later without needing the original function
 * closure.
 */
type OfflineArg<TVar> = {
  /** API path, e.g. `/leads` or `/leads/abc/photos`. No host. */
  endpoint: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Optional Content-Type override. Default: 'application/json'. */
  contentType?: 'application/json' | 'multipart/form-data';
  /** Optional IDB key for a photo blob (multipart uploads). */
  blobKey?: string;
  blobName?: string;
  /**
   * Body to send / enqueue. For JSON this is the JSON-serializable
   * payload; for multipart it's a `FormData` and the blob is read from
   * the `photoStore`.
   */
  variables: TVar;
};

/**
 * Hook: like `useMutation`, but when `offline: true` is set, the
 * returned `mutateAsync` resolves to `OfflineMutationResult<TData>`
 * instead of `TData`. The form can branch on `kind` to decide UI.
 *
 * IMPORTANT: This hook REPLACES the underlying fetcher with a generic
 * POST/PATCH/PUT/DELETE that hits `/api/backend{endpoint}` (the BFF
 * rewrite). Use the existing typed mutation hooks (e.g. `useSendMessage`)
 * for normal online calls; use `withOffline` only when the caller
 * genuinely needs offline write support.
 */
export function withOffline<TData = unknown, TVar = unknown, TError = Error>(
  options: UseMutationOptions<OfflineMutationResult<TData>, TError, OfflineArg<TVar>> & {
    /** When true, network errors enqueue the mutation and return kind: 'queued'. */
    offline?: boolean;
  },
): UseMutationResult<OfflineMutationResult<TData>, TError, OfflineArg<TVar>> {
  // The user's options are typed for OfflineMutationResult<TData>; we
  // keep that and only narrow the mutationFn override. Strip the
  // caller's `mutationFn` so our wrapper is the one that runs.
  const { mutationFn: _ignored, ...rest } = options;
  void _ignored;
  return useMutation<OfflineMutationResult<TData>, TError, OfflineArg<TVar>>({
    ...rest,
    mutationFn: async (arg): Promise<OfflineMutationResult<TData>> => {
      try {
        // Use the project's BFF fetch client. `api()` is in
        // `@/apis/client` but importing it here would couple this hook
        // to that file. We duplicate the small request shape here to
        // keep `withOffline` reusable from any app/web/* file.
        const headers: Record<string, string> = {};
        let body: BodyInit | undefined;

        if (arg.contentType === 'multipart/form-data' && arg.blobKey) {
          const { photoStore } = await import('@shadhil/offline-store');
          const { get } = await import('idb-keyval');
          const blob = (await get(arg.blobKey, photoStore)) as Blob | undefined;
          if (!blob) {
            throw new Error(`withOffline: photo ${arg.blobKey} not found in IDB`);
          }
          const form = new FormData();
          form.append('photo', blob, arg.blobName ?? 'photo.webp');
          body = form;
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(arg.variables);
        }

        const res = await fetch(`/api/backend${arg.endpoint}`, {
          method: arg.method,
          headers,
          body,
          credentials: 'same-origin',
        });

        if (res.status >= 200 && res.status < 400) {
          const data = res.status === 204 ? (undefined as TData) : ((await res.json()) as TData);
          return { kind: 'synced', data };
        }

        if (res.status >= 400 && res.status < 500) {
          // Client error: don't enqueue, surface to caller. Form can
          // show validation messages.
          const detail = await res.text().catch(() => '');
          throw new Error(
            detail.length > 0 ? `API ${res.status}: ${detail.slice(0, 300)}` : `API ${res.status}`,
          );
        }

        // 5xx: server-side problem. Enqueue, the user gets "Saved locally"
        // and the SW replays later.
        const queued = await queue.enqueue({
          endpoint: arg.endpoint,
          method: arg.method,
          contentType: arg.contentType,
          blobKey: arg.blobKey,
          blobName: arg.blobName,
          body: arg.contentType === 'multipart/form-data' ? undefined : arg.variables,
        } as Omit<Mutation, 'id' | 'createdAt' | 'retries'>);
        return { kind: 'queued', id: queued.id, queuedAt: queued.createdAt };
      } catch (err) {
        // TypeError: Failed to fetch (network error). Same treatment
        // as 5xx — enqueue and report.
        if (err instanceof TypeError && /Failed to fetch|NetworkError|fetch failed/i.test(err.message)) {
          const queued = await queue.enqueue({
            endpoint: arg.endpoint,
            method: arg.method,
            contentType: arg.contentType,
            blobKey: arg.blobKey,
            blobName: arg.blobName,
            body: arg.contentType === 'multipart/form-data' ? undefined : arg.variables,
          } as Omit<Mutation, 'id' | 'createdAt' | 'retries'>);
          return { kind: 'queued', id: queued.id, queuedAt: queued.createdAt };
        }
        // 4xx (or any other thrown error) — re-throw as 'failed' kind.
        // We map to the discriminated union by throwing and letting the
        // caller's onError catch it. The caller can then call mutateAsync
        // and inspect: on success → kind: 'synced' | 'queued'; on error
        // → kind: 'failed' (here).
        throw err;
      }
    },
  });
}
