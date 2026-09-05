// Auth actions shared by the app shell + topbar.
//
// History: `app-header.tsx:42-46` inlined `signOut` as a `useCallback`
// because only the topbar mounted a sign-out button. The redesigned
// shell mounts a second one in the sidebar footer - and the `UserMenu`
// popover in the topbar keeps the original. Inlining the same three
// lines in two places is a DRY regression waiting for a refactor: if
// better-auth changes its sign-out contract, both sites need to be
// patched in lock-step. Extracting to a hook closes that hole.
//
// The hook is also the natural place to add future side effects
// (clearing the TanStack Query cache, killing the offline-queue IDB
// store, etc.) without re-touching every consumer.
'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { authClient } from '@/lib/auth-client';

/**
 * Sign the current user out and bounce to /login.
 *
 * Returns a stable callback (useCallback) so consumers can safely list
 * it in dependency arrays or hand it to a memoized component without
 * re-rendering on every render.
 */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  return useCallback(async () => {
    await authClient.signOut();
    router.replace('/login');
    router.refresh();
  }, [router]);
}
