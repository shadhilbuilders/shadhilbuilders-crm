'use client';

// Users management — LIVE against apps/backend/src/users (the one built
// backend module). Role hierarchy (Round 17/20, locked):
//   SUPER_ADMIN ≙ ADMIN on this surface → create any role below admin,
//   MANAGER → TELECALLER / SALES_EXEC in own team.
// Guards enforced server-side; the UI mirrors them for fast feedback and
// shows real API errors (400 = policy rejection) verbatim.
import {
  Button,
  Dialog,
  Field,
  Heading,
  Select,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import { LuPlus } from '@paalstack/react-icons/lu';
import { useState } from 'react';

import {
  useChangeUserRole,
  useCreateUser,
  useUsers,
  type BackendCreatedUser,
} from '@/hooks/queries/users';
import type { Role } from '@/apis/client';
import {
  canManageUsers,
  isAdminLike,
  useSessionUser,
} from '@/lib/session';

const CREATABLE_FOR_ADMIN = ['MANAGER', 'TELECALLER', 'SALES_EXEC'] as const;
const CREATABLE_FOR_MANAGER = ['TELECALLER', 'SALES_EXEC'] as const;

export default function UsersPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const usersQuery = useUsers();
  const [createOpen, setCreateOpen] = useState(false);

  if (sessionPending) {
    return <div className="text-muted-foreground py-24 text-center text-sm">Loading…</div>;
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading className="mb-1">Users</Heading>
          <TypographyP className="text-muted-foreground text-sm">
            {isAdminLike(user.role)
              ? 'All users across the organization.'
              : 'Your team members.'}
          </TypographyP>
        </div>
        <Dialog
          trigger={
            <Button size="sm" className="min-h-11">
              <LuPlus className="mr-1 h-4 w-4" /> Create user
            </Button>
          }
          header={{ title: 'Create a user' }}
          open={createOpen}
          onOpenChange={setCreateOpen}
        >
          <CreateUserForm
            creatableRoles={[...creatableRoles]}
            onDone={() => setCreateOpen(false)}
          />
        </Dialog>
      </div>

      {usersQuery.isLoading ? (
        <div className="text-muted-foreground py-16 text-center text-sm">
          Loading users…
        </div>
      ) : usersQuery.data !== undefined && Array.isArray(usersQuery.data) ? (
        <UserTable
          users={usersQuery.data}
          assignableRoles={[...creatableRoles]}
          selfId={user.id}
        />
      ) : (
        <div className="border-border rounded-lg border p-10 text-center text-sm">
          {usersQuery.error instanceof Error
            ? usersQuery.error.message
            : 'Failed to load users.'}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table + role editing
// ---------------------------------------------------------------------------

function UserTable({
  users,
  assignableRoles,
  selfId,
}: {
  users: BackendCreatedUser[];
  assignableRoles: string[];
  selfId: string;
}) {
  const changeRole = useChangeUserRole();

  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border bg-muted/40 border-b text-left">
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Name</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Email</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Role</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">
              Team
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-border border-b last:border-b-0">
              <td className="px-4 py-2.5 font-medium">{user.name}</td>
              <td className="text-muted-foreground px-4 py-2.5">{user.email}</td>
              <td className="px-4 py-2.5">
                {user.id === selfId ? (
                  <span className="text-muted-foreground text-xs">
                    {user.role} (you)
                  </span>
                ) : (
                  <Select
                    options={[
                      { value: user.role, label: user.role },
                      ...assignableRoles
                        .filter((role) => role !== user.role)
                        .map((role) => ({ value: role, label: role })),
                    ]}
                    value={user.role}
                    onValueChange={(next) => {
                      if (typeof next !== 'string' || next === user.role) return;
                      changeRole.mutate({ id: user.id, role: next as Role });
                    }}
                  />
                )}
              </td>
              <td className="text-muted-foreground hidden px-4 py-2.5 md:table-cell">
                {user.teamId ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {changeRole.isError && changeRole.error instanceof Error ? (
        <p className="text-destructive px-4 pb-3 text-xs">{changeRole.error.message}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form — posts to POST /api/users (server enforces the hierarchy)
// ---------------------------------------------------------------------------

function CreateUserForm({
  creatableRoles,
  onDone,
}: {
  creatableRoles: string[];
  onDone: () => void;
}) {
  const createUser = useCreateUser();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(
    (creatableRoles[0] as Role | undefined) ?? 'TELECALLER',
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    createUser.mutate(
      { name, email, password, role },
      {
        onSuccess: () => {
          toast.success(`User ${name} created`);
          onDone();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Create failed');
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label="Name">
        <input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          required
          autoComplete="name"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Field>
      <Field label="Email">
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          required
          autoComplete="email"
          placeholder="name@shadhilbuilders.in"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Field>
      <Field label="Temporary password" description="Minimum 8 characters. User should change it after first sign-in.">
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Field>
      <Field label="Role">
        <Select
          options={creatableRoles.map((value) => ({ value, label: value }))}
          value={role}
          onValueChange={(next) => {
            if (typeof next === 'string') setRole(next);
          }}
        />
      </Field>
      {createUser.isError && createUser.error instanceof Error ? (
        <p className="text-destructive text-xs">{createUser.error.message}</p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={createUser.isPending}>
          {createUser.isPending ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </form>
  );
}