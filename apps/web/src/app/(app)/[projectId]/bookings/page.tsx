'use client';

// Bookings Pipeline (Wireframe #9) - REBUILT on the @paalstack/react-ui
// DataTable (T-BOOK, 2026-09-10) with SERVER pagination + server-driven
// filters, mirroring the leads/inventory/users pages.
//
//   DataTable toolbar (storybook `ToolbarWithRightSideContent` pattern):
//     - search lives IN the toolbar, server-side (D9) - wired to useBookings
//       search param via onSearchValueChange (≥2 chars hits the API, debounced
//       300ms via useDebouncedValue).
//     - the "+ New booking" button is the toolbar's right-side content
//       (role-gated: hidden for TELECALLER).
//     - status filter is a server-driven MultiSelect (toolbar left side) -
//       the DataTable's built-in facet filter is client-side over the loaded
//       page, which is wrong under server pagination. Selection feeds the
//       `status` query param.
//   Pagination: SERVER-side. The page passes `total`/`currentPage`/
//     `onPageChange`/`onPageSizeChange` to the DataTable; each page change
//     refetches `{ limit, offset }` from the API.
//   Columns: Lead (link back to parent) → Status (Badge) → Amount → Token →
//     Created → Owner / Approval.
//   Row actions: View (link to parent lead) + Review approval (link to
//     /bookings/[id], MANAGER/ADMIN only, TOKEN status).
import { Badge, Button, DataTable, MultiSelect, TypographyP } from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { useDebouncedValue } from '@paalstack/react-hooks';
import { LuPlus } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useBookings, useBookingsEnvelope } from '@/hooks/queries/crm';
import { currencyIntl, dateIntl } from '@/lib/format';
import { labelFor, BOOKING_STATUSES, type BookingStatus } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { canApproveBookings, useSessionUser } from '@/lib/session';

import { PageHeader } from '@/components/shared/PageHeader';

const DEFAULT_PAGE_SIZE = 10;

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

