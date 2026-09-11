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
import { useQuery } from '@tanstack/react-query';

import { api } from '@/apis/client';

export type OrgSummary = { id: string; name: string; slug: string };

export function useOrganizations() {
  return useQuery<OrgSummary[]>({
    queryKey: ['organizations', 'list'] as const,
    queryFn: () => api<OrgSummary[]>('/organizations'),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Resolve an org id → slug (null when unknown / not loaded / errored).
 * Also surfaces the underlying query's error/loading status so a redirect
 * page can render a real error state instead of an infinite skeleton.
 */
export function useOrgSlugForId(
  orgId: string | null | undefined,
): { orgSlug: string | null; isPending: boolean; error: Error | null } {
  const { data, isPending, error } = useOrganizations();
  if (!orgId) return { orgSlug: null, isPending: false, error: null };
  const org = (data ?? []).find((o) => o.id === orgId);
  return {
    orgSlug: org?.slug ?? null,
    isPending: isPending && error === null,
    error: error ?? null,
  };
}
