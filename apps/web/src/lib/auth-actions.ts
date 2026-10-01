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

import { useCallback } from 'react';

import { authClient } from '@/lib/auth-client';

/**
 * Sign the current user out and bounce to /login.
 *
 * Returns a stable callback (useCallback) so consumers can safely list
 * it in dependency arrays or hand it to a memoized component without
 * re-rendering on every render.
 *
 * HARD NAVIGATION, not router.replace (2026-10-01). Same reasoning as the
 * post-login redirect in (guest)/login/LoginForm.tsx, in reverse: the app
 * shell prefetches routes and the client router keeps rendered trees for
 * them. `router.replace('/login')` after signOut re-enters that cached
 * tree, so the shell could stay mounted - showing the signed-out user's
 * name, role and cached queries - instead of the sign-in form. A document
 * navigation re-requests /login from the server with the (now cleared)
 * cookie, so the proxy decides: no session -> render the form.
 *
 * `assign` over `replace` so the back button does not resurrect the
 * authenticated shell from history.
 */
export function useSignOut(): () => Promise<void> {
  return useCallback(async () => {
    await authClient.signOut();
    window.location.assign('/login');
  }, []);
}
