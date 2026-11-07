'use client';

// Root redirect for the slug-based multi-tenant path scheme (2026-09-11).
//
// Every authenticated route lives under `/[orgSlug]/...`. The bare `/` (the
// proxy's post-login target) has no page of its own, so bounce to the org
// home. The session exposes ORG ID, but the URL needs the ORG SLUG - so we
// resolve id → slug via GET /organizations. The org home itself
// (src/app/[orgSlug]/page.tsx) then applies the role-appropriate redirect
// (overview vs project dashboard).
//
// Error surface: if the orgs lookup fails (session expired, backend down,
// DB misconfigured), we render @paalstack/react-ui's ErrorInternalServer
// with a retry - never an infinite skeleton.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useOrgSlugForId } from '@/hooks/queries/organizations';
import { useSessionUser } from '@/lib/session';
import { PORTAL_HOME, isPortalRole } from '@/lib/portal-routing';
import { PageLoading } from '@/components/shared/PageLoading';
import { PageError } from '@/components/shared/PageError';

export default function OrgRootRedirectPage() {
  const router = useRouter();
  const { user, isPending } = useSessionUser();
  const { orgSlug, isPending: orgsPending, error: orgsError } = useOrgSlugForId(
    user?.organizationId ?? null,
  );

  useEffect(() => {
    if (isPending) return;
    // Issue #8: a buyer has no staff org home; send them to the portal before
    // the (staff) org lookup, which they have no reason to wait on or fail on.
    if (user !== null && isPortalRole(user.role)) {
      router.replace(PORTAL_HOME);
      return;
    }
    if (orgsPending) return;
    if (orgsError !== null) return; // error UI takes over below
    if (user === null || !user.organizationId) {
      router.replace('/login');
      return;
    }
    if (orgSlug === null) return;
    router.replace(`/${orgSlug}`);
  }, [isPending, orgsPending, orgsError, user, orgSlug, router]);

  // Session still resolving → skeleton.
  if (isPending) return <PageLoading content="Loading workspace..." />;

  // Orgs lookup failed → real error state with retry (staff only: a buyer is
  // already being redirected and must not see a staff error).
  if (orgsError !== null && !isPortalRole(user?.role)) {
    const message =
      orgsError instanceof Error ? orgsError.message : 'Could not load your organization';
    return (
      <PageError
        error={orgsError instanceof Error ? orgsError : new Error(message)}
        onRefresh={() => {
          router.refresh();
          window.location.reload();
        }}
      />
    );
  }

  return <PageLoading content="Loading workspace..." />;
}
