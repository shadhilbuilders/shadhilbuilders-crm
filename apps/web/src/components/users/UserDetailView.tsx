'use client';

// UserDetailView - the full admin user-detail panel (identity, team, reports-to,
// projects, leads). Rendered on /admin/staff-permission once a user is picked
// (the old /admin/users/[userId] route now redirects there).
//
// Reports-to rules (T-REPORTS-TO-OWNER, 2026-10-06):
//   - TELECALLER/SALES_EXEC: their team's manager (assignable via
//     PATCH /api/users/:id/manager, gated by `canManageUsers`).
//   - MANAGER/ADMIN: the org OWNER (fixed, read-only - never assignable).
//   - OWNER: the row is omitted (reports to nobody).
// T-USER-LEADS (2026-09-24): the Leads table lists every lead linked to the
// user (owner OR co-owner). Projects are read-only (T-TEAM-AUTHORITATIVE).
//
// Auth: ADMIN/OWNER only; the backend additionally scopes by role.
import { useEffect, useMemo, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Combobox,
  Dialog,
  Heading,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import { LuFolderKanban, LuKeyRound, LuUserCog } from '@paalstack/react-icons/lu';

import {
  useAssignManager,
  useUser,
  type BackendUserDetail,
} from '@/hooks/queries/users';
import { useTeams } from '@/hooks/queries/teams';
import {
  canManageUsers,
  isAdminLike,
  outranks,
  useSessionUser,
  type Role,
} from '@/lib/session';
import { labelFor } from '@/lib/labels';

import { Skeleton } from '@/components/shared/Skeleton';
import { UserLeadsCard } from '@/components/users/UserLeadsCard';
import { ResetPasswordDialog } from '@/components/users/ResetPasswordDialog';

/** Roles whose "Reports to" person is an ASSIGNABLE team manager. */
const REPORTS_TO_MANAGER = new Set(['TELECALLER', 'SALES_EXEC']);

export function UserDetailView({ userId }: { userId: string }) {
  // Hooks run unconditionally before any early return (rules of hooks).
  const { user, isPending: sessionPending } = useSessionUser();
  const userQuery = useUser(userId);

  // Hydration guard (same pattern as /admin/users): render the Skeleton on
  // first client paint, then swap after mount so server and client HTML match.
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
          Only owners and admins can view user details.
        </TypographyP>
      </div>
    );
  }

  const detail = userQuery.data;

  if (userQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" />
        <Skeleton variant="list" count={3} />
      </div>
    );
  }
  if (userQuery.error !== null && userQuery.error !== undefined) {
    return (
      <div
        role="alert"
        className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
      >
        <p className="text-sm font-medium">Couldn&apos;t load this user.</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {userQuery.error instanceof Error
            ? userQuery.error.message
            : 'Unexpected error.'}
        </p>
        <Button
          variant="outline"
          className="mt-3"
          onClick={() => void userQuery.refetch()}
          data-qa="user-detail-retry-button"
        >
          Try again
        </Button>
      </div>
    );
  }
  if (detail === undefined) return null;

  return (
    <UserDetailContent
      detail={detail}
      actorRole={user.role}
      actorId={user.id}
      onChanged={() => void userQuery.refetch()}
    />
  );
}

