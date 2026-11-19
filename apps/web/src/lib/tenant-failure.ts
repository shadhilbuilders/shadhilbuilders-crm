// Pure classification of a tenant-lookup failure - no `server-only`, no
// fetch, no React. Kept separate from `server/tenant.ts` so the mapping can
// be unit-tested (that module imports `server-only`, which throws outside a
// react-server bundle).
//
// WHY THIS EXISTS (2026-11-19): `/shadhil-builders/settings` rendered
// "Page not found" for signed-in users. The org layout resolved the
// `[orgSlug]` segment through a helper that collapsed EVERY failure into
// `null` - missing/expired session, backend 403, backend 5xx, network error
// and a genuine "no such org" were indistinguishable - and then turned
// `null` into `notFound()`. A stale session cookie (present, so the proxy
// let the request through, but no matching Session row) therefore produced a
// 404 on a page that exists, instead of the sign-in screen.
//
// Each failure now asserts what it actually means, so the layout can do the
// right thing per case instead of lying with one generic 404.

import { PASSWORD_CHANGE_REQUIRED } from '@shadhil/api-types';

/** Why a slug → tenant lookup did not produce a row. */
export type TenantFailure =
  /** No session cookie, or the Session row is gone/expired → sign in again. */
  | { kind: 'unauthenticated' }
  /** Valid session but the rotation gate is still shut → /change-password. */
  | { kind: 'password-change-required' }
  /** The caller may not see this tenant (RLS filtered it) → treat as absent. */
  | { kind: 'forbidden' }
  /** The slug genuinely does not resolve for this caller → 404. */
  | { kind: 'not-found' }
  /** Backend refused with a 5xx, or was unreachable → transient, not a 404. */
  | { kind: 'unavailable'; status: number | null };

/** The backend's rotation-gate error code (see JwtAuthGuard). Re-exported so
 * callers import it from the same module as the classifier. */
export { PASSWORD_CHANGE_REQUIRED } from '@shadhil/api-types';

function hasPasswordChangeCode(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === 'object' &&
    'code' in body &&
    (body as { code?: unknown }).code === PASSWORD_CHANGE_REQUIRED
  );
}

/**
 * Map a non-2xx backend response to the failure it represents.
 *
 * `status === null` means the request never got an answer (connection
 * refused, DNS, timeout) - that is NEVER "not found": an outage must not
 * tell a user their workspace vanished.
 */
export function classifyBackendFailure(status: number | null, body: unknown): TenantFailure {
  if (status === null) return { kind: 'unavailable', status: null };
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 403) {
    return hasPasswordChangeCode(body)
      ? { kind: 'password-change-required' }
      : { kind: 'forbidden' };
  }
  if (status === 404) return { kind: 'not-found' };
  // Any other 4xx is a client-side contract bug, not a missing page; still
  // reported as unavailable so it reaches the error boundary (with a retry)
  // rather than a misleading 404.
  return { kind: 'unavailable', status };
}

/** What a caller should DO about a failure. */
export type TenantAction =
  { kind: 'login' } | { kind: 'change-password' } | { kind: 'not-found' } | { kind: 'error' };

/** The user-facing action for a failure. `forbidden` is a 404 by design: a
 *  tenant a user may not see must not be distinguishable from one that does
 *  not exist (no existence oracle across organizations). */
export function actionForFailure(failure: TenantFailure): TenantAction {
  switch (failure.kind) {
    case 'unauthenticated':
      return { kind: 'login' };
    case 'password-change-required':
      return { kind: 'change-password' };
    case 'forbidden':
    case 'not-found':
      return { kind: 'not-found' };
    case 'unavailable':
      return { kind: 'error' };
  }
}
