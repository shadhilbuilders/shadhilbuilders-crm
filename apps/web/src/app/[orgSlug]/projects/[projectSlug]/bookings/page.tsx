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
//   Columns: Unit (link to the booking) → Lead (link to the lead) → Status
//     (Badge) → Amount → Token → Created → Owner / Approval.
//   Row actions: Approve/Reject (TOKEN + manager) · View details (booking) ·
//     View lead · Edit · Delete.
import { AlertDialog, Badge, Button, DataTable, DataTableRowActions, MultiSelect, TypographyP, toast } from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { useDebouncedValue } from '@paalstack/react-hooks';
import { LuArrowRight, LuBadgeCheck, LuClock, LuCoins, LuPencil, LuPlus, LuTrash2, LuUser } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { BookingApprovalDialog } from '@/components/bookings/BookingApprovalDialog';
import { BookingEditDialog } from '@/components/bookings/BookingEditDialog';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useBookings, useBookingsEnvelope, useDeleteBooking } from '@/hooks/queries/crm';
import { currencyIntl, dateIntl } from '@/lib/format';
import { labelFor, BOOKING_STATUSES, type BookingStatus } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { canApproveBookings, canInitiateBookings, isAdminLike, useSessionUser } from '@/lib/session';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';

const DEFAULT_PAGE_SIZE = 10;