// Status → Badge semantic variant (user-mandated: use Badge, not hand-rolled
// spans). Maps to theme tokens so colors stay consistent + dark-mode aware.
const STATUS_BADGE_VARIANT: Record<BookingStatus, 'success' | 'warning' | 'info' | 'destructive' | 'muted'> = {
  HOLD: 'warning',
  TOKEN: 'info',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'muted',
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

export default function BookingsPage() {
  const { user } = useSessionUser();
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const isOnline = useOnlineStatus();

  // Server-driven status filter (T-SRVPG): the DataTable's built-in facet
  // filter is client-side over the loaded page, which is wrong under server
  // pagination. A MultiSelect in the toolbar feeds the `status` query param.
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  // Server-side search (D9): the toolbar search input feeds the `search`
  // query param (≥2 chars hits the API). Debounced 300ms so the API isn't
  // hit on every keystroke.
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const serverSearch =
    debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;
  // Server-side pagination (T-SRVPG): page is 1-indexed (the DataTable
  // Pagination is 1-indexed); offset = (page - 1) * pageSize.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const filter = {
    projectId: projectId ?? undefined,
    status: statusFilter.length > 0 ? statusFilter : undefined,
    search: serverSearch,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  } as const;

  const bookingsQuery = useBookings(filter);
  const total = useBookingsEnvelope(filter);
  const rows = Array.isArray(bookingsQuery.data)
    ? (bookingsQuery.data as BookingRow[])
    : [];

  const canCreate =
    user !== null &&
    (user.role === 'ADMIN' ||
      user.role === 'OWNER' ||
      user.role === 'MANAGER' ||
      user.role === 'SALES_EXEC');
  const canApprove = canApproveBookings(user?.role);

  const isFiltered = statusFilter.length > 0 || serverSearch !== undefined;

  const statusOptions = useMemo(
    () =>
      BOOKING_STATUSES.map((s) => ({
        value: s,
        label: labelFor('booking', s),
      })),
    [],
  );

  const columns = useMemo<DataTableColumnDef<BookingRow>[]>(
    () => [
      {
        accessorKey: 'leadName',
        header: 'Lead',
        cell: ({ row }) => {
          const leadId = typeof row.original.leadId === 'string' ? row.original.leadId : '';
          const leadName =
            typeof row.original.leadName === 'string' && row.original.leadName.length > 0
              ? row.original.leadName
              : '-';
          return leadId.length > 0 ? (
            <Link
              href={projectHref(projectId, `/leads/${leadId}`)}
              className="min-h-11 text-sm font-medium underline-offset-4 hover:underline"
            >
              {leadName}
            </Link>
          ) : (
            <span className="text-muted-foreground text-sm">{leadName}</span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const status = row.original.status ?? '';
          const variant = isBookingStatus(status)
            ? STATUS_BADGE_VARIANT[status]
            : 'muted';
          return (
            <Badge variant={variant} data-qa="booking-status-badge">
              {isBookingStatus(status) ? labelFor('booking', status) : status || '-'}
            </Badge>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'amount',
        header: 'Amount',
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{formatMoney(row.original.amount)}</span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'tokenAmount',
        header: 'Token',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {formatMoney(row.original.tokenAmount ?? undefined)}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {typeof row.original.createdAt === 'string'
              ? dateIntl.formatDate(row.original.createdAt)
              : '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'userName',
        header: 'Owner / Approval',
        cell: ({ row }) => {
          const owner =
            typeof row.original.userName === 'string' && row.original.userName.length > 0
              ? row.original.userName
              : null;
          const approver =
            typeof row.original.approvedByName === 'string' &&
            row.original.approvedByName.length > 0
              ? row.original.approvedByName
              : null;
          const status = row.original.status ?? '';
          return (
            <div className="text-muted-foreground text-xs">
              {owner !== null ? <span>Owner: {owner}</span> : null}
              {approver !== null ? <span className="block">Approved by: {approver}</span> : null}
              {canApprove && status === 'TOKEN' ? (
                <Link
                  href={projectHref(projectId, `/bookings/${row.original.id}`)}
                  className="mt-1 inline-block font-medium text-blue-700 underline-offset-4 hover:underline"
                  data-qa="approve-booking-link"
                >
                  Review approval →
                </Link>
              ) : null}
            </div>
          );
        },
        enableSorting: false,
      },
    ],
    [projectId, canApprove],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bookings"
        breadcrumb={[{ label: 'Work' }, { label: 'Bookings' }]}
        subtitle="HOLD → TOKEN → APPROVED. Manager approval is the gating step."
        action={
          canCreate ? (
            <Button asChild size="sm" className="min-h-11" data-qa="new-booking-button">
              <Link href={projectHref(projectId, '/bookings/new')}>
                <LuPlus className="mr-1 h-4 w-4" /> New booking
              </Link>
            </Button>
          ) : null
        }
      />

      {bookingsQuery.isLoading ? (
        <Skeleton variant="table" isOffline={!isOnline} />
      ) : bookingsQuery.error !== null && bookingsQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load the bookings.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {bookingsQuery.error instanceof Error
              ? bookingsQuery.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void bookingsQuery.refetch()}
            data-qa="bookings-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          // Search is server-side (onSearchValueChange → API). The DataTable's
          // built-in client-side global filter is redundant here - make it a
          // no-op so it never hides rows over the already-filtered page.
          globalFilterFn={() => true}
          search={{
            accessorKey: ['leadName', 'userName'],
            placeholder: 'Search by lead or owner...',
            searchValue: search,
            onSearchValueChange: (next) => {
              setSearch(next);
              setPage(1); // a new search starts back at page 1
            },
            className: 'ml-2',
          }}
          toolbarLeftSideContent={
            <MultiSelect
              options={statusOptions}
              selectedValues={statusFilter}
              onSelectedValueChange={(next) => {
                setStatusFilter(next as string[]);
                setPage(1); // a new filter starts back at page 1
              }}
              placeholder="Filter by status"
              maxSelectedBadges={2}
              triggerProps={{
                size: 'sm',
                variant: 'outline',
                className: 'min-w-48 max-w-96',
              }}
              contentProps={{ className: 'min-w-56 max-w-96' }}
              className="w-full"
              data-qa="bookings-status-filter"
            />
          }
          toolbarRightSideContent={
            canCreate ? (
              <Button asChild>
                <Link href={projectHref(projectId, '/bookings/new')} data-qa="new-booking-button">
                  <LuPlus className="size-4" />
                  New booking
                </Link>
              </Button>
            ) : null
          }
          showPagination
          paginationProps={{
            total,
            currentPage: page,
            onPageChange: setPage,
            pageSize,
            onPageSizeChange: (size) => {
              setPageSize(size);
              setPage(1);
            },
            showTotalResults: true,
            showOnlyIfTotalGreaterThanPageSize: true,
          }}
          emptyContent={
            isFiltered ? (
              <div className="rounded-lg p-10 text-center space-y-1">
                <TypographyP className="text-xl font-medium">
                  No bookings match this search.
                </TypographyP>
                <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                  Try clearing a filter or check the spelling.
                </TypographyP>
              </div>
            ) : (
              <div className="rounded-lg p-10 text-center space-y-1" data-qa="bookings-empty">
                <TypographyP className="text-xl font-medium">No bookings yet.</TypographyP>
                <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                  {canCreate
                    ? 'Start a new booking from a lead in NEGOTIATION.'
                    : 'Bookings appear here as soon as sales execs initiate them.'}
                </TypographyP>
              </div>
            )
          }
          tableContainerClassName="rounded-lg border"
        />
      )}
    </div>
  );
}
