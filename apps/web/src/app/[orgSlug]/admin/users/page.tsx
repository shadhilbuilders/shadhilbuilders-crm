'use client';

// Users management - LIVE against apps/backend/src/users (the one built
// backend module). Role hierarchy (Round 17/20/21, locked; creatable-role
// split below tightened so the UI mirrors roles.ts assertCanCreateRole
// exactly, RANK: OWNER 4 > ADMIN 3 > MANAGER 2 > TELECALLER/SALES_EXEC 1):
//   OWNER   → ADMIN / MANAGER / TELECALLER / SALES_EXEC
//   ADMIN   → MANAGER / TELECALLER / SALES_EXEC
//   MANAGER → TELECALLER / SALES_EXEC in own team.
// Guards enforced server-side; the UI mirrors them for fast feedback and
// shows real API errors (400 = policy rejection) verbatim.
//
// Rebuilt on the @paalstack/react-ui DataTable (autoplan 2026-09-09) to
// match the Lead Inbox page's table pattern, with SERVER-side pagination,
// search, and role filter (mirrors leads T-SRVPG).
//
// Row actions (autoplan 2026-09-09): the Role column shows the role as
// TEXT (not an inline Select). A new Actions column (DataTableRowActions)
// offers Edit / Delete / Change role, each hierarchy-gated via
// `canManageUser` (actor must strictly outrank the target; no self-actions).
// Change role opens a confirm dialog (explicit approval before the critical
// role change). Edit/Delete hit PATCH/DELETE /api/users/:id.
import {
  Button,
  Combobox,
  DataTable,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Heading,
  Loading,
  Tabs,
  Tooltip,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { useMediaQuery } from '@/lib/use-media-query';
import { useDebouncedValue } from '@paalstack/react-hooks';
import { LuEllipsis, LuKeyRound, LuPencil, LuTrash2, LuUserCog } from '@paalstack/react-icons/lu';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  useChangeUserRole,
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useUsers,
  type BackendCreatedUser,
  type ReportsToLine,
} from '@/hooks/queries/users';
import { useTeams } from '@/hooks/queries/teams';
import type { Role } from '@/apis/client';
import { STAFF_ROLES } from '@/apis/client';
import { orgHref } from '@/lib/nav';
import { isAdminLike, outranks, useSessionUser } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import { PhoneNumber } from '@/components/shared/PhoneNumber';
import { labelFor } from '@/lib/labels';
import { CreateUserDialog } from './components/CreateUserDialog';
import { InviteStaffDialog } from './components/InviteStaffDialog';
import { InvitesTab } from './components/InvitesTab';
import { ResetPasswordDialog } from '@/components/users/ResetPasswordDialog';
import {
  ChangeRoleDialog,
  DeleteUserDialog,
  EditUserDialog,
} from '@/components/users/UserActionDialogs';
import { creatableRolesFor } from '@/lib/user-roles';

// Issue #7 slice 1: ENGINEER is creatable by admin class only (neither list
// for MANAGER includes it; assertCanCreateRole rejects MANAGER->ENGINEER
// server-side regardless of canManageUsers).
//
// Issue #8 slice 2: CUSTOMER (a buyer's portal login) is likewise admin class
// only; the form then requires the lead it belongs to.

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
  projects: string[];
  /** Normalized digits-only (2026-11-18). For a CUSTOMER this is derived from
   *  their lead; `phoneSource` distinguishes the two. */
  phone?: string | null;
  phoneSource?: 'USER' | 'LEAD';
  /** Every team this user reports through, newest first (2026-11-07). */
  reportsTo?: ReportsToLine[];
  /** @deprecated Use `reportsTo`. Kept for one release. */
  reportsToPrimary?: { id: string; name: string; email: string } | null;
};

