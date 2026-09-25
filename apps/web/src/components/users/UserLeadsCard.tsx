'use client';

// User-leads table (T-USER-LEADS, 2026-09-24).
//
// Mounted on /admin/users/[userId] to answer "which leads is this person
// carrying?" with a real, server-filtered table rather than a count.
//
// Semantics: "linked" means the user is the lead's OWNER **or** its
// CO-OWNER - the same definition `team-members.service.preview()` uses for
// "leads linked with a member". A co-owner's workload would otherwise be
// invisible on their own profile.
//
// Server-driven throughout: the project filter, search, sort and pagination
// are all forwarded to GET /api/leads as query params (`linkedUserId`,
// `projectId`, `search`, `sortBy`/`sortDir`, `limit`/`offset`). The
// DataTable's built-in client-side filter/sort only ever sees the loaded
// page, which is wrong under server pagination - hence `globalFilterFn` is
// a no-op and sort state is controlled.
//
// The Project column exists because a user's leads can span projects; it is
// what makes the project filter legible. It renders the project NAME and the
// row's own NAME cell links to that lead's detail page
// (/projects/<slug>/leads/<id>) - the row's own entity, per the repo's
// row-link rule. When the slug is missing the cell falls back to plain text
// rather than emitting a broken href.
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Button, Combobox, DataTable, TypographyP } from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { dateIntl } from '@paalstack/react-ui/lib';

import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { useLeads, useLeadsEnvelope } from '@/hooks/queries/crm';
import { useProjects } from '@/hooks/queries/projects';
import { labelFor } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

/** Minimal row projection (mirrors LeadRow in leads.service.ts). */
type UserLeadRow = {
  id: string;
  name: string;
  phone?: string;
  status?: string;
  source?: string;
  ownerName?: string;
  projectName?: string;
  projectSlug?: string;
  updatedAt?: string;
};

const DEFAULT_PAGE_SIZE = 10;

/**
 * Build the server-side query for "this user's linked leads".
 *
 * Exported and pure so the request shape can be pinned by a test without
 * driving the library's Combobox through jsdom (its option list renders in
 * a portal and a synthetic click is not reliable there - the repo's other
 * Combobox tests only assert presence for the same reason).
 *
 * `linkedUserId` is ALWAYS present and `ownerId` never is: ownerId is
 * owner-only and would silently omit leads this user merely co-owns.
 */
