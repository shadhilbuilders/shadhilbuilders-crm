'use client';

// Per-project Teams page - manage the working staff linked to THIS project.
//
// Lives under the active project (/[projectId]/teams) so it switches with
// the project switcher and is a work-surface route. Reuses ProjectMembersBody
// (the same link/unlink UI as the admin Projects page's "Manage staff"
// dialog) so there's exactly one member-management surface.
import { useParams } from 'next/navigation';

import { useProjects } from '@/hooks/queries';
import { canManageProjectMembers, useSessionUser } from '@/lib/session';

import { Skeleton } from '@/components/shared/Skeleton';
import { ProjectMembersBody } from '@/components/projects/project-form-bodies';
import { PageHeader } from '@/components/shared/PageHeader';

export default function ProjectTeamsPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const params = useParams<{ projectId: string }>();
  const projectId =
    typeof params?.projectId === 'string' ? params.projectId : null;
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId) ?? null;

  // MANAGER/ADMIN/OWNER can link/unlink members; staff (TELECALLER/SALES_EXEC)
  // are view-only on this project's workspace.
  const canManage = canManageProjectMembers(user?.role);

  if (sessionPending || projectId === null) {
    return <Skeleton variant="users" className="py-24" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Teams"
        breadcrumb={[{ label: 'Work' }, { label: 'Teams' }]}
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
          onDone={() => {}}
        />
      </div>
    </div>
  );
}
