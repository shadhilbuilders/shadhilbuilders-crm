'use client';

// Authenticated `/` is not a work surface. Dashboard, leads, visits,
// inventory, bookings, and notifications live under `/{projectId}/...`.
// Bounce to the role-appropriate dashboard (decision in
// lib/dashboard-redirect.ts):
//   - Admin/owner → /overview (cross-project command center)
//   - Everyone else → /{projectId}/dashboard (project work dashboard)
//   - Empty project registry → /projects
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useProjects } from '@/hooks/queries';
import { Skeleton } from '@/components/shared/Skeleton';
import { useSessionUser } from '@/lib/session';
import { rootRedirectTarget } from '@/lib/dashboard-redirect';

export default function AppHomePage() {
  const router = useRouter();
  const { data: projects, isPending } = useProjects();
  const { user, isPending: sessionPending } = useSessionUser();

  useEffect(() => {
    if (isPending || sessionPending) return;
    const target = rootRedirectTarget(user, projects ?? []);
    switch (target.kind) {
      case 'login':
        router.replace('/login');
        break;
      case 'command-center':
        router.replace('/overview');
        break;
      case 'project-dashboard':
        router.replace(target.href);
        break;
      case 'projects':
        router.replace('/projects');
        break;
    }
  }, [isPending, sessionPending, projects, user, router]);

  return <Skeleton variant="user" className="py-24" />;
}
