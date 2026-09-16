'use client';

// Work landing used when leaving Admin. Sends OWNER/ADMIN (and anyone
// else who hits this URL) to the default project dashboard. Empty
// registry shows a work-side empty state — never the admin project registry.
import { Button, Heading, TypographyP } from '@paalstack/react-ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { orgHref, projectHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';
import { Skeleton } from '@/components/shared/Skeleton';
import Link from 'next/link';

export default function WorkLandingPage() {
  const router = useRouter();
  const orgSlug = useOrgSlug();
  const { data: projects, isPending } = useProjects();
  const project = pickDefaultProject(projects ?? []);

  useEffect(() => {
    if (isPending) return;
    if (orgSlug === null || project === null) return;
    router.replace(projectHref(orgSlug, project.slug, '/dashboard'));
  }, [isPending, orgSlug, project, router]);

  if (isPending) {
    return <Skeleton variant="overview" className="py-4" />;
  }

  if (project !== null) {
    return <Skeleton variant="overview" className="py-4" />;
  }

  return (
    <div className="py-24 text-center text-sm">
      <Heading className="mb-2">No projects yet</Heading>
      <TypographyP className="text-muted-foreground">
        There is no project to open in Work. Create one from Admin when you
        have access.
      </TypographyP>
      <Button as={Link} href={orgHref(orgSlug ?? '', '/admin/projects')} className="mt-4">Create Project</Button>
    </div>
  );
}
