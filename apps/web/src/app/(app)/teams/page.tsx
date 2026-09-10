'use client';

// Org Teams - ADMIN/OWNER ONLY (a manager uses the per-project staff
// surface, not every team). Lists every team + manager + member count;
// clicking a row opens /teams/[teamId] for the roster + project unlinks.
import { useMemo, useState } from 'react';

import {
  Button,
  DataTable,
  Heading,
  Loading,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { LuUsersRound } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useEffect } from 'react';

import { useTeams, type TeamListItem } from '@/hooks/queries/teams';
import { isAdminLike, useSessionUser } from '@/lib/session';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';

export default function TeamsPage() {
  // Hooks MUST all be called unconditionally, before any early return, to
  // keep the hook order stable across renders (React rules of hooks).
  const { user, isPending: sessionPending } = useSessionUser();
  const teams = useTeams();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="users" className="py-4" />;
  }
  if (user === null || !isAdminLike(user.role)) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only admins can view the org teams.
        </TypographyP>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Teams"
        breadcrumb={[{ label: 'Admin' }, { label: 'Teams' }]}
        subtitle={
          isAdminLike(user.role)
            ? 'Every team across the organization.'
            : 'Your team.'
        }
      />

      {teams.isLoading ? (
        <Skeleton variant="table" />
      ) : teams.error !== null && teams.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load teams.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {teams.error instanceof Error
              ? teams.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void teams.refetch()}
            data-qa="teams-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : (
        <TeamsTable teams={teams.data ?? []} />
      )}
    </div>
  );
}

function TeamsTable({ teams }: { teams: TeamListItem[] }) {
  const columns = useMemo<DataTableColumnDef<TeamListItem>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Team',
        cell: ({ row }) => (
          <Link
            href={`/teams/${row.original.id}`}
            className="text-link text-sm font-medium hover:underline hover:underline-offset-2"
            data-qa={`team-row-link-${row.original.id}`}
          >
            {row.original.name}
          </Link>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'managerName',
        header: 'Manager',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.managerName ?? 'No manager assigned'}
          </span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'memberCount',
        header: 'Members',
        cell: ({ row }) => (
          <span className="text-sm">{row.original.memberCount}</span>
        ),
        enableSorting: true,
      },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <DataTable
        columns={columns}
        rows={teams}
        showPagination
        paginationProps={{
          pageSize: 10,
          pageSizeOptions: [10, 25, 50],
          showTotalResults: true,
          showOnlyIfTotalGreaterThanPageSize: true,
        }}
        loadingContent={<Loading content="Loading teams..." />}
        emptyContent={
          <div className="rounded-lg p-10 text-center space-y-1">
            <LuUsersRound className="mx-auto size-8 text-muted-foreground" />
            <TypographyP className="text-xl font-medium">No teams yet.</TypographyP>
            <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
              Create a team to get started.
            </TypographyP>
          </div>
        }
        tableContainerClassName="rounded-lg border"
      />
    </div>
  );
}
