'use client';

// InvitesTab - the admin surface for pending/closed invites.
//
// Container only: it owns the query, the filter state and the pagination, and
// hands presentation to the column builder and row components. Nothing below
// this component calls `useInvites`, so each row does not open its own
// subscription and the empty/error branches exist exactly once.
//
// ALL FOUR STATES ARE REAL, not implicit:
//   loading - the shared Skeleton primitive (not a spinner)
//   empty   - copy + the Invite staff CTA, so the surface is never a dead end
//   error   - role="alert" + a retry that calls refetch
//   filled  - the table
import { Button, Combobox, DataTable, Loading } from '@paalstack/react-ui';
import { useMediaQuery } from '@/lib/use-media-query';
import { useMemo, useState, type ReactNode } from 'react';

import type { InviteStatus } from '@shadhil/api-types';
import { useInvites } from '@/hooks/queries/invites';
import { Skeleton } from '@/components/shared/Skeleton';

import { InviteRowActions } from './InviteRowActions';
import { InvitesEmptyState, buildInviteColumns } from './invites-table-columns';

const STATUS_OPTIONS: ReadonlyArray<{ value: InviteStatus; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'REVOKED', label: 'Revoked' },
];

export function InvitesTab({ createTrigger }: { createTrigger: ReactNode }) {
  const [statusFilter, setStatusFilter] = useState<InviteStatus[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const query = useInvites({
    status: statusFilter.length > 0 ? statusFilter : undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // Compact until the FULL column set actually fits (measured 2026-11-21).
  //
  // This is NOT the Members table's 767px, and the difference is measured, not
  // stylistic: with real rows the eight invite columns need ~871px of
  // max-content width, so at a 768-843px tablet, or an 844px landscape phone,
  // the desktop set overflowed its scroller by 60-130px - the row's right edge
  // passed the viewport edge, which `invites-mobile-audit.spec.ts` reports as
  // sideways scroll. Below 1024 the compact three columns are the only honest
  // layout; at 1024+ there is room for all eight.
  const compact = useMediaQuery('(max-width: 1023px)');

  const columns = useMemo(
    () =>
      buildInviteColumns({
        compact,
        actionsCell: (invite) => <InviteRowActions invite={invite} />,
      }),
    [compact],
  );

  if (query.isLoading) {
    return <Skeleton variant="table" />;
  }

  if (query.error !== null && query.error !== undefined) {
    return (
      // role="alert" so the failure is ANNOUNCED, not just painted red.
      <div
        role="alert"
        className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
      >
        <p className="text-sm font-medium">Couldn&apos;t load invites.</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {query.error instanceof Error ? query.error.message : 'Unexpected error.'}
        </p>
        <Button
          variant="outline"
          className="mt-3"
          onClick={() => void query.refetch()}
          data-qa="invites-retry-button"
        >
          Try again
        </Button>
      </div>
    );
  }

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;

  return (
    <DataTable
      columns={columns}
      rows={rows}
      // The server already applied the filter; a client-side global filter on
      // top would hide rows from the page it was asked for.
      globalFilterFn={() => true}
      showPagination={total > 0}
      paginationProps={{
        total,
        currentPage: page,
        onPageChange: setPage,
        pageSize,
        onPageSizeChange: (size) => {
          setPageSize(size);
          setPage(1);
        },
        pageSizeOptions: [10, 25, 50],
        showTotalResults: true,
        showOnlyIfTotalGreaterThanPageSize: true,
      }}
      // `isLoading` is FIRST-LOAD only, never `isFetching`. Resend/revoke
      // invalidate INVITES_KEY, and DataTable renders `loadingContent` INSTEAD
      // of the rows - so a background refetch unmounted every row, and with it
      // the per-row resend dialog that had just received the new link. The
      // dialog vanished the instant the request succeeded, which is exactly
      // what invites-mobile-audit.spec.ts caught: POST /resend -> 200, then no
      // link on screen. A background refresh must leave the current page up
      // (the row is stale for one paint; the alternative is a dead end).
      isLoading={query.isLoading}
      loadingContent={<Loading content="Loading invites..." />}
      className="[&_td:last-child]:bg-card [&_th:last-child]:bg-card [&_td:last-child]:sticky [&_td:last-child]:right-0 [&_td:last-child]:z-1 [&_th:last-child]:sticky [&_th:last-child]:right-0 [&_th:last-child]:z-1"
      toolbarLeftSideContent={
        <Combobox
          multiple
          value={statusFilter}
          onValueChange={(next) => {
            setStatusFilter(((next as string[]) ?? []) as InviteStatus[]);
            setPage(1); // a new filter starts back at page 1
          }}
          options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          placeholder="Filter by status"
          selectOptionAsValue
          maxSelectedChips={2}
          className="max-w-96 min-w-48"
          data-qa="invites-status-filter"
        />
      }
      emptyContent={<InvitesEmptyState createTrigger={createTrigger} />}
      // The empty state is prose + a CTA, not tabular data. Table cells are
      // `whitespace-nowrap`, which made the empty state 577px wide at a 320px
      // viewport and pushed the CTA 46px past the right edge - a sideways
      // scroll with no visible cue. Real rows can overflow (that is what the
      // scroller is for); prose must wrap.
      emptyContentTableCellProps={{ className: 'whitespace-normal' }}
      tableContainerClassName="rounded-lg border"
    />
  );
}