export function buildUserLeadsFilter(params: {
  userId: string;
  projectId?: string;
  search?: string;
  page: number;
  pageSize: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'name';
  sortDir?: 'asc' | 'desc';
}): {
  linkedUserId: string;
  projectId?: string;
  search?: string;
  limit: number;
  offset: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'name';
  sortDir?: 'asc' | 'desc';
} {
  const { userId, projectId, search, page, pageSize, sortBy, sortDir } = params;
  return {
    linkedUserId: userId,
    // '' / undefined means "all projects" - omit the key entirely so the
    // API does not filter on an empty string.
    ...(projectId !== undefined && projectId.length > 0 ? { projectId } : {}),
    // Server-side search only honours >= 2 chars (same contract as the inbox).
    ...(search !== undefined && search.length >= 2 ? { search } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
    ...(sortBy !== undefined ? { sortBy } : {}),
    ...(sortDir !== undefined ? { sortDir } : {}),
  };
}

export function UserLeadsCard({ userId }: { userId: string }) {
  const orgSlug = useOrgSlug();
  const projectsQuery = useProjects();

  // Server-driven filter + pagination state. `''` means "all projects".
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sortBy, setSortBy] = useState<'updatedAt' | 'createdAt' | 'name' | undefined>(
    undefined,
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | undefined>(undefined);

  const filter = buildUserLeadsFilter({
    userId,
    projectId,
    search,
    page,
    pageSize,
    sortBy,
    sortDir,
  });

  const leadsQuery = useLeads(filter);
  const envelope = useLeadsEnvelope(filter);

  const rows = Array.isArray(leadsQuery.data)
    ? (leadsQuery.data as UserLeadRow[])
    : [];
  const total = envelope?.total ?? 0;

  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [projectsQuery.data],
  );

  const columns = useMemo<DataTableColumnDef<UserLeadRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Lead',
        cell: ({ row }) => {
          const lead = row.original;
          // The row's own entity. Without a project slug the detail route
          // cannot be addressed, so render plain text instead of a link
          // that would 404 (honest-state rule: no dead affordances).
          const href =
            typeof lead.projectSlug === 'string' && lead.projectSlug.length > 0
              ? projectHref(orgSlug, lead.projectSlug, `/leads/${lead.id}`)
              : null;
          return (
            <div className="min-w-45">
              {href === null ? (
                <span className="text-sm font-medium" data-qa={`user-lead-${lead.id}`}>
                  {lead.name}
                </span>
              ) : (
                <Button
                  as={Link}
                  variant="link"
                  href={href}
                  className="text-link"
                  data-qa={`user-lead-${lead.id}`}
                >
                  {lead.name}
                </Button>
              )}
              {typeof lead.phone === 'string' && lead.phone.length > 0 ? (
                <span className="text-muted-foreground block text-xs">
                  {lead.phone}
                </span>
              ) : null}
            </div>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <LeadStatusBadge status={row.original.status ?? 'UNKNOWN'} />
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'projectName',
        header: 'Project',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.projectName ?? '-'}
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
        accessorKey: 'updatedAt',
        header: 'Last activity',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {relativeTime(row.original.updatedAt)}
          </span>
        ),
        // Server-side sort (the DataTable's own sort is client-side over the
        // loaded page). Forward through the controlled sorting props.
        enableSorting: true,
      },
    ],
    [orgSlug],
  );

  const isFiltered = filter.search !== undefined || projectId.length > 0;

  return (
    <div className="space-y-3" data-qa="user-leads-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Leads</h2>
        <span className="text-muted-foreground text-xs" data-qa="user-leads-count">
          {leadsQuery.isLoading
            ? 'Loading...'
            : `${total} ${total === 1 ? 'lead' : 'leads'}${isFiltered ? ' matching' : ''}`}
        </span>
      </div>

      {leadsQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : leadsQuery.error !== null && leadsQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load this user&apos;s leads.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {leadsQuery.error instanceof Error
              ? leadsQuery.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void leadsQuery.refetch()}
            data-qa="user-leads-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          // Search + project filter are both server-side; the built-in
          // client filter would only hide rows within the loaded page.
          globalFilterFn={() => true}
          sorting={sortBy !== undefined ? [{ id: sortBy, desc: sortDir === 'desc' }] : []}
          onSortingChange={(next) => {
            const s = next[0];
            if (s && (s.id === 'updatedAt' || s.id === 'createdAt' || s.id === 'name')) {
              setSortBy(s.id);
              setSortDir(s.desc ? 'desc' : 'asc');
              setPage(1);
            }
          }}
          search={{
            accessorKey: ['name', 'phone'],
            placeholder: 'Search by name or phone...',
            searchValue: search,
            onSearchValueChange: (next: string) => {
              setSearch(next);
              setPage(1);
            },
            className: 'mr-2',
          }}
          toolbarLeftSideContent={
            <Combobox
              value={projectId}
              onValueChange={(next) => {
                setProjectId((next as string | null) ?? '');
                setPage(1);
              }}
              options={projectOptions}
              placeholder="All projects"
              selectOptionAsValue
              className="min-w-48 max-w-72"
              data-qa="user-leads-project-filter"
            />
          }
          showPagination
          paginationProps={{
            total,
            currentPage: page,
            onPageChange: setPage,
            pageSize,
            onPageSizeChange: (size: number) => {
              setPageSize(size);
              setPage(1);
            },
            showTotalResults: true,
            showOnlyIfTotalGreaterThanPageSize: true,
          }}
          emptyContent={
            <TypographyP className="text-muted-foreground py-6 text-center text-sm">
              {isFiltered
                ? 'No leads match this filter.'
                : 'No leads are linked to this user yet.'}
            </TypographyP>
          }
          data-qa="user-leads-table"
        />
      )}
    </div>
  );
}

/** Relative time via the library formatter (locale/timezone-consistent). */
function relativeTime(iso: string | undefined): string {
  if (typeof iso !== 'string' || iso.length === 0) return '-';
  const raw = dateIntl.formatRelativeTime(iso);
  if (raw.length === 0) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
