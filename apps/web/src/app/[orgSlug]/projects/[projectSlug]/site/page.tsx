'use client';

// /site (2026-11-08): the site engineer's home. Replaces Inventory for the site
// roles, which is a sales surface full of rupees.
//
// Data: ONE call for up to 200 units (the server's cap, `UnitFilterDto`). A
// villa project fits inside it, so the counts are computed client-side; when the
// list comes back at exactly 200 the page says "Showing the first 200 units"
// instead of printing a number that lies.
//
// Role gate: a user without `isSiteRole` is redirected to `/inventory`, not
// shown a 403. They are not forbidden, they are in the wrong place.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { SiteHome } from '@/components/site/SiteHome';
import { useInventoryUnits } from '@/hooks/queries/inventory';
import { projectHref } from '@/lib/nav';
import { isSiteRole, useSessionUser } from '@/lib/session';
import { useOrgSlug, useProjectId, useProjectSlug, useProject } from '@/lib/tenant-context';
import { defaultSiteFilter, isCapped, SITE_LIST_CAP, siteCounts, type SiteFilter } from '@/lib/site-units';

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
    if (mounted && !isPending && user !== null && !isSiteRole(user.role)) {
      router.replace(projectHref(orgSlug, projectSlug, '/inventory'));
    }
  }, [mounted, isPending, user, router, orgSlug, projectSlug]);

  const unitsQuery = useInventoryUnits({
    projectId: projectId ?? undefined,
    limit: SITE_LIST_CAP,
  });
  const rows = unitsQuery.data ?? [];
  const capped = isCapped(rows.length);

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
      now={now}
    />
  );
}
