'use client';

// Work landing used when leaving Admin. Sends OWNER/ADMIN (and anyone
// else who hits this URL) to their role's default project work surface -
// Dashboard for most roles, Inventory for ENGINEER (site engineer, the only
// Work surface that role can see). Empty registry shows a work-side empty
// state - never the admin project registry.
import { Button, Heading, TypographyP } from '@paalstack/react-ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { workLandingHref } from '@/lib/dashboard-redirect';
import { orgHref } from '@/lib/nav';
import { useSessionUser } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';
import { Skeleton } from '@/components/shared/Skeleton';
import Link from 'next/link';

export default function WorkLandingPage() {
  const router = useRouter();
  const orgSlug = useOrgSlug();
  const { data: projects, isPending } = useProjects();
  const { user, isPending: sessionPending } = useSessionUser();
  const project = pickDefaultProject(projects ?? []);

  useEffect(() => {
    if (isPending || sessionPending) return;
    if (orgSlug === null || project === null) return;
    // Role-aware: ENGINEER lands on Inventory, everyone else on Dashboard.
    router.replace(workLandingHref(orgSlug, projects ?? [], user?.role));
  }, [isPending, sessionPending, orgSlug, project, projects, user, router]);

  if (isPending || sessionPending) {
    return <Skeleton variant="overview" className="py-4" />;
  }

  if (project !== null) {
    return <Skeleton variant="overview" className="py-4" />;
  }

  return (
    <div className="py-4 text-center text-sm">
      <Heading className="mb-2">No projects yet</Heading>
      <TypographyP className="text-muted-foreground">
        There is no project to open in Work. Create one from Admin when you have access.
      </TypographyP>
      <Button as={Link} href={orgHref(orgSlug ?? '', '/admin/projects')} className="mt-4">
        Create Project
      </Button>
    </div>
  );
}
