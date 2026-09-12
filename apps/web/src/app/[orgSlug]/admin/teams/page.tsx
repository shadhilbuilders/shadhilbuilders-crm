'use client';

// Org Teams - ADMIN/OWNER ONLY (a manager uses the per-project staff
// surface, not every team). Lists every team + manager + member count;
// clicking a row opens /teams/[teamId] for the roster + project unlinks.
//
// T-TEAM-CRUD (2026-09-13): full CRUD + delete-guard + reassign.
//   - Create/Edit  -> Dialog wrapping TeamFormBody (rule 7c body).
//   - Delete       -> Dialog wrapping TeamDeleteBody (409 when members or
//                     an active manager still exist; inline "Reassign all
//                     members" shortcut unblocks it without leaving the
//                     dialog).
//   - Reassign all -> AlertDialog wrapping TeamReassignAllDialog (one-click
//                     bulk action, also reachable from the row menu
//                     directly, not just the delete-blocked path).
import { useEffect, useMemo, useState } from 'react';

import {
  Button,
  DataTable,
  Dialog,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Heading,
  Loading,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import {
  LuEllipsis,
  LuPencil,
  LuPlus,
  LuTrash2,
  LuUsersRound,
} from '@paalstack/react-icons/lu';
import Link from 'next/link';

import { useTeams, type TeamListItem } from '@/hooks/queries/teams';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  TeamFormBody,
  TeamDeleteBody,
  TeamReassignAllDialog,
} from '@/components/teams/team-form-bodies';

export default function TeamsPage() {
  // Hooks MUST all be called unconditionally, before any early return, to
  // keep the hook order stable across renders (React rules of hooks).
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const teams = useTeams();
  const [mounted, setMounted] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TeamListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamListItem | null>(null);
  const [reassignTarget, setReassignTarget] = useState<TeamListItem | null>(null);

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
        subtitle="Create, rename, and delete teams. Deleting a team with members or an active manager is blocked."
        action={
          <Dialog
            trigger={
              <Button leftIcon={<LuPlus className="h-4 w-4" />}>
                New team
              </Button>
            }
            header={{ title: 'Create a team' }}
            open={createOpen}
            onOpenChange={setCreateOpen}
            contentClassName="sm:max-w-md"
          >
            <TeamFormBody mode="create" onDone={() => setCreateOpen(false)} />
          </Dialog>
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
        <TeamsTable
          teams={teams.data ?? []}
          orgSlug={orgSlug}
          onEdit={setEditTarget}
          onDelete={setDeleteTarget}
          onReassign={setReassignTarget}
        />
      )}

      <EditTeamDialog target={editTarget} onClose={() => setEditTarget(null)} />
      <DeleteTeamDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
      {reassignTarget !== null ? (
        <TeamReassignAllDialog
          team={reassignTarget}
          open={reassignTarget !== null}
          onOpenChange={(open) => {
            if (!open) setReassignTarget(null);
          }}
          onDone={() => setReassignTarget(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions menu (Edit / Reassign all members / Delete) - ADMIN/OWNER
// only surface, mirrors ProjectRowActions.
// ---------------------------------------------------------------------------

function TeamRowActions({
  target,
  onEdit,
  onDelete,
  onReassign,
}: {
  target: TeamListItem;
  onEdit: (team: TeamListItem) => void;
  onDelete: (team: TeamListItem) => void;
  onReassign: (team: TeamListItem) => void;
}) {
  return (
    <div className="text-right" data-qa="team-row-actions">
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="flex size-8 p-0"
              aria-label={`Actions for ${target.name}`}
              data-qa="data-table-row-actions-button"
            >
              <LuEllipsis className="size-4" data-qa="data-table-row-actions-icon" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onClick={() => onEdit(target)}
            data-qa="data-table-row-action-item"
          >
            <LuPencil className="mr-2 size-4 text-muted-foreground" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onReassign(target)}
            data-qa="data-table-row-action-item"
          >
            <LuUsersRound className="mr-2 size-4 text-muted-foreground" />
            Reassign all members
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDelete(target)}
            data-qa="data-table-row-action-item"
          >
            <LuTrash2 className="mr-2 size-4 text-muted-foreground" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

function TeamsTable({
  teams,
  orgSlug,
  onEdit,
  onDelete,
  onReassign,
}: {
  teams: TeamListItem[];
  orgSlug: string | null;
  onEdit: (team: TeamListItem) => void;
  onDelete: (team: TeamListItem) => void;
  onReassign: (team: TeamListItem) => void;
}) {
  const columns = useMemo<DataTableColumnDef<TeamListItem>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Team',
        cell: ({ row }) => (
          <Link
            href={orgHref(orgSlug, `/admin/teams/${row.original.id}`)}
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
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <TeamRowActions
            target={row.original}
            onEdit={onEdit}
            onDelete={onDelete}
            onReassign={onReassign}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [orgSlug, onEdit, onDelete, onReassign],
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

// ---------------------------------------------------------------------------
// Edit dialog (reuses TeamFormBody - separately exported, rule 7c)
// ---------------------------------------------------------------------------

function EditTeamDialog({
  target,
  onClose,
}: {
  target: TeamListItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      trigger={<button hidden />}
      header={{ title: 'Edit team' }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      contentClassName="sm:max-w-md"
    >
      {target !== null ? (
        <TeamFormBody mode="edit" team={target} onDone={onClose} />
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm dialog (reuses TeamDeleteBody - soft delete + 409 guard)
// ---------------------------------------------------------------------------

function DeleteTeamDialog({
  target,
  onClose,
}: {
  target: TeamListItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      trigger={<button hidden />}
      header={{ title: 'Delete team' }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      contentClassName="sm:max-w-md"
    >
      {target !== null ? <TeamDeleteBody team={target} onDone={onClose} /> : null}
    </Dialog>
  );
}
