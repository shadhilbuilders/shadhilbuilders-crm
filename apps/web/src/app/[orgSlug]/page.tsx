'use client';

// Authenticated org-home `/` is not a work surface. Dashboard, leads,
// visits, inventory, bookings, and notifications live under
// `/[orgSlug]/projects/[projectSlug]/...`. Bounce to the role-appropriate
// dashboard (decision in lib/dashboard-redirect.ts):
//   - Admin/owner → /{orgSlug}/admin (cross-project command center)
//   - Everyone else → /{orgSlug}/projects/{projectSlug}/dashboard
//   - Empty project registry → /{orgSlug}/work
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useProjects } from '@/hooks/queries';
import { useSessionUser } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';
import { rootRedirectTarget } from '@/lib/dashboard-redirect';
import { PageLoading } from '@/components/shared/PageLoading';

export default function AppHomePage() {
  const router = useRouter();
  const { data: projects, isPending } = useProjects();
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();

  useEffect(() => {
    if (isPending || sessionPending) return;
    const target = rootRedirectTarget(user, projects ?? [], orgSlug);
    switch (target.kind) {
      case 'login':
        router.replace('/login');
        break;
      case 'command-center':
        router.replace(orgSlug ? `/${orgSlug}/admin` : '/admin');
        break;
      case 'project-dashboard':
        router.replace(target.href);
        break;
      case 'work':
        router.replace(target.href);
        break;
    }
  }, [isPending, sessionPending, projects, user, router, orgSlug]);

  return <PageLoading content="Loading workspace..." minHeight="section" />;
}
