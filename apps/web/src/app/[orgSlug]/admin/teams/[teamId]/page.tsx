'use client';

// Org team roster - ADMIN/OWNER ONLY (/teams/[teamId]).
// Lists the team's members (User.teamId matches). Per-project link/unlink
// (the old ProjectMember-based "Link to project"/"Unlink" actions) was
// retired T-TEAM-AUTHORITATIVE (2026-09-13, clean cutover) - project
// staffing is exclusively team-based now (see the per-project Staff page,
// ProjectTeamList). Team members also show a "View in Users" link to /users.
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import {
  AlertDialog,
  Button,
  DataTable,
  Dialog,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Heading,
  Loading,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';

import {
  useReassignTeamMembers,
  useTeam,
  type TeamListItem,
  type TeamMemberRow,
} from '@/hooks/queries/teams';
import {
  TeamDeleteBody,
  TeamFormBody,
  TeamTargetPicker,
} from '@/components/teams/team-form-bodies';
import { TeamRosterMemberRow } from '@/components/teams/team-roster';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  LuArrowLeft,
  LuEllipsis,
  LuPencil,
  LuTrash2,
  LuUsersRound,
} from '@paalstack/react-icons/lu';
import Link from 'next/link';

export default function TeamRosterPage() {
  // Hooks MUST all be called unconditionally, before any early return, to
  // keep the hook order stable across renders (React rules of hooks).
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const router = useRouter();
  const params = useParams<{ teamId: string }>();
  const teamId = typeof params?.teamId === 'string' ? params.teamId : null;

  // Local admin gate + query.
  const teamQuery = useTeam(teamId ?? undefined);

  const canManage = isAdminLike(user?.role);

  const [editOpen, setEditOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Hydration guard: the server renders the Skeleton (session pending), but
  // the client resolves the session synchronously on first render. Without
  // this, the client would immediately render the real content and mismatch
  // the server's Skeleton HTML. Same pattern as /teams and /users.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending || teamId === null) {
    return <Skeleton variant="users" className="py-4" />;
  }
  if (user === null || !canManage) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only admins can view the org teams.
        </TypographyP>
      </div>
    );
  }

  const team = teamQuery.data;

  // T-TEAM-CRUD: TeamFormBody/TeamDeleteBody/TeamTargetPicker take the
  // TeamListItem shape (from the /teams list). getTeam's TeamDetail carries
  // the same identity (id/name/manager) under a different shape - adapt it
  // rather than duplicating the create/edit/delete bodies for this page.
  // `defaultAssigneeId` isn't used by any of those bodies, so `null` is safe.
  const teamAsListItem: TeamListItem | null =
    team !== undefined
      ? {
          id: team.id,
          name: team.name,
          defaultAssigneeId: null,
          memberCount: team.members.length,
          managerId: team.manager?.id ?? null,
          managerName: team.manager?.name ?? null,
        }
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={team?.name ?? 'Team'}
        breadcrumb={[
          { label: 'Admin' },
          { label: 'Teams', href: orgHref(orgSlug, '/admin/teams') },
          { label: team?.name ?? 'Team' },
        ]}
        subtitle={
          team?.manager
            ? `Managed by ${team.manager.name}.`
            : 'No manager assigned.'
        }
        action={
          teamAsListItem !== null ? (
            <TeamHeaderActions
              team={teamAsListItem}
              editOpen={editOpen}
              onEditOpenChange={setEditOpen}
              reassignOpen={reassignOpen}
              onReassignOpenChange={setReassignOpen}
              deleteOpen={deleteOpen}
              onDeleteOpenChange={setDeleteOpen}
              onDeleted={() => router.push(orgHref(orgSlug, '/admin/teams'))}
            />
          ) : null
        }
      />

      {teamQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : teamQuery.error !== null && teamQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load this team.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {teamQuery.error instanceof Error
              ? teamQuery.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void teamQuery.refetch()}
            data-qa="team-roster-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : team === undefined || team.members.length === 0 ? (
        <div className="border-border rounded-lg border p-10 text-center text-sm">
          <TypographyP className="text-xl font-medium">No members in this team.</TypographyP>
          <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
            Assign users to this team to see them here.
          </TypographyP>
        </div>
      ) : (
        <RosterTable
          orgSlug={orgSlug}
          teamId={team.id}
          teamName={team.name}
          members={team.members}
          managerId={team.manager?.id ?? null}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header actions - Edit / Reassign all members / Delete (ADMIN/OWNER,
// mirrors the row-actions menu on the /admin/teams list page).
// ---------------------------------------------------------------------------

function TeamHeaderActions({
  team,
  editOpen,
  onEditOpenChange,
  reassignOpen,
  onReassignOpenChange,
  deleteOpen,
  onDeleteOpenChange,
  onDeleted,
}: {
  team: TeamListItem;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  reassignOpen: boolean;
  onReassignOpenChange: (open: boolean) => void;
  deleteOpen: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const reassignMembers = useReassignTeamMembers(team.id);
  const [targetTeamId, setTargetTeamId] = useState('');

  function handleReassignConfirm() {
    if (!targetTeamId) return;
    reassignMembers.mutate(
      { targetTeamId },
      {
        onSuccess: (result) => {
          toast.success(`${result.count} member(s) reassigned`);
          setTargetTeamId('');
          onReassignOpenChange(false);
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Reassign failed');
        },
      },
    );
  }

  return (
    <>
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              aria-label={`Actions for ${team.name}`}
              data-qa="team-header-actions-button"
            >
              Actions
              <LuEllipsis className="ml-1.5 size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onClick={() => onEditOpenChange(true)}
            data-qa="team-header-action-edit"
          >
            <LuPencil className="mr-2 size-4 text-muted-foreground" />
            Edit team
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onReassignOpenChange(true)}
            data-qa="team-header-action-reassign"
          >
            <LuUsersRound className="mr-2 size-4 text-muted-foreground" />
            Reassign all members
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDeleteOpenChange(true)}
            data-qa="team-header-action-delete"
          >
            <LuTrash2 className="mr-2 size-4 text-muted-foreground" />
            Delete team
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuRoot>

      <Dialog
        trigger={<button hidden />}
        header={{ title: 'Edit team' }}
        open={editOpen}
        onOpenChange={onEditOpenChange}
        contentClassName="sm:max-w-lg"
      >
        <TeamFormBody mode="edit" team={team} onDone={() => onEditOpenChange(false)} />
      </Dialog>

      <AlertDialog
        open={reassignOpen}
        onOpenChange={(next) => {
          if (!next) setTargetTeamId('');
          onReassignOpenChange(next);
        }}
        trigger={null}
        header={{
          title: `Reassign all members of ${team.name}`,
          description:
            'Every member currently on this team moves to the team you pick below. This does not change the manager.',
        }}
        cancelButtonText="Cancel"
        confirmButtonText={reassignMembers.isPending ? 'Reassigning...' : 'Reassign all'}
        confirmButtonProps={{ disabled: !targetTeamId || reassignMembers.isPending }}
        onConfirm={handleReassignConfirm}
      >
        <TeamTargetPicker
          excludeTeamId={team.id}
          value={targetTeamId}
          onChange={setTargetTeamId}
        />
      </AlertDialog>

      <Dialog
        trigger={<button hidden />}
        header={{ title: 'Delete team' }}
        open={deleteOpen}
        onOpenChange={onDeleteOpenChange}
        contentClassName="sm:max-w-lg"
      >
        <TeamDeleteBody
          team={team}
          onDone={() => onDeleteOpenChange(false)}
          onDeleted={onDeleted}
        />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Roster table + row actions
// ---------------------------------------------------------------------------

/**
 * One member row - delegates the manager-pin/Manager-badge/"Remove from
 * this team" contract to the shared `TeamRosterMemberRow` (design doc UI1:
 * "Both routes render the same shared roster component"), and supplies the
 * Admin-only "Move to team" action via its `extraActions` slot.
 */
function MemberCard({
  teamId,
  teamName,
  member,
  managerId,
}: {
  teamId: string;
  teamName: string;
  member: TeamMemberRow;
  managerId: string | null;
}) {
  return (
    <TeamRosterMemberRow
      teamId={teamId}
      teamName={teamName}
      member={member}
      managerId={managerId}
      // Admin/Owner can remove from any org team (authorization matrix);
      // the manager row is still excluded inside the shared component.
      canRemove
      dataQaPrefix="team-member"
      extraActions={<MoveToTeamButton teamId={teamId} member={member} />}
    />
  );
}

/**
 * Per-member "move to another team" action (T-TEAM-CRUD, 2026-09-13) -
 * the single-member counterpart to the header's "Reassign all members".
 * POST /api/teams/:id/reassign-members with userIds=[member.userId].
 */
function MoveToTeamButton({
  teamId,
  member,
}: {
  teamId: string;
  member: TeamMemberRow;
}) {
  const [open, setOpen] = useState(false);
  const reassignMembers = useReassignTeamMembers(teamId);
  const [targetTeamId, setTargetTeamId] = useState('');

  function handleConfirm() {
    if (!targetTeamId) return;
    reassignMembers.mutate(
      { targetTeamId, userIds: [member.userId] },
      {
        onSuccess: () => {
          toast.success(`${member.name} moved to another team`);
          setTargetTeamId('');
          setOpen(false);
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Move failed');
        },
      },
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => setOpen(true)}
        data-qa={`team-member-move-${member.userId}`}
      >
        Move to team
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setTargetTeamId('');
          setOpen(next);
        }}
        trigger={null}
        header={{
          title: `Move ${member.name} to another team`,
          description: 'Pick the team to move this member to.',
        }}
        cancelButtonText="Cancel"
        confirmButtonText={reassignMembers.isPending ? 'Moving...' : 'Move'}
        confirmButtonProps={{ disabled: !targetTeamId || reassignMembers.isPending }}
        onConfirm={handleConfirm}
      >
        <TeamTargetPicker
          excludeTeamId={teamId}
          value={targetTeamId}
          onChange={setTargetTeamId}
        />
      </AlertDialog>
    </>
  );
}


function RosterTable({
  orgSlug,
  teamId,
  teamName,
  members,
  managerId,
}: {
  orgSlug: string | null;
  teamId: string;
  teamName: string;
  members: TeamMemberRow[];
  managerId: string | null;
}) {
  const [search, setSearch] = useState('');
  const columns = useMemo<DataTableColumnDef<TeamMemberRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Member',
        cell: ({ row }) => (
          <MemberCard
            teamId={teamId}
            teamName={teamName}
            member={row.original}
            managerId={managerId}
          />
        ),
        enableSorting: true,
      },
    ],
    [teamId, teamName, managerId],
  );

  return (
    <div className="space-y-2">
      <DataTable
        columns={columns}
        rows={members}
        search={{
          accessorKey: 'name',
          placeholder: 'Search members...',
          searchValue: search,
          onSearchValueChange: (v) => setSearch(String(v ?? '')),
        }}
        isLoading={false}
        loadingContent={<Loading content="Loading members..." />}
        emptyContent={
          <div className="rounded-lg p-10 text-center space-y-1">
           <TypographyP className="text-xl font-medium">
              {search.trim() ? 'No members match your search.' : 'No members in this team.'}
            </TypographyP>
            <TypographyP className="text-muted-foreground text-sm">
              {search.trim() ? 'Try a different search.' : 'Assign users to this team to see them here.'}
            </TypographyP>
          </div>
        }
        tableContainerClassName="rounded-lg border"
      />
      <div className="flex justify-end pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          as={Link}
          href={orgHref(orgSlug, '/admin/teams')}
          data-qa="back-to-teams"
          leftIcon={<LuArrowLeft className="size-4" />}
        >
          Back to teams
        </Button>
      </div>
    </div>
  );
}
