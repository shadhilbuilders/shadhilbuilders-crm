'use client';

// ProjectTeamList - T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail
// #39). Design doc UI3: replaces the per-user ProjectMembersBody on the
// project Staff page with a grouped, one-at-a-time expandable ProjectTeam
// view. Projects link to TEAMS (never directly to users) - staff members
// shown here are team-derived only, backed by
// GET/POST/DELETE /api/projects/:projectId/teams.
//
// Hierarchy (design doc): (1) project identity + Owner/Admin-only "Link
// team", (2) linked-team summary rows (name, manager, member count, lead
// count, unlink status), (3) one-at-a-time expandable read-only member
// lists. The first team opens by default only when there's exactly one
// linked team; otherwise everything starts collapsed.
import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Combobox,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
  Dialog,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Item,
  ItemGroup,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import {
  LuChevronDown,
  LuChevronRight,
  LuEllipsis,
  LuPlus,
} from '@paalstack/react-icons/lu';

import { ApiError } from '@/apis/client';
import { useTeams } from '@/hooks/queries/teams';
import {
  useLinkProjectTeam,
  useProjectTeams,
  useUnlinkProjectTeam,
  type ProjectTeamRow,
  type TeamMembership,
} from '@/hooks/queries/project-teams';
import { labelFor } from '@/lib/labels';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

export function ProjectTeamList({
  projectId,
  projectName,
  projectSlug,
  canManage,
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  /** Owner/Admin only - link/unlink is stricter than ProjectMember's
   * MANAGER-inclusive canManageProjectMembers (design doc auth matrix). */
  canManage: boolean;
}) {
  const query = useProjectTeams(projectId);
  const [linkOpen, setLinkOpen] = useState(false);
  // "one-at-a-time" expansion: a single teamId, not a Set.
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

  const teams = query.data?.teams ?? [];

  // Open the first (only) team by default when there's exactly one linked
  // team; otherwise everything starts collapsed (design doc).
  useEffect(() => {
    if (teams.length === 1) setExpandedTeamId(teams[0]!.teamId);
  }, [teams.length, teams[0]?.teamId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <TypographyP className="text-muted-foreground text-sm">
          {teams.length === 1
            ? '1 linked team'
            : `${teams.length} linked teams`}
        </TypographyP>
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLinkOpen(true)}
            data-qa="project-team-link-button"
            leftIcon={<LuPlus className="size-4" />}
          >
            Link team
          </Button>
        ) : null}
      </div>

      {query.isLoading ? (
        <TeamListSkeleton />
      ) : query.error !== null && query.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load linked teams.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {query.error instanceof Error ? query.error.message : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void query.refetch()}
            data-qa="project-teams-retry"
          >
            Try again
          </Button>
        </div>
      ) : teams.length === 0 ? (
        <div className="border-border rounded-lg border p-10 text-center text-sm">
          <TypographyP className="text-xl font-medium">
            No teams work on this project yet
          </TypographyP>
          {canManage ? (
            <TypographyP className="text-muted-foreground mt-1 text-sm">
              Link a team so its members and manager get project access.
            </TypographyP>
          ) : (
            <TypographyP className="text-muted-foreground mt-1 text-sm">
              Ask an admin to link a team to this project.
            </TypographyP>
          )}
        </div>
      ) : (
        <ItemGroup className="gap-2">
          {teams.map((row) => (
            <ProjectTeamRowItem
              key={row.teamId}
              projectId={projectId}
              projectName={projectName}
              projectSlug={projectSlug}
              row={row}
              canManage={canManage}
              expanded={expandedTeamId === row.teamId}
              onToggle={() =>
                setExpandedTeamId((current) => (current === row.teamId ? null : row.teamId))
              }
            />
          ))}
        </ItemGroup>
      )}

      <LinkTeamDialog
        projectId={projectId}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        alreadyLinkedTeamIds={teams.map((t) => t.teamId)}
      />
    </div>
  );
}

function TeamListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="border-border h-14 animate-pulse rounded-lg border"
        />
      ))}
    </div>
  );
}

