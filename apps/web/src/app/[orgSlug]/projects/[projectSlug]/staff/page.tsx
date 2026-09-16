'use client';

// Per-project Staff page - T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit
// Trail #39, design doc UI3). Projects link to TEAMS, never directly to
// users: this page is now a grouped ProjectTeam view (ProjectTeamList),
// replacing the per-user ProjectMembersBody link/unlink surface. Staff
// members shown here are team-derived only.
import { useProjects } from '@/hooks/queries';
import { isAdminLike, useSessionUser } from '@/lib/session';

import { Skeleton } from '@/components/shared/Skeleton';
import { ProjectTeamList } from '@/components/teams/project-team-list';
import { PageHeader } from '@/components/shared/PageHeader';
import { useProjectId } from '@/lib/tenant-context';

export default function ProjectStaffPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const projectId = useProjectId();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId) ?? null;

  // Staff page is viewable by EVERYONE (any authenticated role sees the
  // linked-team roster read-only). Only ADMIN/OWNER can link/unlink teams
  // (design doc authorization matrix - stricter than the legacy per-user
  // ProjectMember's MANAGER-inclusive capability).
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
            ? `Teams linked to ${project.name}.`
            : 'Teams linked to this project.'
        }
      />
      <div className="border-border rounded-lg border p-4">
        <ProjectTeamList
          projectId={projectId}
          projectName={project?.name ?? 'this project'}
          projectSlug={project?.slug ?? ''}
          canManage={canManage}
        />
      </div>
    </div>
  );
}
