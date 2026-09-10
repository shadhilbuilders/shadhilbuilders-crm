'use client';

// Inventory - villa/unit availability grid (DESIGN.md §2 module 4,
// Implementation Plan Week 7): Villa #, BHK, Facing, Sqft, Price, Status
// with Project/Phase/BHK/Facing/Status filters; click unit → detail panel
// with hold + booking flow.
//
// Backend (2026-09-10, inventory module live) returns UnitListResult =
// { total, rows }. useInventoryUnits unwraps the rows (T-F1). Filters are
// SERVER-driven (T-SRVPG): the DataTable's built-in facet filter is
// client-side over the loaded page, which is wrong under server
// pagination - so a Combobox (status) + Selects (phase/BHK/facing)
// feed the query params instead.
import { Badge, Button, Combobox, DataTable, Select, TypographyP, AlertDialog, DataTableRowActions, toast } from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { LuPencil, LuPlus, LuTrash2 } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState, useEffect } from 'react';
import { z } from 'zod';

import { Skeleton } from '@/components/shared/Skeleton';
import { UnitDetailSheet } from '@/components/inventory/UnitDetailSheet';
import { UnitEditDialog } from '@/components/inventory/UnitEditDialog';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  useDeleteUnit,
  useInventoryPhases,
  useInventoryUnits,
  useInventoryUnitsEnvelope,
  type UnitRow,
} from '@/hooks/queries/inventory';
import { labelFor, INVENTORY_STATUSES, type InventoryStatus } from '@/lib/labels';
import { currencyIntl, numberIntl } from '@/lib/format';
import { projectHref } from '@/lib/nav';
import { useSessionUser } from '@/lib/session';

import { PageHeader } from '@/components/shared/PageHeader';

const DEFAULT_PAGE_SIZE = 10;

// Zod schema for DataTableRowActions (it parses row.original with it).
const unitRowSchema = z.object({
  id: z.string(),
  phaseId: z.string(),
  phaseName: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  unitNumber: z.string(),
  bhk: z.number(),
  facing: z.string().nullable(),
  sqft: z.number().nullable(),
  price: z.string(),
  status: z.string(),
  createdAt: z.string(),
}) as unknown as Parameters<typeof DataTableRowActions>[0]['rowSchema'];

function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

const STATUS_BADGE_VARIANT: Record<InventoryStatus, 'success' | 'warning' | 'info' | 'destructive'> = {
  AVAILABLE: 'success',
  HOLD: 'warning',
  TOKEN: 'info',
  SOLD: 'destructive',
};

function isInventoryStatus(value: string): value is InventoryStatus {
  return (INVENTORY_STATUSES as readonly string[]).includes(value);
}