function ProjectTeamRowItem({
  projectId,
  projectName,
  projectSlug,
  row,
  canManage,
  expanded,
  onToggle,
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  row: ProjectTeamRow;
  canManage: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <CollapsibleRoot open={expanded} onOpenChange={onToggle}>
      <Item
        variant="outline"
        size="sm"
        title={
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 text-left"
                aria-expanded={expanded}
                data-qa={`project-team-toggle-${row.teamId}`}
              >
                {expanded ? (
                  <LuChevronDown className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <LuChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">{row.teamName}</span>
              </button>
            }
          />
        }
        description={
          `${row.manager?.name ?? 'No manager'} · ${row.memberCount} member${row.memberCount === 1 ? '' : 's'} · ` +
          `${row.leadCount} lead${row.leadCount === 1 ? '' : 's'}`
        }
        actions={
          canManage ? (
            <TeamRowActions
              projectId={projectId}
              projectName={projectName}
              projectSlug={projectSlug}
              row={row}
            />
          ) : null
        }
      />
      <CollapsibleContent className="px-1 pt-1 pb-2">
        <MemberRoster members={row.members} />
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}

function MemberRoster({ members }: { members: TeamMembership[] }) {
  if (members.length === 0) {
    return (
      <TypographyP className="text-muted-foreground pl-6 text-sm">
        No members yet.
      </TypographyP>
    );
  }
  // Manager first (design doc: "pins the team's manager first").
  const sorted = [...members].sort((a, b) => {
    if (a.isManagerSlot !== b.isManagerSlot) return a.isManagerSlot ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <div className="space-y-1 pl-6">
      {sorted.map((m) => (
        <div key={m.userId} className="flex items-center gap-2 py-1">
          <span className="min-w-0 truncate text-sm">{m.name}</span>
          {m.isManagerSlot ? (
            <Badge variant="secondary" data-qa={`project-team-manager-badge-${m.userId}`}>
              Manager
            </Badge>
          ) : null}
          <Badge variant="outline">{labelFor('role', m.role)}</Badge>
        </div>
      ))}
    </div>
  );
}

function TeamRowActions({
  projectId,
  projectName,
  projectSlug,
  row,
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  row: ProjectTeamRow;
}) {
  const orgSlug = useOrgSlug();
  const [confirming, setConfirming] = useState(false);
  const unlinkTeam = useUnlinkProjectTeam(projectId);

  function handleUnlink() {
    unlinkTeam.mutate(row.teamId, {
      onSuccess: () => {
        toast.success(`${row.teamName} unlinked from ${projectName}`);
        setConfirming(false);
      },
      onError: (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Unlink failed');
      },
    });
  }

  const blockedByLeads = row.leadCount > 0;

  return (
    <>
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Actions for ${row.teamName}`}
              data-qa={`project-team-actions-${row.teamId}`}
              className="h-11 w-11 shrink-0"
            >
              <LuEllipsis className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            disabled={!row.canUnlink}
            onClick={() => setConfirming(true)}
            data-qa={`project-team-unlink-${row.teamId}`}
          >
            {blockedByLeads
              ? `Blocked: ${row.leadCount} lead${row.leadCount === 1 ? '' : 's'} assigned here`
              : 'Unlink from this project'}
          </DropdownMenuItem>
          {blockedByLeads ? (
            <DropdownMenuItem
              render={
                <a
                  href={orgHref(orgSlug, `/projects/${projectSlug}/leads`)}
                  data-qa={`project-team-view-leads-${row.teamId}`}
                >
                  View leads for this team
                </a>
              }
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenuRoot>

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        trigger={null}
        header={{
          title: `Unlink ${row.teamName} from ${projectName}?`,
          description: `${row.memberCount} member${row.memberCount === 1 ? '' : 's'} will lose access to this project. Their team membership is unchanged.`,
        }}
        cancelButtonText="Cancel"
        confirmButtonText={unlinkTeam.isPending ? 'Unlinking...' : 'Unlink'}
        confirmButtonProps={{ variant: 'destructive', disabled: unlinkTeam.isPending }}
        onConfirm={handleUnlink}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function LinkTeamDialog({
  projectId,
  open,
  onOpenChange,
  alreadyLinkedTeamIds,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alreadyLinkedTeamIds: string[];
}) {
  const teamsQuery = useTeams();
  const linkTeam = useLinkProjectTeam(projectId);
  const [selected, setSelected] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  const linkedSet = useMemo(() => new Set(alreadyLinkedTeamIds), [alreadyLinkedTeamIds]);
  // "active, manager-assigned, not-yet-linked teams" (design doc). Legacy
  // managerless teams are excluded from the picker.
  const candidates = useMemo(
    () =>
      (teamsQuery.data ?? [])
        .filter((t) => t.managerId !== null && !linkedSet.has(t.id))
        .map((t) => ({ value: t.id, label: `${t.name} (${t.managerName ?? 'unmanaged'})` })),
    [teamsQuery.data, linkedSet],
  );

  function handleLink() {
    if (!selected) return;
    setLinkError(null);
    linkTeam.mutate(selected, {
      onSuccess: (row) => {
        toast.success(`${row.teamName} linked to this project`);
        setSelected('');
        onOpenChange(false);
      },
      onError: (error: unknown) => {
        if (error instanceof ApiError) {
          setLinkError(error.message);
        } else {
          toast.error('Link failed');
        }
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSelected('');
          setLinkError(null);
        }
        onOpenChange(next);
      }}
      trigger={null}
      header={{
        title: 'Link a team to this project',
        description: 'Choose an active, manager-assigned team not already linked here.',
      }}
      contentClassName="sm:max-w-md"
    >
      <div className="space-y-3">
        {candidates.length === 0 ? (
          <TypographyP className="text-muted-foreground text-sm">
            All eligible teams are already linked.
          </TypographyP>
        ) : (
          <Combobox
            value={selected}
            onValueChange={(v) => setSelected(v ?? '')}
            options={candidates}
            placeholder="Search teams..."
            loadingMessage="Loading teams..."
            emptyOptionMessage="No matching teams."
            selectOptionAsValue
            className="w-full"
            data-qa="project-team-link-picker"
          />
        )}
        {linkError !== null ? (
          <p role="alert" className="text-destructive text-xs">
            {linkError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={linkTeam.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleLink}
            disabled={!selected || linkTeam.isPending}
            isLoading={linkTeam.isPending}
            loadingText="Linking..."
            data-qa="project-team-link-confirm"
          >
            Link
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
