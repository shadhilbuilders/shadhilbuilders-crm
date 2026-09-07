'use client';

// Bookings Pipeline (Wireframe #9): list of bookings with status filter,
// row deep-links back to the parent lead. Status enum is mapped via the
// shared labels.ts (T-F1 + standing rule 3) so we never leak raw enum
// strings to the UI.
//
// Backend (T-BOOK, Pass 1) returns BookingListResult = { total, rows }.
// useBookings unwraps the rows (T-F1).
import { Button } from '@paalstack/react-ui';
import { LuPlus } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useParams } from 'next/navigation';

import { useBookings, useLeads } from '@/hooks/queries/crm';
import { labelFor, BOOKING_STATUSES, type BookingStatus } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { useSessionUser, canApproveBookings } from '@/lib/session';

import { PageHeader } from '@/components/shared/PageHeader';

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
  updatedAt?: string;
};

// Filter chips: All + every BookingStatus value. The "All" tab
// sends no status param; selecting a specific status narrows the
// server query. Backend re-validates the param via
// BookingFilterDtoSchema - out-of-enum values throw 400 (handled
// by the api() client's ApiError → page renders ModulePending).
const STATUS_FILTERS: { value: BookingStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All' },
  ...BOOKING_STATUSES.map((s) => ({ value: s, label: labelFor('booking', s) })),
];

// Status → Tailwind badge colour. Tinted backgrounds match the
// other status badges in the app (LeadStatusBadge / VisitPanel).
const STATUS_BADGE_CLASS: Record<BookingStatus, string> = {
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
  // Backend sends numbers as strings (Prisma Decimal serialises to
  // string over JSON). Format as Indian-rupee compact: ₹1.2L style.
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(num);
}

export default function BookingsPage() {
  const [statusFilter, setStatusFilter] = useState<BookingStatus | 'ALL'>('ALL');
  const { user } = useSessionUser();
  // T-ProjectSwitch: scope bookings + the lead-name lookup to the URL project.
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : undefined;
  const bookingsQuery = useBookings({
    ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}),
    projectId,
  });
  const leadsQuery = useLeads({ limit: 200, projectId });
  const isOnline = useOnlineStatus();

  const rows = bookingsQuery.data ?? [];

  // Build a leadId → lead.name lookup so the list renders the lead's
  // friendly name even when the booking row omits leadName (some
  // legacy payloads only carry leadId). Falls back to the raw leadId
  // when nothing matches.
  const leadNameById = useMemo(() => {
    const map = new Map<string, string>();
    const list = leadsQuery.data;
    if (Array.isArray(list)) {
      for (const r of list) {
        const row = r as { id?: string; name?: string };
        if (typeof row.id === 'string' && typeof row.name === 'string') {
          map.set(row.id, row.name);
        }
      }
    }
    return map;
  }, [leadsQuery.data]);

  const canCreate =
    user !== null &&
    (user.role === 'ADMIN' ||
      user.role === 'OWNER' ||
      user.role === 'MANAGER' ||
      user.role === 'SALES_EXEC');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bookings"
        breadcrumb={[{ label: 'Work' }, { label: 'Bookings' }]}
        subtitle="HOLD → TOKEN → APPROVED. Manager approval is the gating step."
        action={
          canCreate ? (
            <Button asChild size="sm" className="min-h-11" data-qa="new-booking-button">
              <Link href={projectHref(projectId ?? null, '/bookings/new')}>
                <LuPlus className="mr-1 h-4 w-4" /> New booking
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((item) => (
          <Button
            key={item.value}
            variant={statusFilter === item.value ? 'default' : 'outline'}
            size="sm"
            className="min-h-11"
            onClick={() => setStatusFilter(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {bookingsQuery.isLoading ? (
        <Skeleton variant="table" isOffline={!isOnline} />
      ) : rows.length > 0 ? (
        <BookingTable
          rows={rows as BookingRow[]}
          leadNameById={leadNameById}
          canApprove={canApproveBookings(user?.role)}
          projectId={projectId ?? null}
        />
      ) : (
        <BookingsEmpty
          filter={statusFilter}
          error={bookingsQuery.error}
          canCreate={canCreate}
        />
      )}
    </div>
  );
}

function BookingTable({
  rows,
  leadNameById,
  canApprove,
  projectId,
}: {
  rows: BookingRow[];
  leadNameById: Map<string, string>;
  canApprove: boolean;
  projectId: string | null;
}) {
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
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase sm:table-cell">
              Token
            </th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">
              Created
            </th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">
              Owner / Approval
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
                : leadId.length > 0
                  ? leadNameById.get(leadId)
                  : undefined) ?? '-';
            const status = typeof row.status === 'string' ? row.status : '';
            const badgeClass = isBookingStatus(status)
              ? STATUS_BADGE_CLASS[status]
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
                    data-qa="booking-status-badge"
                  >
                    {isBookingStatus(status) ? labelFor('booking', status) : status || '-'}
                  </span>
                </td>
                <td className="hidden px-4 py-2.5 tabular-nums sm:table-cell">
                  {formatMoney(row.amount)}
                </td>
                <td className="hidden px-4 py-2.5 tabular-nums sm:table-cell">
                  {formatMoney(row.tokenAmount ?? undefined)}
                </td>
                <td className="text-muted-foreground hidden px-4 py-2.5 tabular-nums md:table-cell">
                  {typeof row.createdAt === 'string'
                    ? new Date(row.createdAt).toLocaleDateString('en-IN')
                    : '-'}
                </td>
                <td className="text-muted-foreground px-4 py-2.5 text-xs">
                  {typeof row.userName === 'string' && row.userName.length > 0 ? (
                    <span>Owner: {row.userName}</span>
                  ) : null}
                  {typeof row.approvedByName === 'string' && row.approvedByName.length > 0 ? (
                    <span className="ml-2 block">
                      Approved by: {row.approvedByName}
                    </span>
                  ) : null}
                  {canApprove && status === 'TOKEN' ? (
                    <Link
                      href={projectHref(projectId, `/bookings/${id}`)}
                      className="mt-1 inline-block font-medium text-blue-700 underline-offset-4 hover:underline"
                      data-qa="approve-booking-link"
                    >
                      Review approval →
                    </Link>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BookingsEmpty({
  filter,
  error,
  canCreate,
}: {
  filter: BookingStatus | 'ALL';
  error: unknown;
  canCreate: boolean;
}) {
  if (error !== null && error !== undefined) {
    return (
      <ModulePending
        title="Booking Pipeline"
        description="HOLD → TOKEN → APPROVED with manager approval gating. The bookings module ships with the demo."
        error={error}
      />
    );
  }
  const isFiltered = filter !== 'ALL';
  return (
    <div
      className="border-border rounded-lg border p-10 text-center"
      data-qa="bookings-empty"
    >
      <p className="text-sm font-medium">
        {isFiltered
          ? `No bookings in "${labelFor('booking', filter)}" status.`
          : 'No bookings yet.'}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        {isFiltered
          ? 'Try clearing the status filter.'
          : canCreate
            ? 'Start a new booking from a lead in NEGOTIATION.'
            : 'Bookings appear here as soon as sales execs initiate them.'}
      </p>
    </div>
  );
}