type BookingRow = {
  id: string;
  leadId?: string;
  leadName?: string;
  unitId?: string;
  unitNumber?: string;
  userName?: string;
  amount?: string;
  tokenAmount?: string | null;
  status?: string;
  approvedByName?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

// Zod schema for DataTableRowActions (it parses row.original with it).
const bookingRowSchema = z.object({
  id: z.string(),
  leadId: z.string().optional(),
  leadName: z.string().optional(),
  unitId: z.string().optional(),
  unitNumber: z.string().optional(),
  userName: z.string().optional(),
  amount: z.string().optional(),
  tokenAmount: z.string().nullable().optional(),
  status: z.string().optional(),
  approvedByName: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}) as unknown as Parameters<typeof DataTableRowActions>[0]['rowSchema'];

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
  // T-ProjectSwitch: resolved project from tenant context; id keys API,
  // slugs key hrefs.
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const isOnline = useOnlineStatus();

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML renders no action (user=null) while hydration swaps in the
  // "New booking" button → "Hydration failed because the server rendered
  // HTML didn't match the client." Render the action only after mount
  // (same pattern as the inventory / users pages).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

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

  // T-BOOK-ROLES: the shared helper mirrors the service gate exactly, so the
  // button and the API can't disagree about who may initiate a booking.
  const canCreate = mounted && canInitiateBookings(user?.role);
  const canApprove = mounted && canApproveBookings(user?.role);
  // Delete: ADMIN/OWNER only (mirrors the inventory unit delete). Edit is
  // available to everyone who can see the row - the backend RLS write
  // policy already scopes staff (TELECALLER/SALES_EXEC) to their own
  // bookings via the parent Lead owner.
  const canDelete = mounted && user !== null && isAdminLike(user.role);

  const isFiltered = statusFilter.length > 0 || serverSearch !== undefined;

  const [editTarget, setEditTarget] = useState<BookingRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BookingRow | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<BookingRow | null>(null);
  const deleteBooking = useDeleteBooking();
  const router = useRouter();

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
        accessorKey: 'unitNumber',
        header: 'Unit',
        cell: ({ row }) => {
          const bookingId =
            typeof row.original.id === 'string' ? row.original.id : '';
          const unitNumber =
            typeof row.original.unitNumber === 'string' &&
            row.original.unitNumber.length > 0
              ? row.original.unitNumber
              : null;
          // T-BOOK-LINK (2026-09-15): Unit is the FIRST column and opens the
          // BOOKING. The unit is the booking's natural key
          // (one_active_booking_per_unit = at most one active booking per
          // unit), so it is the identifier operators scan for.
          if (unitNumber === null) {
            return <span className="text-muted-foreground text-sm">-</span>;
          }
          return bookingId.length > 0 ? (
            <Button
              as={Link}
              variant="link"
              href={projectHref(orgSlug, projectSlug, `/bookings/${bookingId}`)}
              className="text-link tabular-nums"
              data-qa="booking-unit-link"
            >
              {unitNumber}
            </Button>
          ) : (
            <span className="text-sm font-medium tabular-nums" data-qa="booking-unit">
              {unitNumber}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'leadName',
        header: 'Lead',
        cell: ({ row }) => {
          const leadName =
            typeof row.original.leadName === 'string' && row.original.leadName.length > 0
              ? row.original.leadName
              : '-';
          // T-BOOK-LINK (2026-09-15, user direction): the Lead cell is plain
          // text - Unit is the single clickable link on the row (it opens the
          // booking). The lead's own page is reached from the row-actions
          // "View lead".
          return (
            <span className="text-sm" data-qa="booking-lead">
              {leadName}
            </span>
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
              {/* T-BOOK-APPROVE: the approval action moved into the row-actions
                  menu ("Approve / Reject"), so this cell no longer needs the
                  buried link - it keeps a plain hint for context. */}
              {canApprove && status === 'TOKEN' ? (
                <span className="mt-1 block font-medium text-amber-700">
                  Awaiting approval
                </span>
              ) : null}
            </div>
          );
        },
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const status = row.original.status ?? '';
          // T-BOOK-APPROVE: TOKEN is the only state with a manager decision
          // pending, so "Review approval" is offered exactly there - to
          // MANAGER/ADMIN/OWNER (the service gate; SALES_EXEC initiates but
          // cannot approve).
          const awaitingApproval = canApprove && status === 'TOKEN';
          const actionItems = [
            ...(awaitingApproval
              ? [
                  {
                    label: 'Approve / Reject',
                    value: 'approve',
                    icon: LuBadgeCheck,
                    onClick: () => setApprovalTarget(row.original),
                  },
                ]
              : []),
            {
              label: 'View details',
              value: 'view',
              icon: LuArrowRight,
              onClick: () =>
                void router.push(
                  projectHref(orgSlug, projectSlug, `/bookings/${row.original.id}`),
                ),
            },
            // T-BOOK-LINK: the Lead cell now opens the BOOKING, so the lead
            // itself needs its own entry point (context switching from a
            // booking back to the CRM record for the customer).
            ...(typeof row.original.leadId === 'string' && row.original.leadId.length > 0
              ? [
                  {
                    label: 'View lead',
                    value: 'view-lead',
                    icon: LuUser,
                    onClick: () =>
                      void router.push(
                        projectHref(orgSlug, projectSlug, `/leads/${row.original.leadId}`),
                      ),
                  },
                ]
              : []),
            {
              label: 'Edit',
              value: 'edit',
              icon: LuPencil,
              onClick: () => setEditTarget(row.original),
            },
            {
              label: 'Delete',
              value: 'delete',
              icon: LuTrash2,
              onClick: () => setDeleteTarget(row.original),
            },
          ].filter((item) => item.value !== 'delete' || canDelete);
          return (
            <div className="text-right">
              <DataTableRowActions
                row={row}
                rowSchema={bookingRowSchema}
                actionItems={actionItems}
              />
            </div>
          );
        },
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [orgSlug, projectSlug, canApprove, canDelete, router],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bookings"
        breadcrumb={[{ label: 'Work' }, { label: 'Bookings' }]}
        subtitle={<BookingPipeline />}
        action={
          canCreate ? (
            <Button as={Link} href={projectHref(orgSlug, projectSlug, '/bookings/new')} leftIcon={<LuPlus className="size-4" />} data-qa="new-booking-button">
              New booking
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

      <BookingApprovalDialog
        booking={approvalTarget}
        open={approvalTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApprovalTarget(null);
        }}
      />

      <BookingEditDialog
        booking={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />

      <DeleteConfirmDialog
        target={deleteTarget}
        pending={deleteBooking.isPending}
        onConfirm={() => {
          if (deleteTarget === null) return;
          deleteBooking.mutate(deleteTarget.id, {
            onSuccess: () => {
              setDeleteTarget(null);
            },
            onError: (error) => {
              const msg = error instanceof Error ? error.message : 'Delete failed';
              toast.error(msg);
            },
          });
        }}
        onCancel={() => {
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function DeleteConfirmDialog({
  target,
  pending,
  onConfirm,
  onCancel,
}: {
  target: BookingRow | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      trigger={null}
      header={{
        title: `Delete booking${target?.leadName ? ` for ${target.leadName}` : ''}?`,
        description:
          'This permanently removes the booking and frees the unit back to available (if no other active booking references it). This action cannot be undone.',
      }}
      cancelButtonText="Cancel"
      confirmButtonText={pending ? 'Deleting...' : 'Delete booking'}
      confirmButtonProps={{
        variant: 'destructive',
        disabled: pending,
      }}
      onConfirm={() => onConfirm()}
      onCancel={() => onCancel()}
    />
  );
}

/**
 * Visual booking-lifecycle indicator for the page header. Replaces the
 * plain "HOLD → TOKEN → APPROVED" text with an icon-per-stage flow:
 *   HOLD (clock) → TOKEN (coins) → APPROVED (badge-check)
 * with a muted "Manager approval is the gating step" caption.
 */
function BookingPipeline() {
  const stages = [
    { icon: LuClock, label: 'On hold' },
    { icon: LuCoins, label: 'Token received' },
    { icon: LuBadgeCheck, label: 'Approved' },
  ];
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {stages.map((stage, index) => (
        <span key={stage.label} className="flex items-center gap-1.5">
          {index > 0 ? (
            <LuArrowRight className="text-muted-foreground/50 size-4" aria-hidden />
          ) : null}
          <span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
            <stage.icon className="size-4" aria-hidden />
            {stage.label}
          </span>
        </span>
      ))}
      <span className="text-muted-foreground ml-1 text-sm">
        · Manager approval is the gating step
      </span>
    </span>
  );
}
