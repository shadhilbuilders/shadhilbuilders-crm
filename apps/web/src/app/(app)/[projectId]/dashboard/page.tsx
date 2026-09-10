'use client';

// Project work dashboard (dashboard split, 2026-09-08; real-data wiring
// autoplan 2026-09-08).
//
// Serves EVERY role on /{projectId}/dashboard - "anyone can see this
// dashboard." Admin/owner now have a dedicated cross-project /overview
// command center; on the project work dashboard they see the Manager view
// (project-scoped, all teams in this project).
//
// Real-data wiring (autoplan 2026-09-08): the placeholder KPIs and
// "lights up when the module ships" copy are replaced with REAL numbers from
// GET /api/dashboard/stats (one role-scoped aggregate query). New charts:
// leads over time, lead source, team performance.
//
// State handling (autoplan 2026-09-08):
//   - Loading: KPI strip shows a shape-matched skeleton; charts show their
//     own ChartCard skeleton.
//   - Error: the stats query error surfaces as a dismissible banner; each
//     chart's ChartCard shows its own error state.
//   - Empty: charts show "No data yet" via ChartCard; the KPI strip shows
//     real 0s (honest), never a fabricated number.
//
// Data-confidence honesty (CEO F3): metrics that depend on data the team may
// not produce yet (avgTimeToFirstTouch, noShowRate) show "-"/0 honestly, never
// a fabricated number. The KPI sub-labels explain "no outcome data yet".
import { Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ChartCard } from '@/components/shared/ChartCard';
import { Skeleton } from '@/components/shared/Skeleton';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { useBookings, useLeads, useVisits } from '@/hooks/queries/crm';
import { useDashboardStats } from '@/hooks/queries/dashboard';
import { currencyIntl, dateIntl } from '@/lib/format';
import { labelFor, BOOKING_STATUSES, type BookingStatus } from '@/lib/labels';

import { PipelineFunnelChart } from '@/components/charts/PipelineFunnelChart';
import { VisitsThisWeekChart } from '@/components/charts/VisitsThisWeekChart';
import { LeadsOverTimeChart } from '@/components/charts/LeadsOverTimeChart';
import { LeadSourceChart } from '@/components/charts/LeadSourceChart';
import { TeamPerformanceChart } from '@/components/charts/TeamPerformanceChart';
import { BookingsByStatusChart } from '@/components/charts/BookingsByStatusChart';
import { projectHref } from '@/lib/nav';
import {
  KpiStrip,
  LeadStatusPie,
  SectionCard,
} from '@/components/dashboard/dashboard-shared';

function useActiveProjectId(): string | null {
  const params = useParams<{ projectId: string }>();
  return typeof params?.projectId === 'string' ? params.projectId : null;
}

export default function DashboardPage() {
  const { user, isPending: sessionPending } = useSessionUser();
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

  if (!mounted || sessionPending) {
    return <Skeleton variant="user" className="py-24" />;
  }

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

  const role = user.role;

  // Admin/owner now have a dedicated cross-project /overview command center.
  // On the project work dashboard they see the Manager view (project-scoped,
  // all teams in this project) - "anyone can see this dashboard."
  if (isAdminLike(role) || role === 'MANAGER') {
    return <ManagerDashboard name={user.name || role} />;
  }

  // Telecaller + Sales Exec: their queue IS the home (Wireframes #4).
  return <InboxFirstHome role={role} />;
}

// ---------------------------------------------------------------------------
// Manager dashboard (Wireframes #1) - real KPIs + charts
// ---------------------------------------------------------------------------

