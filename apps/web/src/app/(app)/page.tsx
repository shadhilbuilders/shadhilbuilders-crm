'use client';

// Role-aware home (Wireframes #1 / #3 / #4):
//   Admin/owner → cross-team counts + audit stream (admin dashboard)
//   Manager           → KPI strip + team pipeline sections
//   Telecaller/Exec   → straight to their queue (Lead Inbox is the home)
//
// KPI strip = numbers in a row, NOT a card grid (locked decision).
// Wireframes' KPI/pipeline/audit-data sources are backend module contracts —
// pending modules render the honest ModulePending state.
import { Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';

import {
  canManageUsers,
  canViewAudit,
  isAdminLike,
  useSessionUser,
} from '@/lib/session';

import { ModulePending } from '@/components/shared/ModulePending';
import { useAuditLog, useBookings, useLeads, useVisits } from '@/hooks/queries/crm';

export default function DashboardPage() {
  const { user, isPending: sessionPending } = useSessionUser();

  if (sessionPending) {
    return (
      <div className="text-muted-foreground py-24 text-center text-sm">
        Loading…
      </div>
    );
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
// KPI strip — numbers in one row with label + trend, no cards (wireframe note)
// ---------------------------------------------------------------------------

type Kpi = {
  label: string;
  value: string;
  sub?: string;
};

function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-6 sm:grid-cols-4">
      {items.map((kpi) => (
        <div key={kpi.label}>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            {kpi.label}
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{kpi.value}</p>
          {kpi.sub !== undefined ? (
            <p className="text-muted-foreground mt-0.5 text-xs">{kpi.sub}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manager dashboard (Wireframes #1)
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
          { label: 'Time to first touch', value: '—', sub: 'target < 30 min' },
          { label: "Today's visits", value: '—', sub: 'across the team' },
          { label: 'Awaiting your approval', value: '—', sub: 'bookings on hold' },
          { label: "Yesterday's no-show", value: '—', sub: 'target < 25%' },
        ]}
      />

      <SectionCard title="Visits today" moreHref="/visits">
        <ModulePending
          title="Site visits"
          description="Today's visit schedule appears here once the visits module ships (Implementation Plan Week 6)."
          error={visitsQuery.error}
          isLoading={visitsQuery.isLoading}
        />
      </SectionCard>

      <SectionCard title="Bookings in progress" moreHref="/leads">
        <ModulePending
          title="Booking pipeline"
          description="Hold → token → approval states render here when the bookings module ships (Week 7)."
          error={bookingsQuery.error}
          isLoading={bookingsQuery.isLoading}
        />
      </SectionCard>

      <SectionCard title="Overdue leads — first touch > 30 min" moreHref="/leads">
        <ModulePending
          title="Lead pipeline"
          description="Overdue-first lead queue with reassign actions arrives with the leads module (Week 4)."
          error={leadsQuery.error}
          isLoading={leadsQuery.isLoading}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin dashboard (Wireframes #3) — cross-team + audit stream
// ---------------------------------------------------------------------------

function AdminDashboard() {
  const leadsQuery = useLeads({ limit: 200 });
  const usersVisible = canManageUsers('ADMIN');
  const auditVisible = canViewAudit('ADMIN');
  const auditQuery = useAuditLog({ limit: 10 });

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
          { label: 'Total leads', value: '—', sub: 'all teams' },
          { label: 'Reassignments (7d)', value: '—' },
          { label: 'Audit events (24h)', value: '—' },
          { label: 'Users by role', value: '—', sub: usersVisible ? 'manage in Users' : undefined },
        ]}
      />

      <SectionCard title="Team lead counts" moreHref="/leads">
        <ModulePending
          title="Cross-team lead counts"
          description="Per-team lead totals with state breakdowns land with the leads module (Week 4)."
          error={leadsQuery.error}
          isLoading={leadsQuery.isLoading}
        />
      </SectionCard>

      {auditVisible ? (
        <SectionCard title="Recent admin actions (audit)" moreHref="/audit">
          <ModulePending
            title="Audit stream"
            description="The live audit feed arrives with the audit writer (Week 7)."
            error={auditQuery.error}
            isLoading={auditQuery.isLoading}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telecaller / Sales Exec home (Wireframes #4) — inbox-first
// ---------------------------------------------------------------------------

function InboxFirstHome({ role }: { role: string }) {
  const leadsQuery = useLeads({ limit: 50 });
  return (
    <div className="space-y-8">
      <div>
        <Heading className="mb-1">Your queue</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          Signed in as {role.replace('_', ' ').toLowerCase()} — your leads and
          next actions live in the inbox.
        </TypographyP>
      </div>

      <SectionCard title="Lead inbox" moreHref="/leads">
        <ModulePending
          title="Lead inbox"
          description="Your assigned leads with overdue-first sorting (wireframe Decision 0.2) arrive with the leads module (Week 4)."
          error={leadsQuery.error}
          isLoading={leadsQuery.isLoading}
        />
      </SectionCard>
    </div>
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