function UserDetailContent({
  detail,
  actorRole,
  actorId,
  onChanged,
}: {
  detail: BackendUserDetail;
  actorRole: Role;
  actorId: string;
  /** Re-fetch the user detail after a project link or manager reassign
   *  succeeds (both mutations live outside `useUser`'s own cache key). */
  onChanged: () => void;
}) {
  // T-REPORTS-TO-OWNER: every role except OWNER reports to someone on this
  // surface - TELECALLER/SALES_EXEC to their team's manager (assignable),
  // MANAGER/ADMIN to the org OWNER (fixed). OWNER reports to nobody, so the
  // row is omitted for them.
  const showReportsTo = detail.role !== 'OWNER';
  const canAssignManager = REPORTS_TO_MANAGER.has(detail.role);
  // Server enforces the same rule: strictly outrank the target, not self.
  const canResetPassword =
    isAdminLike(actorRole) &&
    detail.id !== actorId &&
    outranks(actorRole, detail.role);
  const [passwordOpen, setPasswordOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Card data-qa="user-info-card">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-xl">{detail.name}</CardTitle>
            <Badge variant="secondary">{labelFor('role', detail.role)}</Badge>
            {canResetPassword ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => setPasswordOpen(true)}
                data-qa="user-change-password-button"
              >
                <LuKeyRound className="mr-2 size-4" />
                Change password
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm">{detail.email}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Team
              </dt>
              <dd className="text-sm">{detail.teamName ?? 'No team assigned'}</dd>
            </div>
          </dl>

          {showReportsTo ? (
            <div
              className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
              data-qa="user-manager-row"
            >
              <div className="flex items-center gap-3">
                <LuUserCog className="text-muted-foreground size-5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    Reports to
                  </p>
                  {detail.manager ? (
                    <>
                      <p className="text-sm font-medium">{detail.manager.name}</p>
                      <p className="text-muted-foreground text-xs">{detail.manager.email}</p>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-sm">No manager assigned</p>
                  )}
                </div>
              </div>
              {/* T-REPORTS-TO-OWNER: a MANAGER/ADMIN's "Reports to" is the
                  org OWNER - fixed, never assignable, so no button renders
                  for them even for an actor who canManageUsers. */}
              {canAssignManager && canManageUsers(actorRole) ? (
                <AssignManagerButton detail={detail} onAssigned={onChanged} />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card data-qa="user-projects-card">
        <CardHeader>
          <CardTitle className="text-base">Projects</CardTitle>
        </CardHeader>
        <CardContent>
          {/* T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): read-only -
              "which projects" is now "which projects is this user's TEAM
              linked to" (ProjectTeam). Linking happens on the project's
              Staff page at the team level, not per-user here anymore
              (ProjectMember, the per-user link, was retired). */}
          {detail.projects.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-6 text-center">
              <LuFolderKanban className="text-muted-foreground size-6" />
              <p className="text-muted-foreground text-sm">
                {detail.teamName === null
                  ? 'Not on a team, so no linked projects.'
                  : `${detail.teamName} isn't linked to any project yet.`}
              </p>
            </div>
          ) : (
            <ul className="flex flex-wrap gap-2" data-qa="user-projects-list">
              {detail.projects.map((project) => (
                <li key={project.id}>
                  <Badge variant="outline" data-qa={`user-project-${project.id}`}>
                    {project.name}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* T-USER-LEADS (2026-09-24): every lead this user is linked to
          (owner OR co-owner), filterable by project. The page is already
          ADMIN/OWNER-gated above, and the backend keeps ADMIN/OWNER
          filters un-narrowed by role scoping, so this shows the full set
          rather than only the admin's own lane. */}
      <Card data-qa="user-leads-card-shell">
        <CardContent className="pt-6">
          <UserLeadsCard userId={detail.id} />
        </CardContent>
      </Card>

      <ResetPasswordDialog
        target={passwordOpen ? { id: detail.id, name: detail.name } : null}
        onClose={() => setPasswordOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assign / reassign manager - PATCH /api/users/:id/manager
// ---------------------------------------------------------------------------

/**
 * Opens a dialog to pick a led team (i.e. a manager) for a TELECALLER/
 * SALES_EXEC. Candidates are teams that already have a manager assigned
 * (an unled team is rejected server-side); the user's current team is
 * excluded so re-picking the same manager can't be submitted as a no-op.
 */
function AssignManagerButton({
  detail,
  onAssigned,
}: {
  detail: BackendUserDetail;
  onAssigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  const teamsQuery = useTeams();
  const assignManager = useAssignManager();
  const [selected, setSelected] = useState('');

  const candidates = useMemo(
    () =>
      (teamsQuery.data ?? [])
        .filter((t) => t.managerName !== null && t.id !== detail.teamId)
        .map((t) => ({ value: t.id, label: `${t.managerName} · ${t.name}` })),
    [teamsQuery.data, detail.teamId],
  );

  function handleAssign() {
    if (!selected) return;
    assignManager.mutate(
      { id: detail.id, teamId: selected },
      {
        onSuccess: () => {
          toast.success(`Manager updated for ${detail.name}`);
          onAssigned();
          setSelected('');
          setOpen(false);
        },
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : 'Failed to assign manager',
          );
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
        onClick={() => setOpen(true)}
        data-qa="user-assign-manager-button"
      >
        {detail.manager ? 'Reassign manager' : 'Assign manager'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setSelected('');
          setOpen(next);
        }}
        trigger={null}
        header={{
          title: `${detail.manager ? 'Reassign' : 'Assign'} manager for ${detail.name}`,
          description: 'Choose the manager to move this user under.',
        }}
        contentClassName="sm:max-w-lg"
      >
        <div className="space-y-3">
          <Combobox
            value={selected}
            onValueChange={(v) => setSelected(v ?? '')}
            options={candidates}
            placeholder={
              candidates.length === 0
                ? 'No other led teams available'
                : 'Search managers...'
            }
            disabled={candidates.length === 0}
            selectOptionAsValue
            className="w-full"
            data-qa="user-assign-manager-picker"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={assignManager.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleAssign}
              disabled={!selected || assignManager.isPending}
              isLoading={assignManager.isPending}
              loadingText="Assigning..."
              data-qa="user-assign-manager-confirm"
            >
              Assign
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
