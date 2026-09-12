'use client';

// Users management - LIVE against apps/backend/src/users (the one built
// backend module). Role hierarchy (Round 17/20/21, locked):
//   OWNER ≙ ADMIN on this surface → create any role below admin,
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
  AlertDialog,
  Button,
  Combobox,
  DataTable,
  Dialog,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Form,
  Heading,
  Loading,
  MultiSelect,
  toast,
  Tooltip,
  TypographyP,
  TypographyStrong,
} from '@paalstack/react-ui';
import type { DataTableColumnDef, FormFieldItemType } from '@paalstack/react-ui';
import { useDebouncedValue } from '@paalstack/react-hooks';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  LuEllipsis,
  LuPencil,
  LuPlus,
  LuTrash2,
  LuUserCog,
} from '@paalstack/react-icons/lu';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import z from 'zod';

import { ChangeRoleDtoSchema, CreateUserDtoSchema, UpdateUserDtoSchema } from '@shadhil/api-types';
import {
  useChangeUserRole,
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useUsers,
  type BackendCreatedUser,
} from '@/hooks/queries/users';
import { useTeams } from '@/hooks/queries/teams';
import type { Role } from '@/apis/client';
import { STAFF_ROLES } from '@/apis/client';
import {
  canManageUsers,
  isAdminLike,
  outranks,
  useSessionUser,
} from '@/lib/session';

import { PasswordInput } from '@/components/shared/PasswordInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import { labelFor } from '@/lib/labels';

