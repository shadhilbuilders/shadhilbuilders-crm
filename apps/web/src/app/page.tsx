'use client';

// Root redirect for the slug-based multi-tenant path scheme (2026-09-11).
//
// Every authenticated route lives under `/[orgSlug]/...`. The bare `/` (the
// proxy's post-login target) has no page of its own, so bounce to the org
// home. The session exposes ORG ID, but the URL needs the ORG SLUG — so we
// resolve id → slug via GET /organizations. The org home itself
// (src/app/[orgSlug]/page.tsx) then applies the role-appropriate redirect
// (overview vs project dashboard).
//
// Error surface: if the orgs lookup fails (session expired, backend down,
// DB misconfigured), we render @paalstack/react-ui's ErrorInternalServer
// with a retry — never an infinite skeleton.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { ErrorInternalServer, Loading } from '@paalstack/react-ui';

import { Skeleton } from '@/components/shared/Skeleton';
import { useOrgSlugForId } from '@/hooks/queries/organizations';
import { useSessionUser } from '@/lib/session';

export default function OrgRootRedirectPage() {
  const router = useRouter();
  const { user, isPending } = useSessionUser();
  const { orgSlug, isPending: orgsPending, error: orgsError } = useOrgSlugForId(
    user?.organizationId ?? null,
  );

  useEffect(() => {
    if (isPending || orgsPending) return;
    if (orgsError !== null) return; // error UI takes over below
    if (user === null || !user.organizationId) {
      router.replace('/login');
      return;
    }
    if (orgSlug === null) return;
    router.replace(`/${orgSlug}`);
  }, [isPending, orgsPending, orgsError, user, orgSlug, router]);

  // Session still resolving → skeleton.
  if (isPending) return <Skeleton variant="overview" className="py-4" />;

  // Orgs lookup failed → real error state with retry.
  if (orgsError !== null) {
    const message =
      orgsError instanceof Error ? orgsError.message : 'Could not load your organization';
    return (
      <ErrorInternalServer
        error={orgsError instanceof Error ? orgsError : new Error(message)}
        showErrorMessage
        goBackText="Go back"
        refreshText="Try again"
        onRefresh={() => {
          router.refresh();
          window.location.reload();
        }}
      />
    );
  }

  return <div className="flex min-h-[80vh] w-full items-center justify-center">
  <Loading content="Loading workspace..." className='text-foreground' spinnerProps={{ size: 'lg' }} />
</div>;
}
