'use client';

// Admin/owner command center (dashboard split, 2026-09-08).
//
// Cross-project overview at the top-level /overview. Because this route
// carries NO project segment, the pipeline/visits queries run unscoped and
// return data across ALL projects (verified: RLS policies lead_select_admin,
// site_visit_select_team admin branch, and auditlog_select_admin_or_owner have
// no project filter — an unscoped admin query returns all projects).
//
// H1 audit note: the per-project audit context is intentionally dropped from
// the project work dashboard (admin/owner see the Manager view there). The
// global /audit page is the audit path; this command center's audit timeline
// is cross-project.
//
// LOW-1: the isAdminLike guard below is a UX mirror, NOT a security boundary.
// The real data boundary is RLS. Do not "harden" this guard by removing RLS
// reliance — the server is the wall.

import { Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ChartCard } from '@/components/shared/ChartCard';
import { Skeleton } from '@/components/shared/Skeleton';
import { canViewAudit, useSessionUser } from '@/lib/session';
import type { Role } from '@/apis/client';
import { useAuditLog, useLeads, useVisits } from '@/hooks/queries/crm';
import { PipelineFunnelChart } from '@/components/charts/PipelineFunnelChart';
import { VisitsThisWeekChart } from '@/components/charts/VisitsThisWeekChart';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { projectHref } from '@/lib/nav';
import { commandCenterRedirectTarget } from '@/lib/dashboard-redirect';
import {
  AuditTimeline,
  KpiStrip,
  SectionCard,
} from '@/components/dashboard/dashboard-shared';

export default function AdminDashboardPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const { data: projects } = useProjects();

  if (sessionPending) return <Skeleton variant="user" className="py-24" />;
  if (user === null) {
    return (
      <div className="py-24 text-center text-sm">
        Session expired.{' '}
        <Link href="/login" className="underline">Sign in again</Link>.
      </div>
    );
  }
  // Design fix M1: redirect non-admins to the project work dashboard (no
  // dead-end). Guard the empty-registry loop (eng CRITICAL-2): if no
  // default project, go to /projects — otherwise projectHref(null, ...)
  // returns /overview and the redirect loops forever.
  const redirectTarget = commandCenterRedirectTarget(user.role, projects ?? []);
  if (redirectTarget !== null) {
    return <RedirectToProject href={redirectTarget} />;
  }
  // Pass the REAL role (OWNER travels as admin-class) into the visibility
  // checks — never hardcode 'ADMIN' (design M4).
  return (
    <AdminDashboard
      role={user.role}
      defaultProjectId={pickDefaultProject(projects ?? [])?.id ?? null}
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
// Admin command center (Wireframes #3) - cross-project pipeline + visits + audit
// ---------------------------------------------------------------------------

function AdminDashboard({
  role,
  defaultProjectId,
}: {
  role: Role;
  defaultProjectId: string | null;
}) {
  // Unscoped queries (no projectId) → all projects. limit caps the overview.
  const leadsQuery = useLeads({ limit: 200 });
  const visitsQuery = useVisits({ limit: 200 });
  const usersVisible = canViewAudit(role);
  const auditVisible = canViewAudit(role);
  const auditQuery = useAuditLog({ limit: 200 });

  return (
    <div className="space-y-8">
      <div>
        {/* H2 naming fix: "Overview" matches the nav label — one name. */}
        <Heading className="mb-1">Overview</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          All teams, all activity.
        </TypographyP>
      </div>

      <KpiStrip
        items={[
          { label: 'Total leads', value: '-', sub: 'all teams' },
          { label: 'Reassignments (7d)', value: '-' },
          { label: 'Audit events (24h)', value: '-' },
          { label: 'Users by role', value: '-', sub: usersVisible ? 'manage in Users' : undefined },
        ]}
      />

      {/* CEO C2 fix: "See all" resolves against the default project so it
          links to a real /{projectId}/leads route. Drop the link if no
          default project exists. */}
      <SectionCard
        title="Cross-team pipeline"
        moreHref={
          defaultProjectId !== null
            ? projectHref(defaultProjectId, '/leads')
            : undefined
        }
      >
        <ChartCard
          title="Lead pipeline (all teams)"
          description="Cross-team distribution of leads by status. The leads module (Week 4) provides the data."
          query={leadsQuery}
        >
          {(data) => <PipelineFunnelChart data={data} />}
        </ChartCard>
      </SectionCard>

      <SectionCard
        title="Visits this week"
        moreHref={
          defaultProjectId !== null
            ? projectHref(defaultProjectId, '/visits')
            : undefined
        }
      >
        <ChartCard
          title="Visits this week"
          description="Site visits across all teams, per day. Arrives with the visits module (Week 6)."
          query={visitsQuery}
        >
          {(data) => <VisitsThisWeekChart data={data} />}
        </ChartCard>
      </SectionCard>

      {auditVisible ? (
        <SectionCard title="Audit activity (last 7 days)" moreHref="/audit">
          <ChartCard
            title="Audit timeline"
            description="Audit events bucketed by day, admin-class only. The audit writer (Week 7) provides the data."
            query={auditQuery}
          >
            {(data) => <AuditTimeline data={data} />}
          </ChartCard>
        </SectionCard>
      ) : null}
    </div>
  );
}
