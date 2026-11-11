'use client';

// /site (2026-11-08): the site engineer's home. Replaces Inventory for the site
// roles, which is a sales surface full of rupees.
//
// Data: ONE scoped call (`GET /customer-progress/site-units`, capped at 200).
// The SERVER decides whose villas come back: the engineer's assigned villas, the
// villas assigned to engineers on a manager's teams, or every villa for
// admin/owner. Counts are computed client-side; when the list is capped the page
// says so instead of printing a number that lies.
//
// Role gate: a user without `canViewSiteUpdates` is redirected to `/dashboard`,
// not shown a 403. They are not forbidden, they are in the wrong place.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { SiteHome } from '@/components/site/SiteHome';
import { useSiteUnits } from '@/hooks/queries/inventory';
import { projectHref } from '@/lib/nav';
import { canViewSiteUpdates, useSessionUser } from '@/lib/session';
import { useOrgSlug, useProjectId, useProjectSlug, useProject } from '@/lib/tenant-context';
import { defaultSiteFilter, isCapped, siteCounts, type SiteFilter } from '@/lib/site-units';

export default function SiteHomePage() {
  const router = useRouter();
  const { user, isPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const projectId = useProjectId();
  const project = useProject();

  // better-auth resolves the cookie synchronously on the client but reports
  // isPending during SSR; without the gate the server HTML renders a redirect
  // for a signed-in engineer (same pattern as the inventory page's `mounted`).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && !isPending && user !== null && !canViewSiteUpdates(user.role)) {
      router.replace(projectHref(orgSlug, projectSlug, '/dashboard'));
    }
  }, [mounted, isPending, user, router, orgSlug, projectSlug]);

  const unitsQuery = useSiteUnits(projectId ?? undefined);
  const rows = unitsQuery.data?.rows ?? [];
  const scope = unitsQuery.data?.scope ?? null;
  const capped = isCapped(rows.length) || (unitsQuery.data?.total ?? 0) > rows.length;

  // `now` is captured once per mount so the four-state map and the relative
  // phrases do not flicker between renders. A re-mount refreshes it.
  const [now] = useState(() => new Date());

  const [filter, setFilter] = useState<SiteFilter | null>(null);
  const [search, setSearch] = useState('');
  const counts = useMemo(() => siteCounts(rows, now), [rows, now]);
  const activeFilter = filter ?? defaultSiteFilter(counts);

  const title = project?.name ?? '';

  return (
    <SiteHome
      projectName={title}
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      rows={rows}
      isLoading={!mounted || unitsQuery.isLoading}
      isError={unitsQuery.error !== null && unitsQuery.error !== undefined}
      onRetry={() => void unitsQuery.refetch()}
      filter={activeFilter}
      onFilterChange={setFilter}
      search={search}
      onSearchChange={setSearch}
      capped={capped}
      scope={scope}
      canCapture={unitsQuery.data?.canCapture ?? false}
      now={now}
    />
  );
}
