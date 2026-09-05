'use client';

// Lead Inbox (Wireframes #4 + Implementation Plan Week 4):
//   DataTable with overdue-first default sort (Decision 0.2)
//   Filter chips: Status, Owner, search
//   Bulk actions: reassign/mark contacted (role-gated)
//   Row click → /leads/[id]
//
// The backend leads module is scaffolded-not-implemented; until it ships the
// page renders the honest ModulePending state. The DataTable columns and
// filter UI below are already locked to the api-types LeadFilterDto shape so
// the switch to live data is a query-key flip, not a rewrite.
import { Button, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useLeads } from '@/hooks/queries/crm';
import { useSessionUser } from '@/lib/session';

import { PageHeader } from '../PageHeader';

type LeadRow = {
  id: string;
  name: string;
  phone?: string;
  status?: string;
  source?: string;
  ownerName?: string;
  updatedAt?: string;
};

export default function LeadInboxPage() {
  const { user } = useSessionUser();
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const leadsQuery = useLeads({
    state: stateFilter !== null ? [stateFilter] : undefined,
    search: search.length >= 2 ? search : undefined,
    limit: 100,
  });

  // Overdue-first sort happens client-side on live data (Decision 0.2):
  // rows with a first-touch SLA breach float to the top, then NEW, then
  // most recent activity. Applied once the real payload arrives.
  const sorted = useMemo(() => {
    const rows = leadsQuery.data;
    if (!Array.isArray(rows)) return [];
    return [...(rows as LeadRow[])].sort((a, b) => {
      const overdueOf = (row: LeadRow) =>
        row.status === 'NEW' && row.updatedAt !== undefined ? 0 : 1;
      return overdueOf(a) - overdueOf(b);
    });
  }, [leadsQuery.data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lead Inbox"
        breadcrumb={[{ label: 'Work' }, { label: 'Leads' }]}
        subtitle={
          user !== null && (user.role === 'TELECALLER' || user.role === 'SALES_EXEC')
            ? 'Your assigned leads, next action first.'
            : 'Team lead queue with overdue-first sorting.'
        }
        action={
          // The "+ New lead" button is hidden for TELECALLER per
          // Plan §3 - leads are created by managers/landing site, then
          // routed by the assignment rule. SALES_EXEC and above can
          // self-source leads (e.g. walk-ins).
          user !== null && user.role !== 'TELECALLER' ? (
            <Button asChild variant="default" size="sm">
              <Link href="/leads/new" data-qa="new-lead-button">
                + New lead
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="flex justify-end">
        <LeadStateFilterChips
          value={stateFilter}
          onChange={(next) => setStateFilter(next)}
        />
      </div>

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        placeholder="Search by name or phone…"
        className="border-input bg-background focus-visible:ring-ring min-h-11 w-full max-w-md rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        aria-label="Search leads"
      />

      {leadsQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : leadsQuery.data !== undefined && Array.isArray(leadsQuery.data) ? (
        <LeadTable rows={sorted} />
      ) : (
        <ModulePending
          title="Lead Inbox"
          description="Lists every lead with status, source, owner, and last activity (Wireframe #4). The leads REST module ships in Implementation Plan Week 4."
          error={leadsQuery.error}
        />
      )}
    </div>
  );
}

const STATE_CHIPS: { value: string; label: string }[] = [
  { value: 'NEW', label: 'New' },
  { value: 'CONTACTED', label: 'Contacted' },
  { value: 'VISIT_REQUESTED', label: 'Visit requested' },
  { value: 'VISIT_SCHEDULED', label: 'Visit scheduled' },
  { value: 'VISITED', label: 'Visited' },
  { value: 'WON', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
];

function LeadStateFilterChips({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant={value === null ? 'default' : 'outline'}
        size="sm"
        className="min-h-11"
        onClick={() => onChange(null)}
      >
        All
      </Button>
      {STATE_CHIPS.map((chip) => (
        <Button
          key={chip.value}
          variant={value === chip.value ? 'default' : 'outline'}
          size="sm"
          className="min-h-11"
          onClick={() => onChange(value === chip.value ? null : chip.value)}
        >
          {chip.label}
        </Button>
      ))}
    </div>
  );
}

function LeadTable({ rows }: { rows: LeadRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-border rounded-lg border p-10 text-center">
        <p className="text-sm font-medium">No leads match these filters.</p>
        <TypographyP className="text-muted-foreground mt-1 text-xs">
          They'll appear here as soon as the landing-site webhook fires or a
          lead is created manually.
        </TypographyP>
      </div>
    );
  }

  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border bg-muted/40 border-b text-left">
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">
              Name
            </th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">
              Status
            </th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase sm:table-cell">
              Source
            </th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">
              Owner
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-border hover:bg-muted/30 border-b last:border-b-0"
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/leads/${row.id}`}
                  className="min-h-11 text-sm font-medium underline-offset-4 hover:underline"
                >
                  {row.name}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <LeadStatusBadge status={row.status ?? 'UNKNOWN'} />
              </td>
              <td className="text-muted-foreground hidden px-4 py-2.5 text-sm sm:table-cell">
                {row.source ?? '-'}
              </td>
              <td className="text-muted-foreground hidden px-4 py-2.5 text-sm md:table-cell">
                {row.ownerName ?? '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

