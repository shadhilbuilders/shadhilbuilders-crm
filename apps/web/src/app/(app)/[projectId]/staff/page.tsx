'use client';

// Per-project Staff page - manage the working staff linked to THIS project.
//
// Lives under the active project (/[projectId]/staff) so it switches with
// the project switcher and is a work-surface route. Reuses ProjectMembersBody
// (the same link/unlink UI as the admin Projects page's "Manage staff"
// dialog) so there's exactly one member-management surface.
import { useParams } from 'next/navigation';

import { useProjects } from '@/hooks/queries';
import { isAdminLike, useSessionUser } from '@/lib/session';

import { Skeleton } from '@/components/shared/Skeleton';
import { ProjectMembersBody } from '@/components/projects/project-form-bodies';
import { PageHeader } from '@/components/shared/PageHeader';

export default function ProjectStaffPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const params = useParams<{ projectId: string }>();
  const projectId =
    typeof params?.projectId === 'string' ? params.projectId : null;
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId) ?? null;

  // Staff page is viewable by EVERYONE (any authenticated role sees member
  // items). Only ADMIN/OWNER can link/unlink; others see Items read-only.
  const canManage = isAdminLike(user?.role);

  if (sessionPending || projectId === null) {
    return <Skeleton variant="users" className="py-24" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff"
        breadcrumb={[{ label: 'Work' }, { label: 'Staff' }]}
        subtitle={
          project !== null
            ? `Staff linked to ${project.name}.`
            : 'Staff linked to this project.'
        }
      />
      <div className="border-border rounded-lg border p-4">
        <ProjectMembersBody
          project={
            project ?? {
              id: projectId,
              slug: '',
              name: 'This project',
              address: '',
              reraNumber: null,
              cmdaNumber: null,
              createdAt: new Date().toISOString(),
            }
          }
          canManage={canManage}
          embedded
          onDone={() => {}}
        />
      </div>
    </div>
  );
}
