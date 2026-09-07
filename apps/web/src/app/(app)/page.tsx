'use client';

// Authenticated `/` is not a work surface. Dashboard, leads, visits,
// inventory, bookings, and notifications live under `/{projectId}/…`.
// Bounce to the default project's dashboard (or /projects if the
// registry is empty).
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { Skeleton } from '@/components/shared/Skeleton';
import { projectHref } from '@/lib/nav';

export default function AppHomePage() {
  const router = useRouter();
  const { data: projects, isPending } = useProjects();

  useEffect(() => {
    if (isPending) return;
    const project = pickDefaultProject(projects ?? []);
    if (project !== null) {
      router.replace(projectHref(project.id, '/dashboard'));
      return;
    }
    router.replace('/projects');
  }, [isPending, projects, router]);

  return <Skeleton variant="user" className="py-24" />;
}