export default function UsersPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const [roleFilter, setRoleFilter] = useState<Role[]>([]);
  // Server-side search (autoplan 2026-09-09): the toolbar search input feeds
  // the `search` query param (≥2 chars hits the API, mirrors leads D9).
  // The input value updates immediately; the server query is debounced 300ms
  // so the API isn't hit on every keystroke.
  const [search, setSearch] = useState('');
  // Debounced server search (autoplan 2026-09-09): useDebouncedValue from
  // @paalstack/react-hooks debounces the input so the API isn't hit on
  // every keystroke (300ms).
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const serverSearch = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;
  // Server-side pagination (T-SRVPG, mirrors leads): page is 1-indexed
  // (the DataTable Pagination is 1-indexed); offset = (page - 1) * pageSize.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const usersQuery = useUsers({
    role: roleFilter.length > 0 ? roleFilter : undefined,
    search: serverSearch,
    // 2026-11-18: the admin directory is the ONE surface that shows phones.
    // Every picker built on useUsers deliberately leaves this off.
    includePhone: true,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const changeRole = useChangeUserRole();
  // Team registry for the create dialog - ADMIN/OWNER sees every team so
  // they can link a new TELECALLER/SALES_EXEC to one (the backend rejects
  // staff users without a teamId). MANAGER's team is auto-resolved server-side.
  const teamsQuery = useTeams();
  const [createOpen, setCreateOpen] = useState(false);
  // Staff-invite dialog (2026-11-20). A SEPARATE open state from createOpen:
  // the two dialogs are different provisioning paths and only one should ever
  // be mounted open, but sharing a flag would make the trigger ambiguous.
  const [inviteOpen, setInviteOpen] = useState(false);
  // Which panel the tabs show. Local state, not the URL: useSearchParams in
  // Next 16 needs a Suspense boundary, which would restructure the tree
  // page.test.tsx asserts on - and this page's manual create path must stay
  // untouched. URL persistence is a follow-up on its own merits.
  const [tab, setTab] = useState<'members' | 'invites'>('members');
  const [mounted, setMounted] = useState(false);

  // Row-action targets (autoplan 2026-09-09).
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [roleTarget, setRoleTarget] = useState<UserRow | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<UserRow | null>(null);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // page → "Hydration failed because the server rendered HTML didn't match
  // the client." Render the skeleton for the first client paint too, then
  // swap after mount (same pattern as app-header.tsx).
  //
  // NOTE: this gate means `renderToStaticMarkup` (which never runs effects)
  // always renders the Skeleton. The test file mocks `useEffect` to run
  // synchronously so the real page renders (see page.test.tsx).
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
          Only owners and admins can manage users.
        </TypographyP>
      </div>
    );
  }

  // Creatable roles are actor-specific (assertCanCreateRole in
  // apps/backend/src/users/roles.ts is the server-side source of truth):
  // OWNER outranks ADMIN too, so only OWNER may create an ADMIN user.
  // The table lives in lib/user-roles.ts now: the user-detail page offers the
  // same role change, and one copy of a permission list is the only safe number.
  const creatableRoles = creatableRolesFor(user.role);

  const users = Array.isArray(usersQuery.data?.rows) ? (usersQuery.data?.rows ?? []) : [];
  const total = usersQuery.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        breadcrumb={[{ label: 'Admin' }, { label: 'Users' }]}
        subtitle={
          isAdminLike(user.role) ? 'All users across the organization.' : 'Your team members.'
        }
        action={
          // Two provisioning paths, side by side:
          //   "Add user"      - the EXISTING temp-password dialog (unchanged).
          //   "Invite staff"  - a link the staff member completes themselves.
          // Both are offered to the same actor set, and `creatableRolesFor`
          // gates which roles each may use, so they can never disagree.
          <div className="flex flex-wrap items-center gap-2">
            <CreateUserDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              creatableRoles={[...creatableRoles]}
              createUser={createUser}
              showTeamField={isAdminLike(user.role)}
              teams={teamsQuery.data ?? []}
              teamsLoading={teamsQuery.isLoading}
            />
            <InviteStaffDialog
              open={inviteOpen}
              onOpenChange={setInviteOpen}
              creatableRoles={[...creatableRoles]}
              showTeamField={isAdminLike(user.role)}
              teams={teamsQuery.data ?? []}
              teamsLoading={teamsQuery.isLoading}
            />
          </div>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next === 'invites' ? 'invites' : 'members')}
        variant="line"
        tabs={[
          {
            value: 'members',
            // The existing tree, moved here untouched: same skeletons, same
            // error block, same UserTable and same dialogs below.
            label: 'Members',
            content: (
              <>
                {usersQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : usersQuery.error !== null && usersQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load users.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {usersQuery.error instanceof Error ? usersQuery.error.message : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void usersQuery.refetch()}
            data-qa="users-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : (
        <UserTable
          users={users}
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          selfId={user.id}
          actorRole={user.role}
          isFetching={usersQuery.isFetching}
          roleFilter={roleFilter}
          onRoleFilterChange={(roles) => {
            setRoleFilter(roles);
            setPage(1); // a new filter starts back at page 1
          }}
          search={search}
          onSearchChange={(next) => {
            setSearch(next);
            setPage(1); // a new search starts back at page 1
          }}
          onEdit={(row) => setEditTarget(row)}
          onDelete={(row) => setDeleteTarget(row)}
          onRoleChange={(row) => setRoleTarget(row)}
          onChangePassword={(row) => setPasswordTarget(row)}
          createTrigger={
            <CreateUserDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              creatableRoles={[...creatableRoles]}
              createUser={createUser}
              showTeamField={isAdminLike(user.role)}
              teams={teamsQuery.data ?? []}
              teamsLoading={teamsQuery.isLoading}
            />
          }
        />
      )}

      <EditUserDialog
        target={editTarget}
        updateUser={updateUser}
        onClose={() => setEditTarget(null)}
      />

      <DeleteUserDialog
        target={deleteTarget}
        deleteUser={deleteUser}
        onClose={() => setDeleteTarget(null)}
      />

      <ChangeRoleDialog
        target={roleTarget}
        // CUSTOMER is create-only: it needs a lead pointer that a role change cannot collect.
        assignableRoles={creatableRoles.filter((r) => r !== 'CUSTOMER')}
        changeRole={changeRole}
        onClose={() => setRoleTarget(null)}
      />

      <ResetPasswordDialog target={passwordTarget} onClose={() => setPasswordTarget(null)} />
              </>
            ),
          },
          {
            value: 'invites',
            label: 'Invites',
            content: (
              <InvitesTab
                createTrigger={
                  <InviteStaffDialog
                    open={inviteOpen}
                    onOpenChange={setInviteOpen}
                    creatableRoles={[...creatableRoles]}
                    showTeamField={isAdminLike(user.role)}
                    teams={teamsQuery.data ?? []}
                    teamsLoading={teamsQuery.isLoading}
                  />
                }
              />
            ),
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table + row actions (DataTable)
// ---------------------------------------------------------------------------

/**
 * In-app row-actions menu for a user row (Edit / Change role / Delete).
 *
 * Uses the published DropdownMenu composition primitives + Tooltip directly
 * instead of `DataTableRowActions` because the shipped `DataTableActionItem`
 * has no `disabled`/`disabledReason` field - so we render each action as a
 * normal item when allowed, or as a DISABLED item wrapped in a Tooltip that
 * explains why when it isn't (your own row, or a target you don't strictly
 * outrank). Mirror of the backend hierarchy guards in users.service.
 */
function UserRowActions({
  target,
  selfId,
  actorRole,
  onEdit,
  onDelete,
  onRoleChange,
  onChangePassword,
}: {
  target: UserRow;
  selfId: string;
  actorRole: Role;
  onEdit: (row: UserRow) => void;
  onDelete: (row: UserRow) => void;
  onRoleChange: (row: UserRow) => void;
  onChangePassword: (row: UserRow) => void;
}) {
  const isSelf = target.id === selfId;
  const outranksTarget = outranks(actorRole, target.role);

  // Soft-delete is ADMIN/OWNER only (autoplan 2026-09-09).
  const canDelete = isAdminLike(actorRole);

  // Reason an action is disabled (shown in the hover tooltip).
  const reason = (action: string): string | undefined => {
    if (isSelf) return `You can't ${action} your own user`;
    if (!outranksTarget) return `You can't ${action} a ${labelFor('role', target.role)} user`;
    return undefined;
  };

  const editReason = reason('edit');
  const roleReason = reason('change the role of');
  // Delete: only ADMIN/OWNER may soft-delete (and never the OWNER / self).
  const deleteReason = !canDelete
    ? 'Only ADMIN or OWNER can delete users'
    : target.role === 'OWNER'
      ? "You can't delete the OWNER"
      : reason('delete');

  type ActionItem = {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    disabledReason?: string;
    onClick: () => void;
  };

  const items: ActionItem[] = [
    {
      label: 'Edit',
      icon: LuPencil,
      disabledReason: editReason,
      onClick: () => onEdit(target),
    },
    {
      label: 'Change role',
      icon: LuUserCog,
      disabledReason: roleReason,
      onClick: () => onRoleChange(target),
    },
    {
      label: 'Change password',
      icon: LuKeyRound,
      disabledReason: !canDelete
        ? 'Only ADMIN or OWNER can change passwords'
        : isSelf
          ? 'Use Settings to change your own password'
          : reason('change the password of'),
      onClick: () => onChangePassword(target),
    },
    {
      label: 'Delete',
      icon: LuTrash2,
      disabledReason: deleteReason,
      onClick: () => onDelete(target),
    },
  ];

  return (
    <div className="text-right" data-qa="user-row-actions">
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
          {items.map((item) => {
            if (item.disabledReason) {
              return (
                <Tooltip
                  key={item.label}
                  content={item.disabledReason}
                  side="right"
                  trigger={
                    <DropdownMenuItem
                      className="pointer-events-auto cursor-not-allowed! opacity-50"
                      data-qa="data-table-row-action-item"
                    >
                      <item.icon
                        className="text-muted-foreground mr-2 size-4"
                        data-qa="data-table-row-action-item-icon"
                      />
                      {item.label}
                    </DropdownMenuItem>
                  }
                />
              );
            }
            return (
              <DropdownMenuItem
                key={item.label}
                onClick={item.onClick}
                data-qa="data-table-row-action-item"
              >
                <item.icon
                  className="text-muted-foreground mr-2 size-4"
                  data-qa="data-table-row-action-item-icon"
                />
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

function UserTable({
  users,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  selfId,
  actorRole,
  isFetching,
  roleFilter,
  onRoleFilterChange,
  search,
  onSearchChange,
  onEdit,
  onDelete,
  onRoleChange,
  onChangePassword,
  createTrigger,
}: {
  users: BackendCreatedUser[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  selfId: string;
  actorRole: Role;
  isFetching: boolean;
  roleFilter: Role[];
  onRoleFilterChange: (roles: Role[]) => void;
  search: string;
  onSearchChange: (next: string) => void;
  onEdit: (row: UserRow) => void;
  onDelete: (row: UserRow) => void;
  onRoleChange: (row: UserRow) => void;
  onChangePassword: (row: UserRow) => void;
  createTrigger: React.ReactNode;
}) {
  const orgSlug = useOrgSlug();
  const router = useRouter();
  // Server-driven role filter (autoplan 2026-09-09): a MultiSelect in the
  // toolbar feeds the `role` query param directly (mirrors the leads page
  // status filter). The backend applies WHERE role IN (...) and returns the
  // filtered set, so multi-role selection works correctly.
  const roleOptions = useMemo(
    () =>
      STAFF_ROLES.map((role) => ({
        value: role,
        label: labelFor('role', role),
      })),
    [],
  );

  // Phone, Reports to and Projects are the three widest columns and the three
  // least needed to recognise a person. At 390px they pushed the row-actions
  // menu to x=829 in a 357px scroller: present in the DOM, invisible in
  // practice, with no cue that the table scrolled. Below md they are dropped so
  // the actions land on screen.
  const compact = useMediaQuery('(max-width: 767px)');

  const columns = useMemo<DataTableColumnDef<UserRow>[]>(() => {
    const all: DataTableColumnDef<UserRow>[] = [
      {
        accessorKey: 'name',
        header: 'Name',
        // The name cell is the row's identity link: it opens THIS user's
        // page (/admin/users/[userId]) - the same entity the table lists.
        // The whole row is clickable too (tableRowProps below); the link
        // keeps middle-click / cmd-click / keyboard working.
        cell: ({ row }) => (
          // min-w-45 keeps the name from wrapping mid-surname on desktop, but a
          // 180px floor is a third of a 390px screen and is most of why the
          // table overflowed there.
          <div className={compact ? 'min-w-0' : 'min-w-45'}>
            <Link
              href={orgHref(orgSlug, `/admin/users/${row.original.id}`)}
              className="text-link text-sm font-medium hover:underline hover:underline-offset-2"
              data-qa={`user-row-link-${row.original.id}`}
            >
              {row.original.name}
            </Link>
            {row.original.id === selfId ? (
              <span className="text-muted-foreground block text-xs">(you)</span>
            ) : null}
          </div>
        ),
        enableSorting: true,
      },
      {
        id: 'email',
        accessorKey: 'email',
        header: 'Email',
        // Hidden below md with phone/reportsTo/projects: a long address alone was
        // wider than the viewport. The name still links to the detail page, and
        // the search matches email, so nothing becomes unreachable.
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">{row.original.email}</span>
        ),
        enableSorting: true,
      },
      {
        id: 'phone',
        header: 'Phone',
        // 2026-11-18: staff numbers come from the account; a CUSTOMER's comes
        // from their lead. The distinction is stated rather than hidden - a
        // buyer's number is not editable here, and the tooltip/aria says so,
        // because "why can't I edit this one?" is the obvious next question.
        cell: ({ row }) => {
          const { phone, phoneSource, id } = row.original;
          if (phone === null || phone === undefined || phone.length === 0) {
            return (
              <span className="text-muted-foreground text-sm" data-qa={`user-phone-empty-${id}`}>
                -
              </span>
            );
          }
          return (
            <span className="inline-flex flex-col">
              <PhoneNumber
                phone={phone}
                className="text-sm"
                ariaLabel={phoneSource === 'LEAD' ? `Phone from lead: ${phone}` : `Phone: ${phone}`}
              />
              {phoneSource === 'LEAD' ? (
                <span className="text-muted-foreground text-xs">from lead</span>
              ) : null}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'role',
        header: 'Role',
        // Role is shown as TEXT (autoplan 2026-09-09). Changing it is a
        // critical action that requires explicit approval, so it lives in
        // the Actions column (Change role → confirm dialog), not an inline
        // Select that fires on change.
        cell: ({ row }) => (
          <span className="text-sm font-medium">{labelFor('role', row.original.role)}</span>
        ),
        enableSorting: false,
      },
      {
        id: 'reportsTo',
        header: 'Reports to',
        // One line per team (2026-11-07): a two-team engineer reports to two
        // managers, and showing only one hid a real line. MANAGER/ADMIN keep
        // their fixed org-OWNER line; the OWNER shows a dash.
        cell: ({ row }) => {
          const lines = row.original.reportsTo ?? [];
          if (lines.length === 0) {
            return (
              <span
                className="text-muted-foreground text-sm"
                data-qa={`user-reports-to-${row.original.id}`}
              >
                -
              </span>
            );
          }
          return (
            <div
              className="flex flex-col gap-0.5"
              data-qa={`user-reports-to-${row.original.id}`}
              data-reports-to-count={lines.length}
            >
              {lines.map((line) => (
                <Tooltip
                  key={line.teamId === '' ? 'org-owner' : line.teamId}
                  content={
                    line.manager ? line.manager.email : `${line.teamName} has no manager yet`
                  }
                  side="top"
                  trigger={
                    <span className="text-sm" data-qa="user-reports-to-name">
                      {line.manager ? line.manager.name : `${line.teamName}: nobody`}
                      {/* The team qualifier matters once there is more than
                          one line: two names with no context read as a bug. */}
                      {lines.length > 1 ? (
                        <span className="text-muted-foreground"> · {line.teamName}</span>
                      ) : null}
                    </span>
                  }
                />
              ))}
            </div>
          );
        },
        enableSorting: false,
      },
      {
        // `id` is explicit so the compact filter can name it; accessorKey stays
        // for the sort/accessor. phone and reportsTo already do the same.
        id: 'projects',
        accessorKey: 'projects',
        header: 'Projects',
        // Shows a COUNT, not the joined name list (autoplan 2026-09-13) -
        // the list wrapped/clipped for users on many projects. The full
        // list is still one hover away via a Tooltip.
        cell: ({ row }) => {
          const { projects } = row.original;
          if (projects.length === 0) {
            return <span className="text-muted-foreground text-sm">0 projects</span>;
          }
          return (
            <Tooltip
              content={projects.join(', ')}
              side="top"
              trigger={
                <span className="text-muted-foreground text-sm underline decoration-dotted">
                  {projects.length} {projects.length === 1 ? 'project' : 'projects'}
                </span>
              }
            />
          );
        },
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <UserRowActions
            target={row.original}
            selfId={selfId}
            actorRole={actorRole}
            onEdit={onEdit}
            onDelete={onDelete}
            onRoleChange={onRoleChange}
            onChangePassword={onChangePassword}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ];
    if (!compact) return all;
    const droppedForPhone = new Set(['email', 'phone', 'reportsTo', 'projects']);
    return all.filter((column) => !droppedForPhone.has(column.id ?? ''));
  }, [selfId, actorRole, orgSlug, onEdit, onDelete, onRoleChange, onChangePassword, compact]);

  const isSearchActive = search.trim().length > 0;

  return (
    <div className="space-y-2">
      <DataTable
        // The actions column is pinned to the right edge of the scroller. Even
        // with four columns dropped on a phone the table can still be a few
        // pixels wider than the screen, and a menu that is 3px off screen is as
        // unreachable as one 300px off screen. `bg-card` covers the cells that
        // scroll underneath it.
        className="[&_td:last-child]:bg-card [&_th:last-child]:bg-card [&_td:last-child]:sticky [&_td:last-child]:right-0 [&_td:last-child]:z-[1] [&_th:last-child]:sticky [&_th:last-child]:right-0 [&_th:last-child]:z-[1]"
        columns={columns}
        rows={users}
        // Search is server-side (onSearchValueChange → API). The DataTable's
        // built-in client-side global filter is redundant here AND would hide
        // rows over the already-filtered page - make it a no-op so it never
        // filters client-side (the backend already returns the filtered set).
        globalFilterFn={() => true}
        search={{
          accessorKey: ['name', 'email'],
          placeholder: 'Search by name or email...',
          searchValue: search,
          onSearchValueChange: onSearchChange,
          className: 'mr-2',
        }}
        showPagination
        paginationProps={{
          total,
          currentPage: page,
          onPageChange,
          pageSize,
          onPageSizeChange,
          pageSizeOptions: [10, 25, 50],
          showTotalResults: true,
          showOnlyIfTotalGreaterThanPageSize: true,
        }}
        // Whole-row click → that user's page (/admin/users/[userId]). The
        // name cell keeps its Link (middle-click / cmd-click / keyboard).
        // Skip interactive controls so the row-actions menu and the name
        // link don't double-navigate.
        tableRowProps={{
          className: 'cursor-pointer',
          onClick: (row, event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('a, button, [role="menuitem"]')) return;
            router.push(orgHref(orgSlug, `/admin/users/${row.original.id}`));
          },
        }}
        isLoading={isFetching}
        loadingContent={<Loading content="Loading users..." />}
        toolbarLeftSideContent={
          <Combobox
            multiple
            value={roleFilter}
            onValueChange={(next) => {
              const arr = (next as string[]) ?? [];
              onRoleFilterChange(arr as Role[]);
            }}
            options={roleOptions}
            placeholder="Filter by role"
            selectOptionAsValue
            maxSelectedChips={2}
            className="max-w-96 min-w-48"
            data-qa="users-role-filter"
          />
        }
        emptyContent={
          isSearchActive ? (
            <div className="space-y-1 rounded-lg p-10 text-center">
              <TypographyP className="text-xl font-medium">No users match your search.</TypographyP>
              <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                Check the spelling or try a different name or email.
              </TypographyP>
            </div>
          ) : (
            <div className="space-y-1 rounded-lg p-10 text-center">
              <TypographyP className="text-xl font-medium">No users yet.</TypographyP>
              <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                Create a user to get started.
              </TypographyP>
              <div className="flex justify-center pt-2">{createTrigger}</div>
            </div>
          )
        }
        tableContainerClassName="rounded-lg border"
      />
    </div>
  );
}
