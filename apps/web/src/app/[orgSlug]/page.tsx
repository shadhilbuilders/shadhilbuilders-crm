'use client';

// Authenticated org-home `/` is not a work surface. Dashboard, leads,
// visits, inventory, bookings, and notifications live under
// `/[orgSlug]/projects/[projectSlug]/...`. Bounce to the role-appropriate
// dashboard (decision in lib/dashboard-redirect.ts):
//   - Admin/owner → /{orgSlug}/overview (cross-project command center)
//   - Everyone else → /{orgSlug}/projects/{projectSlug}/dashboard
//   - Empty project registry → /{orgSlug}/projects
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useProjects } from '@/hooks/queries';
import { useSessionUser } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';
import { rootRedirectTarget } from '@/lib/dashboard-redirect';
import { Loading } from '@paalstack/react-ui';

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
        router.replace(orgSlug ? `/${orgSlug}/overview` : '/overview');
        break;
      case 'project-dashboard':
        router.replace(target.href);
        break;
      case 'projects':
        router.replace(orgSlug ? `/${orgSlug}/projects` : '/projects');
        break;
    }
  }, [isPending, sessionPending, projects, user, router, orgSlug]);

  return  <div className="flex min-h-[60vh] w-full items-center justify-center">
        <Loading content="Loading workspace..." spinnerProps={{ size: 'lg' }} />
  </div>;
}
