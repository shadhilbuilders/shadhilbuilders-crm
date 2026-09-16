'use client';

// Lead Inbox (Wireframes #4 + Implementation Plan Week 4) - REBUILT on the
// @paalstack/react-ui DataTable (autoplan 2026-09-07, plan §1) with SERVER
// pagination (T-SRVPG, 2026-09-07).
//
//   Summary line: "N overdue · M new today" above the table (D12) - the
//     SLA answer is visible before any filtering. The counts now come from
//     the server (LeadListResult.overdueCount / newTodayCount) computed for
//     the FULL filtered set, so they stay correct across pages.
//   DataTable toolbar (storybook `ToolbarWithRightSideContent` pattern):
//     - search lives IN the toolbar, server-side (D9) - wired to useLeads
//       search param via onSearchValueChange (≥2 chars hits the API).
//     - the "+ New lead" button is the toolbar's right-side content
//       (role-gated: hidden for TELECALLER per Plan §3).
//     - status filter is a server-driven MultiSelect (toolbar left side) -
//       the DataTable's built-in facet filter is client-side over the loaded
//       page, which is wrong under server pagination. Selection feeds the
//       `state` query param.
//   Pagination: SERVER-side. The page passes `total`/`currentPage`/
//     `onPageChange`/`onPageSizeChange` to the DataTable; each page change
//     refetches `{ limit, offset }` from the API. Selection OFF (D11).
//   Columns (D12 order): Name+phone → Status(+Overdue) → Last activity →
//     Owner → Source (reference data demoted to last).
//   Sort: overdue-first is enforced SERVER-side (Decision 0.2) so pages
//     come back in a consistent order - NEW + createdAt older than 30 min
//     float to the top (freshest first), then most recent activity.
//   Row actions: View / Edit (LeadEditDialog) / Delete (canDeleteLeads
//     only, D14) with AlertDialog confirm (Cancel gets initial focus).
//   URL state (D23): search survives back-navigation via useSearchParams.
import { Button, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger, TypographyP, toast } from '@paalstack/react-ui';
import { AlertDialog, DataTable, DataTableColumnHeaderToggle, DataTableRowActions, MultiSelect } from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { dateIntl } from '@paalstack/react-ui/lib';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { z } from 'zod';

import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { LeadEditDialog } from '@/components/leads/LeadEditDialog';
import { LeadReassignDialog } from '@/components/leads/LeadReassignDialog';

import {
  useDeleteLead,
  useLeads,
  useLeadsEnvelope,
} from '@/hooks/queries/crm';
import { projectHref } from '@/lib/nav';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { canDeleteLeads, canReassign, useSessionUser } from '@/lib/session';
import { isOverdue, leadAgeTier, LEAD_AGE_TIER_CLASS, LEAD_STATES } from '@/lib/leads';
import { useAgingTick } from '@/lib/use-aging-tick';
import { labelFor } from '@/lib/labels';

import { PageHeader } from '@/components/shared/PageHeader';
import { LuInfo, LuPlus } from '@paalstack/react-icons/lu';

type LeadRow = {
  id: string;
  name: string;
  phone?: string;
  status?: string;
  source?: string;
  ownerName?: string;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
};

const DEFAULT_PAGE_SIZE = 10;

// Zod schema for DataTableRowActions (it parses row.original with it).
// Cast to the library's AnyZodObject shape (zod v4 vs the lib's v3-typed
// reference) - the schema itself is the source of truth for the row shape.
const leadRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  ownerName: z.string().optional(),
  ownerId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}) as unknown as Parameters<typeof DataTableRowActions>[0]['rowSchema'];

