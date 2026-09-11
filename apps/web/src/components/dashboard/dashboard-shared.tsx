'use client';

// Shared dashboard helpers (dashboard split, 2026-09-08).
//
// Extracted from `[projectId]/dashboard/page.tsx` so BOTH the project work
// dashboard and the admin/owner `/dashboard` command center reuse the same
// KPI strip, section wrapper, and inline charts. DRY: do NOT re-declare these
// in either page - import from here.

import Link from 'next/link';

import { LuArrowRight } from '@paalstack/react-icons/lu';

import { LEAD_STATUSES, labelFor } from '@/lib/labels';

// ---------------------------------------------------------------------------
// KPI strip - numbers in one row with label + trend, no cards (wireframe note)
// ---------------------------------------------------------------------------

export type Kpi = {
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
export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-6 sm:grid-cols-4">
      {items.map((kpi) => {
        const isPlaceholder = kpi.value === '-';
        return (
          <div key={kpi.label} className="min-w-0">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {kpi.label}
            </p>
            <p
              className={`mt-1 text-3xl font-semibold tabular-nums break-words ${
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
// Section wrapper
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  moreHref,
  children,
}: {
  title: string;
  moreHref?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          {title}
        </h2>
        {moreHref !== undefined ? (
          <Link
            href={moreHref}
            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center px-2 text-sm"
          >
            See all
            <LuArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <div className="border-border rounded-lg border p-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline charts (D2 - simple enough to live in the shared file)
// ---------------------------------------------------------------------------

/** Pie of lead counts by status. Telecaller/Exec's single chart, and the
 *  team-wide view for Manager/Admin's third chart. Re-uses the
 *  friendly-label map so a non-technical user reads "Talked" not
 *  "CONTACTED" in the legend. */
export function LeadStatusPie({ data }: { data: unknown }) {
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
export function AuditTimeline({ data }: { data: unknown }) {
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