const CREATABLE_FOR_ADMIN = ['MANAGER', 'TELECALLER', 'SALES_EXEC'] as const;
const CREATABLE_FOR_MANAGER = ['TELECALLER', 'SALES_EXEC'] as const;

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
  projects: string[];
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
  const serverSearch =
    debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;
  // Server-side pagination (T-SRVPG, mirrors leads): page is 1-indexed
  // (the DataTable Pagination is 1-indexed); offset = (page - 1) * pageSize.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const usersQuery = useUsers({
    role: roleFilter.length > 0 ? roleFilter : undefined,
    search: serverSearch,
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
  const [mounted, setMounted] = useState(false);

  // Row-action targets (autoplan 2026-09-09).
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [roleTarget, setRoleTarget] = useState<UserRow | null>(null);

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
  if (user === null || !canManageUsers(user.role)) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only admins and managers can manage users.
        </TypographyP>
      </div>
    );
  }

  const creatableRoles = isAdminLike(user.role)
    ? CREATABLE_FOR_ADMIN
    : CREATABLE_FOR_MANAGER;

  const users = Array.isArray(usersQuery.data?.rows)
    ? usersQuery.data.rows
    : [];
  const total = usersQuery.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        breadcrumb={[{ label: 'Admin' }, { label: 'Users' }]}
        subtitle={
          isAdminLike(user.role)
            ? 'All users across the organization.'
            : 'Your team members.'
        }
      />

      {usersQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : usersQuery.error !== null && usersQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load users.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {usersQuery.error instanceof Error
              ? usersQuery.error.message
              : 'Unexpected error.'}
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
          createTrigger={
            <Dialog
              trigger={
                <Button leftIcon={<LuPlus className="h-4 w-4" />}>
                  Create user
                </Button>
              }
              header={{ title: 'Create a user' }}
              open={createOpen}
              onOpenChange={setCreateOpen}
              contentClassName='sm:max-w-md'
              footer={
                <div className="flex w-full justify-end gap-2">
                  <Button variant="outline" onClick={() => setCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    form="create-user-form"
                    isLoading={createUser.isPending}
                    loadingText="Creating..."
                    data-qa="create-user-submit"
                  >
                    Create user
                  </Button>
                </div>
              }
            >
              <CreateUserForm
                creatableRoles={[...creatableRoles]}
                createUser={createUser}
                onDone={() => setCreateOpen(false)}
                showTeamField={isAdminLike(user.role)}
                teams={teamsQuery.data ?? []}
                teamsLoading={teamsQuery.isLoading}
              />
            </Dialog>
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
        assignableRoles={[...creatableRoles]}
        changeRole={changeRole}
        onClose={() => setRoleTarget(null)}
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
 * has no `disabled`/`disabledReason` field — so we render each action as a
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
}: {
  target: UserRow;
  selfId: string;
  actorRole: Role;
  onEdit: (row: UserRow) => void;
  onDelete: (row: UserRow) => void;
  onRoleChange: (row: UserRow) => void;
}) {
  const isSelf = target.id === selfId;
  const outranksTarget = outranks(actorRole, target.role);

  // Soft-delete is ADMIN/OWNER only (autoplan 2026-09-09).
  const canDelete = isAdminLike(actorRole);

  // Reason an action is disabled (shown in the hover tooltip).
  const reason = (action: string): string | undefined => {
    if (isSelf) return `You can't ${action} your own user`;
    if (!outranksTarget)
      return `You can't ${action} a ${labelFor('role', target.role)} user`;
    return undefined;
  };

  const editReason = reason('edit');
  const roleReason = reason('change the role of');
  // Delete: only ADMIN/OWNER may soft-delete (and never the OWNER / self).
  const deleteReason = !canDelete
    ? "Only ADMIN or OWNER can delete users"
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
        <DropdownMenuContent align="end" className="w-40">
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
                        className="mr-2 size-4 text-muted-foreground"
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
                  className="mr-2 size-4 text-muted-foreground"
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
  createTrigger: React.ReactNode;
}) {
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

  const columns = useMemo<DataTableColumnDef<UserRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-45">
            <span className="text-sm font-medium">{row.original.name}</span>
            {row.original.id === selfId ? (
              <span className="text-muted-foreground block text-xs">(you)</span>
            ) : null}
          </div>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'email',
        header: 'Email',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.email}
          </span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'role',
        header: 'Role',
        // Role is shown as TEXT (autoplan 2026-09-09). Changing it is a
        // critical action that requires explicit approval, so it lives in
        // the Actions column (Change role → confirm dialog), not an inline
        // Select that fires on change.
        cell: ({ row }) => (
          <span className="text-sm font-medium">
            {labelFor('role', row.original.role)}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'projects',
        header: 'Projects',
        cell: ({ row }) => (
          <span className="text-muted-foreground hidden text-sm md:table-cell">
            {row.original.projects.length > 0
              ? row.original.projects.join(', ')
              : '-'}
          </span>
        ),
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
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [selfId, actorRole, onEdit, onDelete, onRoleChange],
  );

  const isSearchActive = search.trim().length > 0;

  return (
    <div className="space-y-2">
      <DataTable
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
        isLoading={isFetching}
        loadingContent={<Loading content="Loading users..." />}
        toolbarLeftSideContent={
          <MultiSelect
            options={roleOptions}
            selectedValues={roleFilter}
            onSelectedValueChange={(next) =>
              onRoleFilterChange(next as Role[])
            }
            placeholder="Filter by role"
            maxSelectedBadges={2}
            triggerProps={{
              size: 'sm',
              variant: 'outline',
              className: 'min-w-48 max-w-96',
            }}
            contentProps={{ className: 'min-w-56 max-w-96' }}
            className="w-full"
            data-qa="users-role-filter"
          />
        }
        toolbarRightSideContent={createTrigger}
        emptyContent={
          isSearchActive ? (
            <div className="rounded-lg p-10 text-center space-y-1">
              <TypographyP className="text-xl font-medium">
                No users match your search.
              </TypographyP>
              <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                Check the spelling or try a different name or email.
              </TypographyP>
            </div>
          ) : (
            <div className="rounded-lg p-10 text-center space-y-1">
              <TypographyP className="text-xl font-medium">
                No users yet.
              </TypographyP>
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

// ---------------------------------------------------------------------------
// Edit dialog - PATCH /api/users/:id (hierarchy-gated server-side)
// ---------------------------------------------------------------------------

type EditUserFormValues = z.infer<typeof UpdateUserDtoSchema>;

function EditUserDialog({
  target,
  updateUser,
  onClose,
}: {
  target: UserRow | null;
  updateUser: ReturnType<typeof useUpdateUser>;
  onClose: () => void;
}) {
  const form = useForm<EditUserFormValues>({
    resolver: zodResolver(UpdateUserDtoSchema),
    values: {
      name: target?.name ?? '',
      email: target?.email ?? '',
    },
    mode: 'onSubmit',
  });

  function onSubmit(values: EditUserFormValues) {
    if (target === null) return;
    updateUser.mutate(
      { id: target.id, name: values.name, email: values.email },
      {
        onSuccess: () => {
          toast.success(`User ${values.name} updated`);
          onClose();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Update failed');
        },
      },
    );
  }

  const fields: FormFieldItemType<EditUserFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Name',
      required: true,
      placeholder: 'Enter name',
      inputProps: { autoComplete: 'name', 'data-qa': 'edit-user-name' },
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      required: true,
      placeholder: 'name@shadhilbuilders.in',
      inputProps: { autoComplete: 'email', 'data-qa': 'edit-user-email' },
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{ title: `Edit ${target?.name ?? 'user'}` }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      contentClassName='sm:max-w-md'
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-user-form"
            isLoading={updateUser.isPending}
            loadingText="Saving..."
            data-qa="edit-user-submit"
          >
            Save changes
          </Button>
        </div>
      }
    >
      <Form
        id="edit-user-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete dialog - DELETE /api/users/:id (hierarchy-gated server-side)
// ---------------------------------------------------------------------------

function DeleteUserDialog({
  target,
  deleteUser,
  onClose,
}: {
  target: UserRow | null;
  deleteUser: ReturnType<typeof useDeleteUser>;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      trigger={null}
      header={{
        title: `Delete ${target?.name ?? 'user'}?`,
        description:
          'This soft-deletes the user: they can no longer sign in and are hidden from every list. Their account is kept (not permanently erased).',
      }}
      cancelButtonText="Cancel"
      confirmButtonText={deleteUser.isPending ? 'Deleting...' : 'Delete user'}
      confirmButtonProps={{
        variant: 'destructive',
        disabled: deleteUser.isPending,
      }}
      onConfirm={() => {
        if (target === null) return;
        deleteUser.mutate(target.id, {
          onSuccess: () => {
            toast.success(`User ${target.name} soft-deleted`);
            onClose();
          },
          onError: (error) => {
            toast.error(error instanceof Error ? error.message : 'Delete failed');
          },
        });
      }}
      onCancel={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Change-role dialog - explicit approval before the critical role change
// ---------------------------------------------------------------------------

type ChangeRoleFormValues = z.infer<typeof ChangeRoleDtoSchema>;

function ChangeRoleDialog({
  target,
  assignableRoles,
  changeRole,
  onClose,
}: {
  target: UserRow | null;
  assignableRoles: string[];
  changeRole: ReturnType<typeof useChangeUserRole>;
  onClose: () => void;
}) {
  const form = useForm<ChangeRoleFormValues>({
    resolver: zodResolver(ChangeRoleDtoSchema),
    values: {
      role: target?.role ?? 'TELECALLER',
    },
    mode: 'onSubmit',
  });

  const options = useMemo(() => {
    if (target === null) return [];
    return [
      { value: target.role, label: labelFor('role', target.role) },
      ...assignableRoles
        .filter((r) => r !== target.role)
        .map((r) => ({ value: r, label: labelFor('role', r) })),
    ];
  }, [target, assignableRoles]);

  function onSubmit(values: ChangeRoleFormValues) {
    if (target === null) return;
    // Same-role submit is a no-op - surface it so the user knows the
    // change didn't apply (autoplan 2026-09-09).
    if (values.role === target.role) {
      toast.error(
        `${target.name} is already a ${labelFor('role', values.role)}. Choose a different role to change it.`,
      );
      return;
    }
    changeRole.mutate(
      { id: target.id, role: values.role },
      {
        onSuccess: () => {
          toast.success(`Role changed to ${labelFor('role', values.role)}`);
          onClose();
        },
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : 'Role change failed',
          );
        },
      },
    );
  }

  const fields: FormFieldItemType<ChangeRoleFormValues>[] = [
    {
      type: 'select',
      name: 'role',
      label: 'New role',
      required: true,
      options,
      selectProps: { 'data-qa': 'change-role-select' },
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{
        title: `Change role for ${target?.name ?? 'user'}`,
        description:
          target === null
            ? undefined
            : <>Current role: <TypographyStrong>{labelFor('role', target.role)}</TypographyStrong>. Permissions take effect as soon as you confirm.</>,
      }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      contentClassName='sm:max-w-md'
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="change-role-form"
            isLoading={changeRole.isPending}
            loadingText="Changing..."
            data-qa="change-role-confirm"
          >
            Change role
          </Button>
        </div>
      }
    >
      <Form
        id="change-role-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create form - posts to POST /api/users (server enforces the hierarchy)
// ---------------------------------------------------------------------------

// Client-side validation IS the server contract: CreateUserDtoSchema in
// packages/api-types/src/auth.ts (name/email/password rules + role enum).
// The server re-validates the same shape and surfaces errors verbatim via
// toast. teamId is optional in the schema but the service REQUIRES it when
// role is TELECALLER/SALES_EXEC (an admin creating staff without a team =
// "teamId is required"). The dialog shows the Team field only for staff roles.
type CreateUserFormValues = z.infer<typeof CreateUserDtoSchema>;

function CreateUserForm({
  creatableRoles,
  createUser,
  onDone,
  showTeamField,
  teams,
  teamsLoading,
}: {
  creatableRoles: string[];
  createUser: ReturnType<typeof useCreateUser>;
  onDone: () => void;
  showTeamField: boolean;
  teams: { id: string; name: string }[];
  teamsLoading: boolean;
}) {
  const form = useForm<CreateUserFormValues>({
    resolver: zodResolver(CreateUserDtoSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      role: (creatableRoles[0] as Role | undefined) ?? 'TELECALLER',
    },
    mode: 'onSubmit',
  });

  // Watch the role so the Team field appears only for staff (and a MANAGER
  // being created auto-creates its own team, so no team picker needed).
  const selectedRole = form.watch('role');

  function onSubmit(values: CreateUserFormValues) {
    // The payload is CreateUserDto-shaped. teamId is sent only when a staff
    // user is being created (the field is present) - the server auto-creates
    // a team for MANAGER and requires one for TELECALLER/SALES_EXEC.
    const payload: {
      name: string;
      email: string;
      password: string;
      role: Role;
      teamId?: string;
    } = {
      name: values.name,
      email: values.email,
      password: values.password,
      role: values.role,
    };
    const needsTeam = values.role === 'TELECALLER' || values.role === 'SALES_EXEC';
    if (needsTeam) {
      if (!values.teamId) {
        toast.error('Please select a team for this user.');
        return;
      }
      payload.teamId = values.teamId;
    }
    createUser.mutate(payload, {
        onSuccess: () => {
          toast.success(`User ${values.name} created`);
          onDone();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Create failed');
        },
      },
    );
  }

  const fields: FormFieldItemType<CreateUserFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Name',
      required: true,
      placeholder: 'Enter name',
      inputProps: {
        autoComplete: 'name',
        'data-qa': 'create-user-name',
      },
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      required: true,
      inputType: 'email',
      placeholder: 'name@shadhilbuilders.in',
      inputProps: {
        autoComplete: 'email',
        'data-qa': 'create-user-email',
      },
    },
    {
      type: 'custom',
      name: 'password',
      label: 'Temporary password',
      required: true,
      render: ({ field }) => (
        <PasswordInput
          {...field}
          autoComplete="new-password"
          placeholder="Minimum 8 characters"
          maxLength={200}
          className="min-h-11 w-full text-sm"
          data-qa="create-user-password"
        />
      ),
    },
    {
      type: 'select',
      name: 'role',
      label: 'Role',
      required: true,
      options: creatableRoles.map((value) => ({
        value,
        label: labelFor('role', value),
      })),
      selectProps: { 'data-qa': 'create-user-role' },
    },
  ];

  // Team field - shown only when creating a STAFF user (TELECALLER/SALES_EXEC)
  // so the user is linked to a team. The backend rejects staff users without
  // a teamId; MANAGER auto-creates a team and ADMIN/OWNER users aren't
  // created with a team here.
  const isStaffRole =
    selectedRole === 'TELECALLER' || selectedRole === 'SALES_EXEC';
  if (showTeamField && isStaffRole) {
    fields.push({
      type: 'custom',
      name: 'teamId',
      label: 'Team',
      required: true,
      render: ({ field }) => (
        <Combobox
          {...field}
          value={field.value ?? ''}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          placeholder={teamsLoading ? 'Loading teams...' : 'Search and select a team...'}
          data-qa="create-user-team"
          selectOptionAsValue
          onValueChange={(value) => {
            field.onChange(value ?? undefined);
          }}
        />
      ),
    });
  }

  return (
    <Form
      id="create-user-form"
      form={form}
      onSubmit={onSubmit}
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}