function relativeTime(iso: string | undefined): string {
  if (typeof iso !== 'string' || iso.length === 0) return '-';
  // Library canonical relative-time formatter (date-fns formatRelative):
  // "5 minutes ago", "today at 14:05", "2 Sep", etc. Deterministic per
  // the library's locale/timezone config - no hand-rolled Date.now()
  // math that could diverge between SSR and the client.
  const raw = dateIntl.formatRelativeTime(iso);
  // The library returns lowercase day prefixes ("last Wednesday at 1:19 AM",
  // "today at 14:05"). Capitalize the first letter so the cell reads as a
  // sentence ("Last Wednesday at 1:19 AM").
  if (raw.length === 0) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export default function LeadInboxPage() {
  // useSearchParams() must be inside a Suspense boundary (Next.js App
  // Router requirement - same pattern as the login page) or the client
  // render throws a hydration mismatch. The inner component holds the
  // real page; this wrapper provides the boundary.
  return (
    <Suspense fallback={<Skeleton variant="table" />}>
      <LeadInboxPageInner />
    </Suspense>
  );
}

function LeadInboxPageInner() {
  const { user } = useSessionUser();
  // T-ProjectSwitch: the resolved project comes from tenant context;
  // id keys API hooks, slugs key hrefs.
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

  // D23: search lives in the URL so back-navigation restores the slice.
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlSearch = searchParams.get('q') ?? '';

  const [search, setSearch] = useState(urlSearch);
  // D9: server-side search, ≥2 chars (same contract as pre-rewrite page).
  const serverSearch = search.length >= 2 ? search : undefined;

  // T-SRVPG: server pagination state. Page is 1-indexed (the DataTable's
  // Pagination component is 1-indexed); offset = (page - 1) * pageSize.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // Server-driven status filter (replaces the DataTable's client-side
  // facet filter, which only sees the loaded page).
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  // Server-side sort (T-SRVPG): the DataTable sorts client-side over the
  // loaded page, which is wrong under server pagination. The page passes
  // the sort column + direction to the API. Default: NO sort (undefined) -
  // the server returns its natural/default ordering (overdue NEW first,
  // then fresh NEW, then the rest, each most-recent) until the user
  // explicitly picks a column.
  const [sortBy, setSortBy] = useState<'updatedAt' | 'createdAt' | 'name' | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | undefined>(undefined);

  const filter = {
    projectId: projectId ?? undefined,
    search: serverSearch,
    state: selectedStates.length > 0 ? selectedStates : undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    sortBy,
    sortDir,
  } as const;

  const leadsQuery = useLeads(filter);
  const envelope = useLeadsEnvelope(filter);

  const rows = Array.isArray(leadsQuery.data) ? (leadsQuery.data as LeadRow[]) : [];
  const total = envelope?.total ?? 0;
  const overdueCount = envelope?.overdueCount ?? 0;
  const newTodayCount = envelope?.newTodayCount ?? 0;

  const canDelete = user !== null && canDeleteLeads(user.role);
  const canAssign = user !== null && canReassign(user.role);
  const staffLane =
    user !== null && (user.role === 'TELECALLER' || user.role === 'SALES_EXEC');
  const canCreate = user !== null && user.role !== 'TELECALLER';

  const [editTarget, setEditTarget] = useState<LeadRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LeadRow | null>(null);
  const [reassignTarget, setReassignTarget] = useState<LeadRow | null>(null);
  const deleteLead = useDeleteLead(deleteTarget?.id ?? null);

  function syncUrl(nextQ: string) {
    const usp = new URLSearchParams();
    if (nextQ.length >= 2) usp.set('q', nextQ);
    const qs = usp.toString();
    void router.replace(qs.length > 0 ? `?${qs}` : '?', { scroll: false });
  }

  function applySearch(next: string) {
    setSearch(next);
    setPage(1); // a new search starts back at page 1
    syncUrl(next); // URL carries the server-effective search (≥2 chars)
  }

  function applyStates(next: string[]) {
    setSelectedStates(next);
    setPage(1); // a new filter starts back at page 1
  }

  const summaryParts: string[] = [];
  if (overdueCount > 0) summaryParts.push(`${overdueCount} overdue`);
  if (newTodayCount > 0) summaryParts.push(`${newTodayCount} new today`);
  const summaryLine =
    summaryParts.length > 0
      ? summaryParts.join(' · ')
      : staffLane
        ? 'Nothing overdue for you right now.'
        : 'No overdue first-touch. Queue is clear.';

  const isFiltered = serverSearch !== undefined || selectedStates.length > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Lead Inbox"
        breadcrumb={[{ label: 'Work' }, { label: 'Leads' }]}
        subtitle={
          staffLane
            ? 'Your assigned leads, next action first.'
            : 'Team lead queue with overdue-first sorting.'
        }
      />

      {/* D12: calm summary line - the queue's one question answered first. */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 px-1 text-sm" data-qa="leads-summary">
        <span>{summaryLine}</span>
        <TooltipProvider>
          <TooltipRoot>
            <TooltipTrigger
              className="text-muted-foreground/60 hover:text-muted-foreground inline-flex cursor-help items-center"
              aria-label="What do these counts mean?"
              data-qa="leads-summary-info"
            >
              <LuInfo className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64">
              <div className="space-y-1.5 text-xs">
                <p>
                  <span className="font-medium">Overdue</span> - NEW leads that
                  haven't been contacted within 30 minutes of creation (the
                  time-to-first-touch SLA).
                </p>
                <p>
                  <span className="font-medium">New today</span> - leads created
                  today that are still in the NEW state.
                </p>
              </div>
            </TooltipContent>
          </TooltipRoot>
        </TooltipProvider>
      </div>

      {leadsQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : leadsQuery.error !== null && leadsQuery.error !== undefined ? (
        // D21: list fetch errors are retryable - inline error + retry,
        // not ModulePending (that surface means "module not shipped").
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load the lead queue.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {leadsQuery.error instanceof Error
              ? leadsQuery.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void leadsQuery.refetch()}
            data-qa="leads-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : Array.isArray(leadsQuery.data) ? (
        <LeadTable
          rows={rows}
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          sortBy={sortBy}
          sortDir={sortDir}
          onSortChange={(by, dir) => {
            setSortBy(by);
            setSortDir(dir);
            setPage(1); // a new sort starts back at page 1
          }}
          selectedStates={selectedStates}
          onStatesChange={applyStates}
          projectSlug={projectSlug}
          orgSlug={orgSlug}
          canDelete={canDelete}
          canCreate={canCreate}
          isFiltered={isFiltered}
          search={search}
          onSearchChange={applySearch}
          onEdit={(row) => {
            setEditTarget(row);
          }}
          onDelete={(row) => {
            setDeleteTarget(row);
          }}
          onReassign={(row) => {
            setReassignTarget(row);
          }}
          onView={(row) => {
            if (projectId === null) return;
            void router.push(projectHref(orgSlug, projectSlug, `/leads/${row.id}`));
          }}
          canAssign={canAssign}
        />
      ) : null}

      <LeadEditDialog
        lead={
          editTarget === null
            ? null
            : {
                id: editTarget.id,
                name: editTarget.name,
                phone: editTarget.phone ?? '',
                email: null,
              }
        }
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />

      <DeleteConfirmDialog
        target={deleteTarget}
        pending={deleteLead.isPending}
        onConfirm={() => {
          if (deleteTarget === null) return;
          deleteLead.mutate(undefined, {
            onSuccess: () => {
              setDeleteTarget(null);
            },
            onError: (error) => {
              // Server copy arrives verbatim (409 guidance, 403 reason).
              const msg =
                error instanceof Error ? error.message : 'Delete failed';
              toast.error(msg);
            },
          });
        }}
        onCancel={() => {
          setDeleteTarget(null);
        }}
      />

      <LeadReassignDialog
        lead={
          reassignTarget === null
            ? null
            : { id: reassignTarget.id, name: reassignTarget.name }
        }
        currentOwnerId={reassignTarget?.ownerId ?? ''}
        open={reassignTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReassignTarget(null);
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
  target: LeadRow | null;
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
        title: `Delete ${target?.name ?? 'lead'}?`,
        description:
          'This permanently removes the lead, its chat history, activities, and visits. This action cannot be undone.',
      }}
      cancelButtonText="Cancel"
      confirmButtonText={pending ? 'Deleting...' : 'Delete lead'}
      confirmButtonProps={{
        variant: 'destructive',
        disabled: pending,
      }}
      onConfirm={() => onConfirm()}
      onCancel={() => onCancel()}
      
    />
  );
}

function LeadTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  sortBy,
  sortDir,
  onSortChange,
  selectedStates,
  onStatesChange,
  projectSlug,
  orgSlug,
  canDelete,
  canAssign,
  canCreate,
  isFiltered,
  search,
  onSearchChange,
  onEdit,
  onDelete,
  onReassign,
  onView,
}: {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  sortBy: 'updatedAt' | 'createdAt' | 'name' | undefined;
  sortDir: 'asc' | 'desc' | undefined;
  onSortChange: (by: 'updatedAt' | 'createdAt' | 'name', dir: 'asc' | 'desc') => void;
  selectedStates: string[];
  onStatesChange: (states: string[]) => void;
  projectSlug: string | null;
  orgSlug: string | null;
  canDelete: boolean;
  canAssign: boolean;
  canCreate: boolean;
  isFiltered: boolean;
  search: string;
  onSearchChange: (next: string) => void;
  onEdit: (row: LeadRow) => void;
  onDelete: (row: LeadRow) => void;
  onReassign: (row: LeadRow) => void;
  onView: (row: LeadRow) => void;
}) {
  // Row tints age in real time (10/20/30-min tiers), so the table needs a
  // coarse heartbeat - otherwise a lead that crosses a boundary while the
  // operator is reading the page stays white until the next refetch.
  // Only tick when there is something that can age: a page with no NEW lead
  // has no tint to update, so we avoid the timer entirely.
  const hasNewLead = rows.some((r) => r.status === 'NEW');
  const tick = useAgingTick(hasNewLead);

  /**
   * Row tint by lead age (user request 2026-09-15). Tiers live in
   * `@/lib/leads` so they are unit-tested + reusable; this only maps a row to
   * its class. `tick` is in the deps on purpose: it is what makes the table
   * re-evaluate the tiers as time passes.
   *
   * Returns undefined (no class) for everything else, so a non-NEW row keeps
   * the table's default background.
   */
  const getRowClassName = useMemo(() => {
    void tick;
    const now = Date.now();
    return (row: { original: LeadRow }): string | undefined => {
      const tier = leadAgeTier(row.original, now);
      return tier === null ? undefined : LEAD_AGE_TIER_CLASS[tier];
    };
  }, [tick]);

  const columns = useMemo<DataTableColumnDef<LeadRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-45">
            <Button
              as={Link}
              variant='link'
              href={projectHref(orgSlug, projectSlug, `/leads/${row.original.id}`)}
              className="text-link"
            >
              {row.original.name}
            </Button>
            {typeof row.original.phone === 'string' &&
            row.original.phone.length > 0 ? (
              <span className="text-muted-foreground block text-xs">
                {row.original.phone}
              </span>
            ) : null}
          </div>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const overdue = isOverdue(row.original);
          return (
            <span className="flex flex-wrap items-center gap-1.5">
              <LeadStatusBadge status={row.original.status ?? 'UNKNOWN'} />
              {overdue ? (
                <span
                  className="bg-warning-soft text-warning-foreground inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                  data-qa="lead-overdue-badge"
                >
                  Overdue
                </span>
              ) : null}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'updatedAt',
        header: ({ column }) => (
          <DataTableColumnHeaderToggle column={column} title="Last Activity" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {relativeTime(row.original.updatedAt)}
          </span>
        ),
        // Server-side sort (T-SRVPG): the DataTable's built-in sorting is
        // client-side over the loaded page, which is wrong under server
        // pagination. Enable the column header so the user can click it;
        // the sort state is forwarded to the API via onSortingChange.
        enableSorting: true,
      },
      {
        accessorKey: 'ownerName',
        header: 'Owner',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.ownerName ?? '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'source',
        header: 'Source',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.source ? labelFor('source', row.original.source) : '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        // TODO(a11y): pass `ariaLabel={`Actions for ${row.original.name}`}`
        // to DataTableRowActions once @paalstack/react-ui ships the new
        // ariaLabel prop (added to source 2026-09-07, awaiting publish).
        cell: ({ row }) => (
          <div className="text-right">
            <DataTableRowActions
              row={row}
              rowSchema={leadRowSchema}
              actionItems={[
                { label: 'View', value: 'view', onClick: () => onView(row.original) },
                { label: 'Edit', value: 'edit', onClick: () => onEdit(row.original) },
                { label: 'Assign', value: 'assign', onClick: () => onReassign(row.original) },
                { label: 'Delete', value: 'delete', onClick: () => onDelete(row.original) },
              ].filter(
                (item) =>
                  (item.value !== 'assign' || canAssign) &&
                  (item.value !== 'delete' || canDelete),
              )}
            />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [projectSlug, orgSlug, canDelete, canAssign, onEdit, onDelete, onReassign, onView],
  );

  const statusOptions = useMemo(
    () =>
      LEAD_STATES.map((state) => ({
        value: state,
        label: labelFor('lead', state),
      })),
    [],
  );

  return (
    <DataTable
      columns={columns}
      rows={rows}
      // Age-based row tint (10/20/30-min tiers for NEW leads). The props-API
      // DataTable merges this AFTER its base classes, so the tint wins.
      getRowClassName={getRowClassName}
      // Search is server-side (onSearchValueChange → API). The DataTable's
      // built-in client-side global filter is redundant here AND throws
      // "Column with id 'phone' does not exist" because there is no standalone
      // phone column (phone renders inside the Name cell). Make the client
      // filter a no-op so it never hides rows or looks up a missing column -
      // the backend already returns the filtered set.
      globalFilterFn={() => true}
      // Server-side sort (T-SRVPG): forward the sort state to the API.
      // The DataTable's built-in sorting is client-side over the loaded
      // page, which is wrong under server pagination - so we drive it
      // through the controlled `sorting`/`onSortingChange` props and
      // refetch with the new sortBy/sortDir. Empty array = no sort
      // (server default ordering) until the user picks a column.
      sorting={sortBy !== undefined ? [{ id: sortBy, desc: sortDir === 'desc' }] : []}
      onSortingChange={(next) => {
        const s = next[0];
        if (s && (s.id === 'updatedAt' || s.id === 'createdAt' || s.id === 'name')) {
          onSortChange(s.id, s.desc ? 'desc' : 'asc');
        }
      }}
      // Storybook `ToolbarWithRightSideContent` pattern: search lives in
      // the toolbar (server-side via onSearchValueChange, D9) and the
      // create button is the toolbar's right-side content.
      search={{
        accessorKey: ['name', 'phone'],
        placeholder: 'Search by name or phone...',
        searchValue: search,
        onSearchValueChange: onSearchChange,
        className: 'ml-2'
      }}
      // Server-driven status filter (T-SRVPG): the DataTable's built-in
      // facet filter is client-side over the loaded page, which is wrong
      // under server pagination. A MultiSelect in the toolbar's left side
      // feeds the `state` query param instead.
      toolbarLeftSideContent={
        <MultiSelect
          options={statusOptions}
          selectedValues={selectedStates}
          onSelectedValueChange={onStatesChange}
          placeholder="Filter by status"
          // Wide enough trigger + dropdown so the longest status labels
          // ("Booking in progress", "Didn't show up") don't wrap or clip,
          // and selected-state badges have room when multiple are picked.
          // max-w keeps the filter from sprawling when many states are selected
          // and keeps the dropdown readable (no ultra-wide column).
          // maxSelectedBadges collapses the trigger to the first 3 badges +
          // a "+N selected" summary when more than 3 states are picked, so
          // the button doesn't overflow with every selection.
          maxSelectedBadges={2}
          triggerProps={{
            size: 'sm',
            variant: 'outline',
            className: 'min-w-48 max-w-96',
          }}
          contentProps={{ className: 'min-w-56 max-w-96' }}
          className='w-full'
          data-qa="leads-status-filter"
        />
      }
      toolbarRightSideContent={
        canCreate ? (
          <Button asChild>
            <Link href={projectHref(orgSlug, projectSlug, '/leads/new')} data-qa="new-lead-button">
             <LuPlus className='size-4' />
              New lead
            </Link>
          </Button>
        ) : null
      }

      showPagination
      paginationProps={{
        total,
        currentPage: page,
        onPageChange,
        pageSize,
        onPageSizeChange,
        showTotalResults: true,
        showOnlyIfTotalGreaterThanPageSize: true,
      }}
      emptyContent={
        isFiltered ? (
          <div className="rounded-lg p-10 text-center space-y-1">
            <TypographyP className="text-xl font-medium">No leads match this search.</TypographyP>
            <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
              Check the spelling or try a different number.
            </TypographyP>
          </div>
        ) : (
          <div className="rounded-lg p-10 text-center space-y-1">
            <TypographyP className="text-xl font-medium">No leads yet.</TypographyP>
            <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
              They&apos;ll appear here as soon as the landing-site webhook fires
              or a lead is created manually.
            </TypographyP>
          </div>
        )
      }
      tableContainerClassName="rounded-lg border"
    />
  );
}
