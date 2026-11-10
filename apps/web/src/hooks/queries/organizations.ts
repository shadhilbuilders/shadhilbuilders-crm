// Organization client hooks.
//
// GET /organizations returns the orgs the caller can access (id + slug).
// The session exposes organizationId (an id); slug-based URL building needs
// the SLUG, so this hook resolves id → slug for the root redirect and any
// other id-keyed → slug surface.
//
// Errors are NOT swallowed here: the root `/` redirect depends on the orgs
// query succeeding, so a failure must be surfaced (the page renders
// ErrorInternalServer) rather than silently returning `[]` and leaving the
// user stuck on an infinite skeleton.
//
// WHO MAY ASK (2026-11-10). This is a STAFF lookup. A CUSTOMER has no staff
// org home, and their session is refused by the backend's mustChangePassword
// gate anyway - so a buyer who mounted this query produced a guaranteed
// `403 PASSWORD_CHANGE_REQUIRED` on the portal landing path. It was not a
// permissions bug: the request should never have been made. `enabled` lets the
// caller say "I already know I do not need this answer", and the root page uses
// it to skip the lookup for buyers and while the session is still resolving
// (the query used to fire on mount, before the role was even known).
import { useQuery } from '@tanstack/react-query';

import { api } from '@/apis/client';
import type { Role } from '@/apis/client';
import { isPortalRole } from '@/lib/portal-routing';

export type OrgSummary = { id: string; name: string; slug: string };

/**
 * Whether a root-level surface needs the org slug at all.
 *
 * Deliberately NOT "is this a buyer" - the pending case matters just as much:
 * before the session resolves we do not know the role, and firing the query
 * then is exactly how a buyer ended up requesting it. So this stays false until
 * we have a resolved, non-buyer session that actually carries an org id.
 */
export function shouldResolveOrgSlug(input: {
  role: Role | undefined;
  /** True while better-auth's session read is still in flight. */
  isPending: boolean;
  organizationId: string | null | undefined;
}): boolean {
  if (input.isPending) return false;
  if (input.role === undefined) return false;
  if (isPortalRole(input.role)) return false;
  return typeof input.organizationId === 'string' && input.organizationId.length > 0;
}

export function useOrganizations(options: { enabled?: boolean } = {}) {
  return useQuery<OrgSummary[]>({
    queryKey: ['organizations', 'list'] as const,
    queryFn: () => api<OrgSummary[]>('/organizations'),
    staleTime: 60_000,
    retry: 1,
    enabled: options.enabled ?? true,
  });
}

/**
 * Resolve an org id → slug (null when unknown / not loaded / errored).
 * Also surfaces the underlying query's error/loading status so a redirect
 * page can render a real error state instead of an infinite skeleton.
 *
 * `enabled: false` means "do not ask". It also reports `isPending: false`,
 * because React Query leaves a disabled query in `pending`/`idle` forever -
 * reporting that as loading would hang the caller on a skeleton.
 */
export function useOrgSlugForId(
  orgId: string | null | undefined,
  options: { enabled?: boolean } = {},
): { orgSlug: string | null; isPending: boolean; error: Error | null } {
  const hasOrgId = typeof orgId === 'string' && orgId.length > 0;
  const enabled = (options.enabled ?? true) && hasOrgId;
  const { data, isPending, error } = useOrganizations({ enabled });

  if (!enabled) return { orgSlug: null, isPending: false, error: null };

  const org = (data ?? []).find((o) => o.id === orgId);
  return {
    orgSlug: org?.slug ?? null,
    isPending: isPending && error === null,
    error: error ?? null,
  };
}
