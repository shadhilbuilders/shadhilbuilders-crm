'use client';

// Role-aware Dashboard (Phase 2 - plan T9).
//
// Per D3 (role-tuned default), each role sees a different number of charts:
//   - Telecaller/SalesExec : 1 chart (their own queue, status pie)
//   - Manager              : 3 charts (pipeline funnel + visits-this-week + team lead pie)
//   - Admin/Owner          : 4 charts (the three above + audit timeline)
//
// Per D2, the charts split into two shapes:
//   - Dedicated files (data-shaping logic earns its own file):
//       - `PipelineFunnelChart` (bucketing useLeads by status, friendly axis)
//       - `VisitsThisWeekChart` (rolling 7-day window from useVisits)
//   - Inline `ChartCard` calls (simple enough to live in the page):
//       - `LeadStatusPie`     (count by status, only difference from funnel
//                              is the chart type - pie vs bar - so no
//                              dedicated file)
//       - `AuditTimeline`     (bucket audit log by day, admin only)
//
// All charts flow through `ChartCard` so the loading/error/empty
// state is centralized - the per-page wiring in T10 doesn't have to
// re-implement the pending copy. T19 (PR2) will swap the pending
// copy for a shape-matched Skeleton variant without changing this
// file.
import { Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';

import { ChartCard } from '@/components/shared/ChartCard';
import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import {
  canManageUsers,
  canViewAudit,
  isAdminLike,
  useSessionUser,
} from '@/lib/session';
import { labelFor, LEAD_STATUSES } from '@/lib/labels';
import {
  useAuditLog,
  useBookings,
  useLeads,
  useVisits,
} from '@/hooks/queries/crm';

import { PipelineFunnelChart } from '@/components/charts/PipelineFunnelChart';
import { VisitsThisWeekChart } from '@/components/charts/VisitsThisWeekChart';

export default function DashboardPage() {
  const { user, isPending: sessionPending } = useSessionUser();

  if (sessionPending) {
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

  if (isAdminLike(role)) return <AdminDashboard />;
  if (role === 'MANAGER') return <ManagerDashboard name={user.name || role} />;

  // Telecaller + Sales Exec: their queue IS the home (Wireframes #4).
  return <InboxFirstHome role={role} />;
}

// ---------------------------------------------------------------------------
// KPI strip - numbers in one row with label + trend, no cards (wireframe note)
// ---------------------------------------------------------------------------

type Kpi = {
  label: string;
  value: string;
  sub?: string;
};

// T20 (PR3): the KpiStrip value element picks up a one-time
// `animate-shimmer-once` pulse when it transitions from the
// placeholder "-" to a real number. We detect the transition via
// a `data-state` attribute (loading → ready) and toggle the class
// via a useEffect on the parent that flips when the data arrives.
// Since the Dashboard pages don't yet have live KPI data, the
// `data-state="ready"` is the *default* here, with a `data-just-
// arrived` flag the parent can set when a value transitions from
// "-" to a number. Future KPI-module work sets the flag once.
function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-6 sm:grid-cols-4">
      {items.map((kpi) => {
        const isPlaceholder = kpi.value === '-';
        return (
          <div key={kpi.label}>
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {kpi.label}
            </p>
            <p
              className={`mt-1 text-3xl font-semibold tabular-nums ${
                isPlaceholder ? 'text-muted-foreground' : 'animate-shimmer-once'
              }`}
              data-state={isPlaceholder ? 'loading' : 'ready'}
            >
              {kpi.value}
            </p>
            {kpi.sub !== undefined ? (
              <p className="text-muted-foreground mt-0.5 text-xs">{kpi.sub}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manager dashboard (Wireframes #1) - 3 charts
// ---------------------------------------------------------------------------

function ManagerDashboard({ name }: { name: string }) {
  const leadsQuery = useLeads({ limit: 200 });
  const visitsQuery = useVisits({});
  const bookingsQuery = useBookings({ status: 'HOLD' });

  return (
    <div className="space-y-8">
      <div>
        <Heading className="mb-1">Dashboard</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          {name} · team pipeline at a glance.
        </TypographyP>
      </div>

      <KpiStrip
        items={[
          { label: 'Time to first touch', value: '-', sub: 'target < 30 min' },
          { label: "Today's visits", value: '-', sub: 'across the team' },
          { label: 'Awaiting your approval', value: '-', sub: 'bookings on hold' },
          { label: "Yesterday's no-show", value: '-', sub: 'target < 25%' },
        ]}
      />

      <SectionCard title="Team pipeline" moreHref="/leads">
        <ChartCard
          title="Lead pipeline"
          description="How leads are distributed across the funnel. Lights up when the leads module ships (Week 4)."
          query={leadsQuery}
        >
          {(data) => <PipelineFunnelChart data={data} />}
        </ChartCard>
      </SectionCard>

      <SectionCard title="Visits this week" moreHref="/visits">
        <ChartCard
          title="Visits this week"
          description="Count of site visits scheduled per day, Mon–Sun. Arrives with the visits module (Week 6)."
          query={visitsQuery}
        >
          {(data) => <VisitsThisWeekChart data={data} />}
        </ChartCard>
      </SectionCard>

      <SectionCard title="Bookings on hold" moreHref="/leads">
        <ModulePending
          title="Booking approval queue"
          description="Bookings awaiting your approval land here when the bookings module ships (Week 7)."
          error={bookingsQuery.error}
          isLoading={bookingsQuery.isLoading}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin dashboard (Wireframes #3) - 4 charts (Manager's 3 + audit timeline)
// ---------------------------------------------------------------------------

function AdminDashboard() {
  const leadsQuery = useLeads({ limit: 200 });
  const visitsQuery = useVisits({});
  const usersVisible = canManageUsers('ADMIN');
  const auditVisible = canViewAudit('ADMIN');
  const auditQuery = useAuditLog({ limit: 200 });

  return (
    <div className="space-y-8">
      <div>
        <Heading className="mb-1">Admin dashboard</Heading>
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

      <SectionCard title="Cross-team pipeline" moreHref="/leads">
        <ChartCard
          title="Lead pipeline (all teams)"
          description="Cross-team distribution of leads by status. The leads module (Week 4) provides the data."
          query={leadsQuery}
        >
          {(data) => <PipelineFunnelChart data={data} />}
        </ChartCard>
      </SectionCard>

      <SectionCard title="Visits this week" moreHref="/visits">
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

// ---------------------------------------------------------------------------
// Telecaller / Sales Exec home (Wireframes #4) - 1 chart, their queue
// ---------------------------------------------------------------------------

function InboxFirstHome({ role }: { role: string }) {
  const leadsQuery = useLeads({ limit: 50 });
  return (
    <div className="space-y-8">
      <div>
        <Heading className="mb-1">Your queue</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          Signed in as {role.replace('_', ' ').toLowerCase()} - your leads and
          next actions live in the inbox.
        </TypographyP>
      </div>

      <SectionCard title="Your leads by status" moreHref="/leads">
        <ChartCard
          title="Your queue"
          description="Status breakdown of leads assigned to you. The leads module (Week 4) provides the data."
          query={leadsQuery}
        >
          {(data) => <LeadStatusPie data={data} />}
        </ChartCard>
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline charts (D2 - simple enough to live in the page file)
// ---------------------------------------------------------------------------

/** Pie of lead counts by status. Telecaller/Exec's single chart, and the
 *  team-wide view for Manager/Admin's third chart. Re-uses the
 *  friendly-label map so a non-technical user reads "Talked" not
 *  "CONTACTED" in the legend. */
function LeadStatusPie({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return null;
  const counts: Record<string, number> = {};
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const status = (item as { status?: unknown }).status;
    if (typeof status !== 'string') continue;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const pieData = LEAD_STATUSES.map((status) => ({
    name: labelFor('lead', status),
    value: counts[status] ?? 0,
  })).filter((slice) => slice.value > 0);
  if (pieData.length === 0) return null;

  return (
    <ul
      className="space-y-2 text-sm"
      aria-label="Lead counts by status (friendly labels)"
    >
      {pieData.map((slice) => (
        <li
          key={slice.name}
          className="flex items-center justify-between border-b pb-1 last:border-b-0"
        >
          <span>{slice.name}</span>
          <span className="text-muted-foreground tabular-nums">
            {slice.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Audit timeline - admin only. Buckets audit log entries by day so an
 *  admin can see "is anything weird happening this week". Uses an
 *  inline `<ul>` rendering instead of a chart primitive because the
 *  data is naturally sequential and a sparkline adds noise without
 *  information. The empty list message matches the audit module's
 *  pending state. */
function AuditTimeline({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return null;
  type AuditEntry = { createdAt?: string; action?: string };
  const counts: Record<string, number> = {};
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as AuditEntry;
    if (typeof entry.createdAt !== 'string') continue;
    const day = new Date(entry.createdAt).toLocaleDateString('en-CA');
    counts[day] = (counts[day] ?? 0) + 1;
  }
  const days = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7);
  if (days.length === 0) return null;
  return (
    <ul
      className="space-y-1 text-sm"
      aria-label="Audit events per day (last 7 days)"
    >
      {days.map(([day, count]) => (
        <li
          key={day}
          className="flex items-center justify-between border-b pb-1 last:border-b-0"
        >
          <span>{day}</span>
          <span className="text-muted-foreground tabular-nums">{count}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  moreHref,
  children,
}: {
  title: string;
  moreHref: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          {title}
        </h2>
        <Link
          href={moreHref}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center px-2 text-sm"
        >
          See all →
        </Link>
      </div>
      <div className="border-border rounded-lg border p-4">{children}</div>
    </section>
  );
}