export default function InventoryPage() {
  const { user } = useSessionUser();
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const isOnline = useOnlineStatus();

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML renders no action (user=null) while hydration swaps in the
  // "New unit" button → "Hydration failed because the server rendered HTML
  // didn't match the client." Render the action only after mount (same
  // pattern as app-header.tsx / audit page).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Server-driven filters (T-SRVPG).
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [phaseFilter, setPhaseFilter] = useState<string>('ALL');
  const [bhkFilter, setBhkFilter] = useState<string>('ALL');
  const [facingFilter, setFacingFilter] = useState<string>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const phasesQuery = useInventoryPhases(projectId ?? undefined);
  const phases = phasesQuery.data ?? [];

  const filter = {
    projectId: projectId ?? undefined,
    phaseId: phaseFilter !== 'ALL' ? phaseFilter : undefined,
    bhk: bhkFilter !== 'ALL' ? Number(bhkFilter) : undefined,
    facing: facingFilter !== 'ALL' ? facingFilter : undefined,
    status: statusFilter.length > 0 ? statusFilter : undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  } as const;

  const unitsQuery = useInventoryUnits(filter);
  const total = useInventoryUnitsEnvelope(filter);
  const rows = Array.isArray(unitsQuery.data) ? (unitsQuery.data as UnitRow[]) : [];

  const [detailTarget, setDetailTarget] = useState<UnitRow | null>(null);
  const [editTarget, setEditTarget] = useState<UnitRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UnitRow | null>(null);
  const deleteUnit = useDeleteUnit();

  const canEdit =
    mounted && user !== null && (user.role === 'ADMIN' || user.role === 'OWNER');

  const isFiltered =
    statusFilter.length > 0 ||
    phaseFilter !== 'ALL' ||
    bhkFilter !== 'ALL' ||
    facingFilter !== 'ALL';

  const statusOptions = useMemo(
    () =>
      INVENTORY_STATUSES.map((s) => ({
        value: s,
        label: labelFor('inventory', s),
      })),
    [],
  );

  const phaseOptions = useMemo(
    () => [
      { value: 'ALL', label: 'All phases' },
      ...phases.map((p) => ({ value: p.id, label: p.name })),
    ],
    [phases],
  );

  const bhkOptions = useMemo(
    () => [
      { value: 'ALL', label: 'All BHK' },
      { value: '2', label: '2 BHK' },
      { value: '3', label: '3 BHK' },
      { value: '4', label: '4 BHK' },
    ],
    [],
  );

  const facingOptions = useMemo(
    () => [
      { value: 'ALL', label: 'All facings' },
      { value: 'North', label: 'North' },
      { value: 'South', label: 'South' },
      { value: 'East', label: 'East' },
      { value: 'West', label: 'West' },
    ],
    [],
  );

  const columns = useMemo<DataTableColumnDef<UnitRow>[]>(
    () => [
      {
        accessorKey: 'unitNumber',
        header: 'Villa #',
        cell: ({ row }) => (
          <Button
            variant="link"
            onClick={() => setDetailTarget(row.original)}
            data-qa="unit-detail-trigger"
            className="text-link"
          >
            {row.original.unitNumber}
          </Button>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'bhk',
        header: 'BHK',
        cell: ({ row }) => (
          <span className="text-sm">{row.original.bhk} BHK</span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'facing',
        header: 'Facing',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.facing ?? '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'sqft',
        header: 'Sqft',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {row.original.sqft !== null ? numberIntl.format(row.original.sqft) : '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'price',
        header: 'Price (₹)',
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{formatMoney(row.original.price)}</span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const status = row.original.status;
          const variant = isInventoryStatus(status)
            ? STATUS_BADGE_VARIANT[status]
            : 'muted';
          return (
            <Badge
              variant={variant}
              data-qa="unit-status-badge"
            >
              {isInventoryStatus(status) ? labelFor('inventory', status) : status || '-'}
            </Badge>
          );
        },
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="text-right">
            <DataTableRowActions
              row={row}
              rowSchema={unitRowSchema}
              actionItems={[
                { label: 'Edit', value: 'edit', icon: LuPencil, onClick: () => setEditTarget(row.original) },
                { label: 'Delete', value: 'delete', icon: LuTrash2, onClick: () => setDeleteTarget(row.original) },
              ].filter((item) => item.value !== 'delete' || canEdit)}
            />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [canEdit],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        breadcrumb={[{ label: 'Work' }, { label: 'Inventory' }]}
        subtitle="Villa availability by phase, BHK, and facing."
        action={
          canEdit ? (
            <Button as={Link} href={projectHref(projectId, '/inventory/new')} leftIcon={<LuPlus className="size-4" />} data-qa="new-unit-button">
              New unit
            </Button>
          ) : null
        }
      />

      {unitsQuery.isLoading ? (
        <Skeleton variant="table" isOffline={!isOnline} />
      ) : unitsQuery.error !== null && unitsQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load the inventory.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {unitsQuery.error instanceof Error
              ? unitsQuery.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void unitsQuery.refetch()}
            data-qa="inventory-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          toolbarRightSideContainerClassName='flex-1 justify-start'
          toolbarLeftSideContent={
            <div className="flex flex-wrap flex-1 items-center gap-2">
              <Combobox
                multiple
                value={statusFilter}
                onValueChange={(next) => {
                  setStatusFilter((next as string[]) ?? []);
                  setPage(1);
                }}
                options={statusOptions}
                placeholder="Filter by status"
                className="sm:max-w-64"
                data-qa="inventory-status-filter"
                maxSelectedChips={1}
              />
              <Select
                value={phaseFilter}
                onValueChange={(next) => {
                  setPhaseFilter(next ?? 'ALL');
                  setPage(1);
                }}
                options={phaseOptions}
                placeholder="All phases"
                className="w-40"
                data-qa="inventory-phase-filter"
              />
              <Select
                value={bhkFilter}
                onValueChange={(next) => {
                  setBhkFilter(next ?? 'ALL');
                  setPage(1);
                }}
                options={bhkOptions}
                placeholder="All BHK"
                className="w-32"
                data-qa="inventory-bhk-filter"
              />
              <Select
                value={facingFilter}
                onValueChange={(next) => {
                  setFacingFilter(next ?? 'ALL');
                  setPage(1);
                }}
                options={facingOptions}
                placeholder="All facings"
                className="w-36"
                data-qa="inventory-facing-filter"
              />
            </div>
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
                  No units match these filters.
                </TypographyP>
                <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                  Try clearing a filter.
                </TypographyP>
              </div>
            ) : (
              <div className="rounded-lg p-10 text-center space-y-1">
                <TypographyP className="text-xl font-medium">No inventory yet.</TypographyP>
                <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                  Units appear here as soon as they&apos;re added to a phase.
                </TypographyP>
              </div>
            )
          }
          tableContainerClassName="rounded-lg"
        />
      )}

      <UnitDetailSheet
        unit={detailTarget}
        onOpenChange={(open) => {
          if (!open) setDetailTarget(null);
        }}
        projectId={projectId}
      />

      <UnitEditDialog
        unit={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />

      <DeleteConfirmDialog
        target={deleteTarget}
        pending={deleteUnit.isPending}
        onConfirm={() => {
          if (deleteTarget === null) return;
          deleteUnit.mutate(deleteTarget.id, {
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
  target: UnitRow | null;
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
        title: `Delete unit ${target?.unitNumber ?? ''}?`,
        description:
          'This permanently removes the unit from inventory. This action cannot be undone.',
      }}
      cancelButtonText="Cancel"
      confirmButtonText={pending ? 'Deleting...' : 'Delete unit'}
      confirmButtonProps={{
        variant: 'destructive',
        disabled: pending,
      }}
      onConfirm={() => onConfirm()}
      onCancel={() => onCancel()}
    />
  );
}