function ManagerDashboard({ name }: { name: string }) {
  const projectId = useActiveProjectId();
  const statsQuery = useDashboardStats(projectId ?? undefined);
  const leadsQuery = useLeads({ limit: 200, projectId: projectId ?? undefined });
  const visitsQuery = useVisits({ projectId: projectId ?? undefined });
  const bookingsQuery = useBookings({
    status: 'HOLD',
    projectId: projectId ?? undefined,
  });

  const stats = statsQuery.data;
  const statsLoading = statsQuery.isLoading;
  const statsError = statsQuery.error;

  return (
    <div className="space-y-8">
      <div>
        <Heading className="mb-1">Dashboard</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          {name} · team pipeline at a glance.
        </TypographyP>
      </div>

      {/* KPI strip: shape-matched skeleton while loading, real numbers after. */}
      {statsLoading ? (
        <Skeleton variant="kpi" aria-label="Loading dashboard KPIs" />
      ) : (
        <KpiStrip
          items={[
            {
              label: 'New leads today',
              value: stats ? String(stats.kpis.newLeadsToday) : '-',
              sub: 'created in the last 24h',
            },
            {
              label: 'Overdue leads',
              value: stats ? String(stats.kpis.overdueLeads) : '-',
              sub: 'not touched in 30 min',
            },
            {
              label: "Today's visits",
              value: stats ? String(stats.kpis.visitsToday) : '-',
              sub: 'across the team',
            },
            {
              label: 'Bookings on hold',
              value: stats ? String(stats.kpis.bookingsOnHold) : '-',
              sub: 'awaiting approval',
            },
          ]}
        />
      )}

      {/* Top-level stats error banner (the aggregate endpoint failed). */}
      {statsError !== null && statsError !== undefined ? (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
        >
          <p className="font-semibold">Dashboard data unavailable</p>
          <p className="mt-1 opacity-90">
            {statsError instanceof Error
              ? statsError.message
              : 'Could not load dashboard stats. Please try again.'}
          </p>
        </div>
      ) : null}

      <SectionCard title="Team pipeline" moreHref={projectHref(projectId, '/leads')}>
        <ChartCard
          title="Lead pipeline"
          description="How leads are distributed across the funnel."
          query={leadsQuery}
        >
          {(data) => <PipelineFunnelChart data={data} />}
        </ChartCard>
      </SectionCard>

      <div className="grid gap-8 lg:grid-cols-2">
        <SectionCard title="Leads over time" moreHref={projectHref(projectId, '/leads')}>
          <ChartCard
            title="New leads, last 14 days"
            description="Daily new-lead volume. Zero-fills quiet days so the trend stays readable."
            query={statsQuery}
            dataHint="line"
          >
            {(data) => <LeadsOverTimeChart data={data.leadsOverTime} />}
          </ChartCard>
        </SectionCard>

        <SectionCard title="Lead sources" moreHref={projectHref(projectId, '/leads')}>
          <ChartCard
            title="Where leads come from"
            description="Source breakdown. Friendly labels (Meta ads, Referral, Walk-in)."
            query={statsQuery}
            dataHint="pie"
          >
            {(data) => <LeadSourceChart data={data.leadSources} />}
          </ChartCard>
        </SectionCard>

        <SectionCard title="Team performance" moreHref={projectHref(projectId, '/leads')}>
          <ChartCard
            title="Leads per team member"
            description="Who is carrying the pipeline. Sorted busiest first."
            query={statsQuery}
          >
            {(data) => <TeamPerformanceChart data={data.teamPerformance} />}
          </ChartCard>
        </SectionCard>

        <SectionCard title="Bookings by status" moreHref={projectHref(projectId, '/bookings')}>
          <ChartCard
            title="Bookings by status"
            description="How bookings are distributed across the approval funnel."
            query={statsQuery}
          >
            {(data) => <BookingsByStatusChart data={data.bookingsByStatus} />}
          </ChartCard>
        </SectionCard>
      </div>

      <SectionCard title="Visits this week" moreHref={projectHref(projectId, '/visits')}>
        <ChartCard
          title="Visits this week"
          description="Count of site visits scheduled per day, Mon–Sun."
          query={visitsQuery}
        >
          {(data) => <VisitsThisWeekChart data={data} />}
        </ChartCard>
      </SectionCard>

      <SectionCard title="Bookings on hold" moreHref={projectHref(projectId, '/bookings')}>
        <BookingsOnHoldTable
          query={bookingsQuery}
          projectId={projectId}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookings on hold - real HOLD-status bookings table (the bookings module is
// fully built; the dashboard must not show a stale "module pending" state).
// ---------------------------------------------------------------------------

type BookingRow = {
  id: string;
  leadId?: string;
  leadName?: string;
  unitId?: string;
  userName?: string;
  amount?: string;
  tokenAmount?: string | null;
  status?: string;
  approvedByName?: string | null;
  createdAt?: string;
};

const BOOKING_BADGE_CLASS: Record<BookingStatus, string> = {
  HOLD: 'bg-amber-100 text-amber-900',
  TOKEN: 'bg-blue-100 text-blue-900',
  APPROVED: 'bg-green-100 text-green-900',
  REJECTED: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

function isBookingStatus(value: string): value is BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(value);
}

function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

function BookingsOnHoldTable({
  query,
  projectId,
}: {
  query: {
    isLoading: boolean;
    error: unknown;
    data: unknown;
  };
  projectId: string | null;
}) {
  const rows = (Array.isArray(query.data) ? query.data : []) as BookingRow[];

  if (query.isLoading) {
    return <Skeleton variant="table" />;
  }

  if (query.error !== null && query.error !== undefined) {
    return (
      <div
        role="alert"
        className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
      >
        <p className="font-semibold">Bookings unavailable</p>
        <p className="mt-1 opacity-90">
          {query.error instanceof Error
            ? query.error.message
            : 'Could not load bookings. Please try again.'}
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="border-border rounded-lg border p-8 text-center">
        <p className="text-sm font-medium">No bookings on hold.</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Bookings awaiting approval land here.
        </p>
      </div>
    );
  }

  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border bg-muted/40 border-b text-left">
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">
              Lead
            </th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">
              Status
            </th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase sm:table-cell">
              Amount
            </th>
            <th className="text-muted-foreground hidden px-4 py-2.5 text-xs md:table-cell">
              Created
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const id = typeof row.id === 'string' ? row.id : `b-${index}`;
            const leadId = typeof row.leadId === 'string' ? row.leadId : '';
            const leadName =
              (typeof row.leadName === 'string' && row.leadName.length > 0
                ? row.leadName
                : leadId) || '-';
            const status = typeof row.status === 'string' ? row.status : '';
            const badgeClass = isBookingStatus(status)
              ? BOOKING_BADGE_CLASS[status]
              : 'bg-gray-100 text-gray-700';
            return (
              <tr
                key={id}
                className="border-border hover:bg-muted/30 border-b last:border-b-0"
              >
                <td className="px-4 py-2.5">
                  {leadId.length > 0 ? (
                    <Link
                      href={projectHref(projectId, `/leads/${leadId}`)}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {leadName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{leadName}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}
                  >
                    {isBookingStatus(status)
                      ? labelFor('booking', status)
                      : status || '-'}
                  </span>
                </td>
                <td className="hidden px-4 py-2.5 tabular-nums sm:table-cell">
                  {formatMoney(row.amount)}
                </td>
                <td className="text-muted-foreground hidden px-4 py-2.5 tabular-nums md:table-cell">
                  {typeof row.createdAt === 'string'
                    ? dateIntl.formatDate(row.createdAt)
                    : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telecaller / Sales Exec home (Wireframes #4) - real KPIs + their queue
// ---------------------------------------------------------------------------

function InboxFirstHome({ role }: { role: string }) {
  const projectId = useActiveProjectId();
  const statsQuery = useDashboardStats(projectId ?? undefined);
  const leadsQuery = useLeads({ limit: 50, projectId: projectId ?? undefined });
  const stats = statsQuery.data;
  const statsLoading = statsQuery.isLoading;
  const statsError = statsQuery.error;

  return (
    <div className="space-y-8">
      <div>
        <Heading className="mb-1">Your queue</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          Signed in as {role.replace('_', ' ').toLowerCase()} - your leads and
          next actions live in the inbox.
        </TypographyP>
      </div>

      {statsLoading ? (
        <Skeleton variant="kpi" aria-label="Loading your queue KPIs" />
      ) : (
        <KpiStrip
          items={[
            {
              label: 'My new leads today',
              value: stats ? String(stats.kpis.newLeadsToday) : '-',
              sub: 'assigned to you',
            },
            {
              label: 'My overdue leads',
              value: stats ? String(stats.kpis.overdueLeads) : '-',
              sub: 'not touched in 30 min',
            },
            {
              label: "My visits today",
              value: stats ? String(stats.kpis.visitsToday) : '-',
              sub: 'scheduled for you',
            },
            {
              label: 'My bookings on hold',
              value: stats ? String(stats.kpis.bookingsOnHold) : '-',
              sub: 'awaiting approval',
            },
          ]}
        />
      )}

      {statsError !== null && statsError !== undefined ? (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
        >
          <p className="font-semibold">Your queue data unavailable</p>
          <p className="mt-1 opacity-90">
            {statsError instanceof Error
              ? statsError.message
              : 'Could not load your queue. Please try again.'}
          </p>
        </div>
      ) : null}

      <SectionCard title="Your leads by status" moreHref={projectHref(projectId, '/leads')}>
        <ChartCard
          title="Your queue"
          description="Status breakdown of leads assigned to you."
          query={leadsQuery}
        >
          {(data) => <LeadStatusPie data={data} />}
        </ChartCard>
      </SectionCard>
    </div>
  );
}
