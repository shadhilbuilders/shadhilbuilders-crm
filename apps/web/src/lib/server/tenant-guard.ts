// Server-side enforcement of a tenant lookup's outcome.
//
// The org and project layouts both resolve a URL segment to a tenant and
// then have to decide what to DO when that fails. Encoding the decision once
// here keeps the two layouts from drifting apart (the drift is exactly what
// produced the original bug: one generic `notFound()` for six different
// failures).
//
// `server-only` because it imports next/navigation's redirect/notFound, which
// only work inside a request render. The pure classification lives in
// lib/tenant-failure.ts so it stays unit-testable without a request.
import 'server-only';

import { notFound, redirect } from 'next/navigation';

import type { TenantResult } from '@/lib/server/tenant';
import { actionForFailure } from '@/lib/tenant-failure';

/**
 * Resolve a tenant result or route the user to where they can act on the
 * failure. Returns the resolved data on success; otherwise it THROWS (via
 * `redirect`/`notFound`) or rethrows for the error boundary, so callers can
 * treat the return value as always present.
 *
 * @param result   the lookup outcome
 * @param nextPath the page to return to after signing in (used by the
 *                 `unauthenticated` branch)
 * @param what     human label for the error message ("your workspace")
 */
export function requireTenant<T>(result: TenantResult<T>, nextPath: string, what: string): T {
  if (result.ok) return result.data;

  const failure = result.failure;
  const action = actionForFailure(failure);

  if (action.kind === 'login') {
    // The cookie was present (so the proxy let us through) but the Session
    // row is gone or expired. Sign in, then come back to this exact page.
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  if (action.kind === 'change-password') {
    redirect('/change-password');
  }

  if (action.kind === 'not-found') {
    // Absent for this caller, whether that is "never existed" or RLS filtered
    // it - deliberately indistinguishable (no existence oracle across orgs).
    notFound();
  }

  // Hand off to the segment's error.tsx, which offers a retry. A backend
  // outage must never read as "this workspace is gone".
  throw new Error(
    failure.kind === 'unavailable'
      ? `Could not load ${what} (backend ${
          failure.status === null ? 'unreachable' : `error ${failure.status}`
        }).`
      : `Could not load ${what}.`,
  );
}
