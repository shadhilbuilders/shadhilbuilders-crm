'use client';

// User detail page (/admin/users/[userId], autoplan 2026-09-13).
// Clicking a user's name in the /admin/users table lands here. Shows the
// user's identity, team, the projects they're assigned to (via
// ProjectMember), and - only when the role is TELECALLER or SALES_EXEC,
// since those are the only roles that report to a manager on this surface -
// who manages them. ADMIN/OWNER/MANAGER rows omit the manager section
// entirely (they don't report to anyone here).
//
// Auth: same gate as the /admin/users list (ADMIN/OWNER only) - the
// backend additionally scopes MANAGER to their own team + self, so this
// page would also work for a manager if that gate is ever relaxed.
//
// Write actions (autoplan 2026-09-13):
//   - "Link to project" (Projects card) - POST /api/projects/:id/members,
//     reusing the same mutation the Teams roster page uses. Gated by
//     `canManageProjectMembers` (ADMIN/OWNER/MANAGER).
//   - "Assign manager" / "Reassign manager" (Manager row, TELECALLER/
//     SALES_EXEC only) - PATCH /api/users/:id/manager, which moves the
//     user into the chosen manager's team. Gated by `canManageUsers`
//     (ADMIN/OWNER/MANAGER); the backend further restricts a MANAGER to
//     their own team.
import { useParams } from 'next/navigation';
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
import {
  LuArrowLeft,
  LuFolderKanban,
  LuPlus,
  LuUserCog,
} from '@paalstack/react-icons/lu';
import Link from 'next/link';

import {
  useAssignManager,
  useUser,
  type BackendUserDetail,
} from '@/hooks/queries/users';
import { useLinkProjectMemberToProject, useProjects } from '@/hooks/queries/projects';
import { useTeams } from '@/hooks/queries/teams';
import {
  canManageProjectMembers,
  canManageUsers,
  isAdminLike,
  useSessionUser,
  type Role,
} from '@/lib/session';
import { labelFor } from '@/lib/labels';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';

/** Roles that report to a manager on this surface (see file header). */
const REPORTS_TO_MANAGER = new Set(['TELECALLER', 'SALES_EXEC']);

export default function UserDetailPage() {
  // Hooks MUST all be called unconditionally, before any early return, to
  // keep the hook order stable across renders (React rules of hooks).
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const params = useParams<{ userId: string }>();
  const userId = typeof params?.userId === 'string' ? params.userId : null;

  const userQuery = useUser(userId ?? undefined);

  // Hydration guard - same pattern as /admin/users and /admin/teams/[teamId]
  // (session resolves synchronously on the client but reports isPending
  // during SSR; render the Skeleton on first client paint too, then swap
  // after mount, so the server and client HTML match).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending || userId === null) {
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

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail?.name ?? 'User'}
        breadcrumb={[
          { label: 'Admin' },
          { label: 'Users', href: orgHref(orgSlug, '/admin/users') },
          { label: detail?.name ?? 'User' },
        ]}
        subtitle={detail ? labelFor('role', detail.role) : undefined}
      />

      {userQuery.isLoading ? (
        <div className="space-y-4">
          <Skeleton variant="card" />
          <Skeleton variant="list" count={3} />
        </div>
      ) : userQuery.error !== null && userQuery.error !== undefined ? (
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
      ) : detail !== undefined ? (
        <UserDetailContent
          detail={detail}
          actorRole={user.role}
          onChanged={() => void userQuery.refetch()}
        />
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          as={Link}
          href={orgHref(orgSlug, '/admin/users')}
          data-qa="back-to-users"
          leftIcon={<LuArrowLeft className="size-4" />}
        >
          Back to users
        </Button>
      </div>
    </div>
  );
}

function UserDetailContent({
  detail,
  actorRole,
  onChanged,
}: {
  detail: BackendUserDetail;
  actorRole: Role;
  /** Re-fetch the user detail after a project link or manager reassign
   *  succeeds (both mutations live outside `useUser`'s own cache key). */
  onChanged: () => void;
}) {
  const showManager = REPORTS_TO_MANAGER.has(detail.role);

  return (
    <div className="flex flex-col gap-4">
      <Card data-qa="user-info-card">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-xl">{detail.name}</CardTitle>
            <Badge variant="secondary">{labelFor('role', detail.role)}</Badge>
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

          {showManager ? (
            <div
              className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
              data-qa="user-manager-row"
            >
              <div className="flex items-center gap-3">
                <LuUserCog className="text-muted-foreground size-5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    Manager
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
              {canManageUsers(actorRole) ? (
                <AssignManagerButton detail={detail} onAssigned={onChanged} />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card data-qa="user-projects-card">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Projects</CardTitle>
            {canManageProjectMembers(actorRole) ? (
              <LinkProjectButton detail={detail} onLinked={onChanged} />
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {detail.projects.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-6 text-center">
              <LuFolderKanban className="text-muted-foreground size-6" />
              <p className="text-muted-foreground text-sm">
                Not assigned to any project.
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
        contentClassName="sm:max-w-md"
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

// ---------------------------------------------------------------------------
// Link to project - POST /api/projects/:id/members
// ---------------------------------------------------------------------------

/** Opens a dialog to link this user to a project they're not already on. */
function LinkProjectButton({
  detail,
  onLinked,
}: {
  detail: BackendUserDetail;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: projects } = useProjects();
  const linkMember = useLinkProjectMemberToProject();
  const [selected, setSelected] = useState('');

  const linkedIds = useMemo(
    () => new Set(detail.projects.map((p) => p.id)),
    [detail.projects],
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
      { projectId: selected, userId: detail.id },
      {
        onSuccess: () => {
          toast.success(`${detail.name} linked to a project`);
          // The link mutation only invalidates the project's member list;
          // this page reads projects off the user-detail query, so
          // refetch that too.
          onLinked();
          setSelected('');
          setOpen(false);
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Link failed');
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
        leftIcon={<LuPlus className="size-4" />}
        data-qa="user-link-project-button"
      >
        Link to project
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setSelected('');
          setOpen(next);
        }}
        trigger={null}
        header={{
          title: `Link ${detail.name} to a project`,
          description: 'Choose a project to add this user to.',
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
            data-qa="user-link-project-picker"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
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
              data-qa="user-link-project-confirm"
            >
              Link
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
