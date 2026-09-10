'use client';

// Org team roster - ADMIN/OWNER ONLY (/teams/[teamId]).
// Lists the team's members (User.teamId matches) with the projects each is
// assigned to, and lets an admin unlink a member from a SPECIFIC project
// (DELETE /api/projects/:projectId/members/:userId). Rows where the member
// is only a lead-owner on a project (no explicit ProjectMember) are shown
// read-only as "via leads" with Unlink disabled - unlinking would be a
// silent no-op. Team members also show a "View in Users" link to /users.
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import {
  AlertDialog,
  Badge,
  Button,
  Combobox,
  DataTable,
  Dialog,
  Heading,
  Loading,
  toast,
  Tooltip,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { useQueryClient } from '@tanstack/react-query';

import {
  useLinkProjectMemberToProject,
  useProjects,
  useUnlinkProjectMember,
} from '@/hooks/queries/projects';
import { useTeam, type TeamMemberProject, type TeamMemberRow } from '@/hooks/queries/teams';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { labelFor } from '@/lib/labels';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import { LuArrowLeft } from '@paalstack/react-icons/lu';
import Link from 'next/link';

export default function TeamRosterPage() {
  // Hooks MUST all be called unconditionally, before any early return, to
  // keep the hook order stable across renders (React rules of hooks).
  const { user, isPending: sessionPending } = useSessionUser();
  const params = useParams<{ teamId: string }>();
  const teamId = typeof params?.teamId === 'string' ? params.teamId : null;

  // Local admin gate + query.
  const teamQuery = useTeam(teamId ?? undefined);

  const canManage = isAdminLike(user?.role);

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

  return (
    <div className="space-y-6">
      <PageHeader
        title={team?.name ?? 'Team'}
        breadcrumb={[
          { label: 'Admin' },
          { label: 'Teams', href: '/teams' },
          { label: team?.name ?? 'Team' },
        ]}
        subtitle={
          team?.manager
            ? `Managed by ${team.manager.name}.`
            : 'No manager assigned.'
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
          teamId={team.id}
          members={team.members}
          managerId={team.manager?.id ?? null}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster table + row actions
// ---------------------------------------------------------------------------

/**
 * One member row: name/email, role, and the projects they're on. The Unlink
 * action is per-project and only enabled for EXPLICIT members; lead-owner-only
 * projects render a disabled Unlink with a tooltip.
 */
function MemberCard({
  teamId,
  member,
  managerId,
}: {
  teamId: string;
  member: TeamMemberRow;
  managerId: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{member.name}</span>
          {member.userId === managerId ? (
            <Badge variant="secondary">Manager</Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">{member.email}</p>
        <p className="text-muted-foreground text-xs">{labelFor('role', member.role)}</p>
      </div>
      <div className="flex flex-col items-end gap-1">
        {member.projects.map((p) => (
          <ProjectUnlink key={p.projectId} teamId={teamId} project={p} member={member} />
        ))}
        {member.projects.length === 0 ? (
          <span className="text-muted-foreground text-xs">Not on any project</span>
        ) : null}
        <LinkProjectButton teamId={teamId} member={member} />
      </div>
    </div>
  );
}

/** Opens a dialog to link this member to a project they're not already on. */
function LinkProjectButton({
  teamId,
  member,
}: {
  teamId: string;
  member: TeamMemberRow;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => setOpen(true)}
        data-qa={`project-member-link-${member.userId}`}
      >
        Link to project
      </Button>
      <LinkProjectDialog
        teamId={teamId}
        member={member}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/** Dialog: pick a project (not already linked) and link the member to it. */
function LinkProjectDialog({
  teamId,
  member,
  open,
  onOpenChange,
}: {
  teamId: string;
  member: TeamMemberRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: projects } = useProjects();
  const linkMember = useLinkProjectMemberToProject();
  const [selected, setSelected] = useState('');

  // Projects the member isn't already on (explicit or lead-owner).
  const linkedIds = useMemo(
    () => new Set(member.projects.map((p) => p.projectId)),
    [member.projects],
  );
  const candidates = useMemo(
    () =>
      (projects ?? [])
        .filter((p) => !linkedIds.has(p.id))
        .map((p) => ({ value: p.id, label: p.name })),
    [projects, linkedIds],
  );

  function handleLink() {
    if (!selected) return;
    linkMember.mutate(
      { projectId: selected, userId: member.userId },
      {
        onSuccess: () => {
          toast.success(`${member.name} linked to a project`);
          void queryClient.invalidateQueries({ queryKey: ['teams', teamId] });
          setSelected('');
          onOpenChange(false);
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Link failed');
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the picker whenever the dialog closes (cancel, X, or after
        // a successful link) so the next open starts clean.
        if (!next) setSelected('');
        onOpenChange(next);
      }}
      trigger={null}
      header={{
        title: `Link ${member.name} to a project`,
        description: 'Choose a project to add this member to.',
      }}
      contentClassName="sm:max-w-md"
    >
      <div className="space-y-3">
        <Combobox
          value={selected}
          onValueChange={(v) => setSelected(v ?? '')}
          options={candidates}
          placeholder={
            candidates.length === 0
              ? 'No more projects to link'
              : 'Search projects...'
          }
          disabled={candidates.length === 0}
          selectOptionAsValue
          className="w-full"
          data-qa="project-link-picker"
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={linkMember.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleLink}
            disabled={!selected || linkMember.isPending}
            isLoading={linkMember.isPending}
            loadingText="Linking..."
            data-qa="project-link-confirm"
          >
            Link
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A single project chip with an Unlink button (or a read-only badge). */
function ProjectUnlink({
  teamId,
  project,
  member,
}: {
  teamId: string;
  project: TeamMemberProject;
  member: TeamMemberRow;
}) {
  const queryClient = useQueryClient();
  const unlinkMember = useUnlinkProjectMember(project.projectId);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  function handleUnlink() {
    setRemoving(true);
    unlinkMember.mutate(member.userId, {
      onSuccess: () => {
        // Also refresh the team roster (the hook only invalidates the
        // per-project members key).
        void queryClient.invalidateQueries({ queryKey: ['teams', teamId] });
      },
      onSettled: () => {
        setRemoving(false);
        setConfirming(false);
      },
    });
  }

  const button = (
    <Button
      type="button"
      variant="ghost"
      color="danger"
      size="sm"
      onClick={() => setConfirming(true)}
      disabled={removing || project.isLeadOwner}
      isLoading={removing}
      loadingText="..."
      data-qa={`project-member-unlink-${project.projectId}-${member.userId}`}
    >
      Unlink · {project.projectName}
    </Button>
  );

  if (project.isLeadOwner) {
    return (
      <Tooltip
        content="This member only owns leads on this project (no explicit assignment) - nothing to unlink."
        side="left"
        trigger={
          <span className="flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="pointer-events-auto h-7 cursor-not-allowed! shrink-0 px-2 text-xs opacity-50"
              data-qa={`project-member-readonly-${project.projectId}-${member.userId}`}
            >
              via leads · {project.projectName}
            </Button>
          </span>
        }
      />
    );
  }

  return (
    <>
      {button}
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        trigger={null}
        header={{
          title: `Unlink ${member.name} from ${project.projectName}?`,
          description: `This removes ${member.name}'s explicit assignment to ${project.projectName}. They can still be re-linked later.`,
        }}
        cancelButtonText="Cancel"
        confirmButtonText={removing ? 'Unlinking...' : 'Unlink'}
        confirmButtonProps={{
          variant: 'destructive',
          disabled: removing,
        }}
        onConfirm={handleUnlink}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function RosterTable({
  teamId,
  members,
  managerId,
}: {
  teamId: string;
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
          <MemberCard teamId={teamId} member={row.original} managerId={managerId} />
        ),
        enableSorting: true,
      },
    ],
    [teamId, managerId],
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
          href="/teams"
          data-qa="back-to-teams"
          leftIcon={<LuArrowLeft className="size-4" />}
        >
          Back to teams
        </Button>
      </div>
    </div>
  );
}
