'use client';

// /[projectId]/inventory/phases - phases & options management page.
//
// Renders three management cards (Phases, Facing, BHK) in a responsive grid:
// 1 column on mobile, 2 on md, 3 on lg. MANAGER/ADMIN/OWNER can add/rename/
// delete phases and add/delete options; other roles see the cards read-only.
// The PhasesSection + FacingOptionsCard/BhkOptionsCard components own the
// list + dialogs; this page wires them to the project-scoped queries and the
// session role gate.
import { useEffect, useState } from 'react';

import { Skeleton } from '@/components/shared/Skeleton';
import { PhasesSection } from '@/components/inventory/PhasesSection';
import { FacingOptionsCard, BhkOptionsCard } from '@/components/inventory/ProjectOptionsSection';
import { useInventoryPhases, useProjectOptions } from '@/hooks/queries/inventory';
import { projectHref } from '@/lib/nav';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { useSessionUser, canManageProjectMembers } from '@/lib/session';

import { PageHeader } from '@/components/shared/PageHeader';

export default function PhasesPage() {
  const { user } = useSessionUser();
  // T-ProjectSwitch: resolved project from tenant context; id keys API,
  // slugs key hrefs.
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

  // Hydration gate (same pattern as the inventory page): better-auth's
  // useSession reports isPending=true during SSR, so gate the role-dependent
  // actions on a mounted flag to avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const phasesQuery = useInventoryPhases(projectId ?? undefined);
  const phases = phasesQuery.data ?? [];

  const optionsQuery = useProjectOptions(projectId ?? undefined);
  const options = optionsQuery.data ?? [];

  const canManage =
    mounted && user !== null && canManageProjectMembers(user.role);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phases"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Inventory', href: projectHref(orgSlug, projectSlug, '/inventory') },
          { label: 'Phases' },
        ]}
        subtitle="Manage the phases, facing options, and BHK options in this project."
      />

      {phasesQuery.isLoading ? (
        <Skeleton variant="table" isOffline={false} />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          <PhasesSection
            phases={phases}
            projectId={projectId}
            canManage={canManage}
          />
          <FacingOptionsCard
            options={options}
            projectId={projectId}
            canManage={canManage}
          />
          <BhkOptionsCard
            options={options}
            projectId={projectId}
            canManage={canManage}
          />
        </div>
      )}
    </div>
  );
}
