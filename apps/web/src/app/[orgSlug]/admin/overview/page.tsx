'use client';

// Admin/owner command center (dashboard split, 2026-09-08; real-data wiring
// autoplan 2026-09-08).
//
// Cross-project overview at the top-level /overview. Because this route
// carries NO project segment, the overview stats run unscoped and return data
// across ALL projects (verified: RLS policies lead_select_admin,
// site_visit_select_team admin branch, and auditlog_select_admin_or_owner have
// no project filter - an unscoped admin query returns all projects).
//
// Real-data wiring (autoplan 2026-09-08): the placeholder KPIs are replaced
// with REAL numbers from GET /api/dashboard/overview (one role-scoped
// aggregate query, ADMIN/OWNER only). The endpoint enforces the role guard
// server-side (403 for staff).
//
// LOW-1: the isAdminLike guard below is a UX mirror, NOT a security boundary.
// The real data boundary is RLS + the service guard. Do not "harden" this
// guard by removing RLS reliance - the server is the wall.

import { Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ChartCard } from '@/components/shared/ChartCard';
import { Skeleton } from '@/components/shared/Skeleton';
import { canViewAudit, useSessionUser } from '@/lib/session';
import type { Role } from '@/apis/client';
import { useVisits } from '@/hooks/queries/crm';
import { useDashboardOverview } from '@/hooks/queries/dashboard';
import { PipelineFunnelChart } from '@/components/charts/PipelineFunnelChart';
import { VisitsThisWeekChart } from '@/components/charts/VisitsThisWeekChart';
import { OverviewAuditAreaChart } from '@/components/charts/OverviewAuditAreaChart';
import { OverviewSectionCards } from '@/components/dashboard/overview-section-cards';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { projectHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';
import { commandCenterRedirectTarget } from '@/lib/dashboard-redirect';
import { SectionCard } from '@/components/dashboard/dashboard-shared';

export default function AdminDashboardPage() {
  const orgSlug = useOrgSlug();
  const { user, isPending: sessionPending } = useSessionUser();
  const { data: projects } = useProjects();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // dashboard → "Hydration failed because the server rendered HTML didn't
  // match the client." Render the skeleton for the first client paint too,
  // then swap after mount (same pattern as app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) return <Skeleton variant="overview" className="py-4" />;
  if (user === null) {
    return (
      <div className="py-24 text-center text-sm">
        Session expired.{' '}
        <Link href="/login" className="underline">
          Sign in again
        </Link>
        .
      </div>
    );
  }
  // Design fix M1: redirect non-admins to the project work dashboard (no
  // dead-end). Guard the empty-registry loop (eng CRITICAL-2): if no
  // default project, go to /projects - otherwise projectHref(null, ...)
  // returns /overview and the redirect loops forever.
  const redirectTarget = commandCenterRedirectTarget(
    user.role,
    projects ?? [],
    orgSlug,
  );
  if (redirectTarget !== null) {
    return <RedirectToProject href={redirectTarget} />;
  }
  // Pass the REAL role (OWNER travels as admin-class) into the visibility
  // checks - never hardcode 'ADMIN' (design M4).
  const defaultProject = pickDefaultProject(projects ?? []);
  return (
    <AdminDashboard
      orgSlug={orgSlug}
      role={user.role}
      defaultProjectSlug={defaultProject?.slug ?? null}
    />
  );
}

/** Redirect a non-admin away from /overview. */
function RedirectToProject({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return <Skeleton variant="user" className="py-24" />;
}

// ---------------------------------------------------------------------------
// Admin command center (Wireframes #3) - cross-project KPIs + pipeline + visits
// ---------------------------------------------------------------------------

function AdminDashboard({
  orgSlug,
  role,
  defaultProjectSlug,
}: {
  orgSlug: string | null;
  role: Role;
  defaultProjectSlug: string | null;
}) {
  const overviewQuery = useDashboardOverview();
  const visitsQuery = useVisits({ limit: 200 });
  const auditVisible = canViewAudit(role);
  const overview = overviewQuery.data;
  const overviewLoading = overviewQuery.isLoading;
  const overviewError = overviewQuery.error;

  return (
    <div className="space-y-8">
      <div>
        {/* H2 naming fix: "Overview" matches the nav label - one name. */}
        <Heading className="mb-1">Overview</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          All teams, all activity.
        </TypographyP>
      </div>

      {overviewLoading ? (
        <Skeleton variant="overview" aria-label="Loading overview KPIs" />
      ) : overview ? (
        <OverviewSectionCards overview={overview} />
      ) : null}

      {overviewError !== null && overviewError !== undefined ? (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
        >
          <p className="font-semibold">Overview data unavailable</p>
          <p className="mt-1 opacity-90">
            {overviewError instanceof Error
              ? overviewError.message
              : 'Could not load the overview. Please try again.'}
          </p>
        </div>
      ) : null}

      {/* CEO C2 fix: "See all" resolves against the default project so it
          links to a real /{projectId}/leads route. Drop the link if no
          default project exists. */}
      <SectionCard
        title="Cross-team pipeline"
        moreHref={defaultProjectSlug !== null ? projectHref(orgSlug, defaultProjectSlug, '/leads') : undefined}
      >
        <ChartCard
          title="Lead pipeline (all teams)"
          description="Cross-team distribution of leads by status."
          query={overviewQuery}
        >
          {(data) => <PipelineFunnelChart data={data.pipeline} />}
        </ChartCard>
      </SectionCard>

      <SectionCard
        title="Visits this week"
        moreHref={defaultProjectSlug !== null ? projectHref(orgSlug, defaultProjectSlug, '/visits') : undefined}
      >
        <ChartCard
          title="Visits this week"
          description="Site visits across all teams, per day."
          query={visitsQuery}
        >
          {(data) => <VisitsThisWeekChart data={data} />}
        </ChartCard>
      </SectionCard>

      {auditVisible ? (
        <SectionCard
          title="Audit activity"
          moreHref={orgSlug ? `/${orgSlug}/admin/audit` : '/admin/audit'}
        >
          <OverviewAuditAreaChart data={overviewQuery.data?.auditTimeline} />
        </SectionCard>
      ) : null}
    </div>
  );
}
