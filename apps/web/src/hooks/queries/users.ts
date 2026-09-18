// Users module - the one LIVE backend surface (apps/backend/src/users).
// Endpoints mirror apps/backend/src/users/users.controller.ts:
//   POST   /api/users         → CreatedUser   (role hierarchy enforced server-side)
//   GET    /api/users         → CreatedUser[] (scope filtered per role)
//   PATCH  /api/users/:id/role → CreatedUser
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs, type Role } from '@/apis/client';

export type BackendCreatedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  /** Project names the user is a member of (via ProjectMember). */
  projects: string[];
};

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: Role;
  teamId?: string;
};

const USERS_KEY = ['users'] as const;

export type UsersFilter = {
  role?: Role[];
  search?: string;
  /** Narrow to staff of ONE project (T-USER-PROJECT-SCOPE). */
  projectId?: string;
  limit?: number;
  offset?: number;
};

export type UsersListResult = {
  rows: BackendCreatedUser[];
  total: number;
};

export function useUsers(filter: UsersFilter = {}) {
  return useQuery({
    queryKey: [
      ...USERS_KEY,
      filter.role ?? [],
      filter.search ?? '',
      // T-USER-PROJECT-SCOPE: part of the KEY, not just the request. Without it
      // the picker would serve the previous project's list from cache.
      filter.projectId ?? '',
      filter.limit,
      filter.offset,
    ],
    queryFn: ({ signal }) =>
      api<UsersListResult>(
        `/users${qs({
          role: filter.role?.join(','),
          search: filter.search,
          projectId: filter.projectId,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * GET /api/users/team - the actor's team + manager, for the chat mention
 * picker. Unlike `useUsers` (staff→self only), this returns the whole team
 * so a telecaller can see + mention their manager and teammates.
 */
export function useTeamMembers(projectId?: string) {
  return useQuery({
    queryKey: ['users', 'team', projectId ?? ''] as const,
    queryFn: ({ signal }) =>
      api<BackendCreatedUser[]>(
        `/users/team${qs({ projectId })}`,
        { signal },
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * GET /api/users/project/:projectId/sales-execs - SALES_EXEC staff linked
 * to a project, for the schedule-visit exec picker. Server-scoped by role:
 * MANAGER → own team's execs; ADMIN/OWNER → all project execs.
 */
export function useProjectSalesExecs(projectId: string | undefined) {
  return useQuery({
    queryKey: ['users', 'project', projectId, 'sales-execs'] as const,
    enabled: projectId !== undefined && projectId.length > 0,
    queryFn: ({ signal }) =>
      api<BackendCreatedUser[]>(`/users/project/${projectId as string}/sales-execs`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export type UserDetailProject = {
  id: string;
  name: string;
};

export type BackendUserDetail = {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  teamName: string | null;
  /** Populated only for TELECALLER/SALES_EXEC whose team has a manager. */
  manager: { id: string; name: string; email: string } | null;
  projects: UserDetailProject[];
};

/**
 * GET /api/users/:id - the user detail page (users/[userId], autoplan
 * 2026-09-13). Scope mirrors `useUsers`: ADMIN/OWNER see anyone; MANAGER
 * sees their own team + self; staff see only themselves (server-enforced).
 */
export function useUser(id: string | undefined) {
  return useQuery({
    queryKey: [...USERS_KEY, id ?? ''],
    enabled: id !== undefined && id.length > 0,
    queryFn: ({ signal }) =>
      api<BackendUserDetail>(`/users/${id as string}`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      api<BackendCreatedUser>('/users', { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      // Creating a MANAGER auto-creates their team server-side, so the team
      // list the create dialog's Combobox reads must be refreshed too.
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

export function useChangeUserRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api<BackendCreatedUser>(`/users/${id}/role`, {
        method: 'PATCH',
        json: { role },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      email,
    }: {
      id: string;
      name?: string;
      email?: string;
    }) =>
      api<BackendCreatedUser>(`/users/${id}`, {
        method: 'PATCH',
        json: { name, email },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

/** Result of PATCH /api/users/me (self-profile edit, settings page). */
export type BackendUpdatedProfile = {
  id: string;
  name: string;
  email: string;
  role: Role;
};

/**
 * PATCH /api/users/me - edit your OWN profile name (settings page, 2026-09-18).
 *
 * No id is passed: the backend resolves the target from the JWT subject, so
 * this hook cannot be misused to edit someone else. Deliberately NOT built on
 * `useUpdateUser` - PATCH /users/:id is the hierarchy-gated ADMIN route and it
 * refuses self-edits, so routing a self-edit through it would 403.
 *
 * Invalidates the users list (so an admin's directory shows the new name), and
 * the caller follows up with a session refetch - the sidebar/topbar read the
 * name from the better-auth session, not from this query.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name }: { name: string }) =>
      api<BackendUpdatedProfile>('/users/me', {
        method: 'PATCH',
        json: { name },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

/**
 * PATCH /api/users/:id/manager - assign/reassign a TELECALLER/SALES_EXEC's
 * manager (autoplan 2026-09-13), by moving them into the manager's team.
 * Invalidates the user-detail query too (not just the list) so the
 * detail page's manager/team panel refreshes immediately.
 */
export function useAssignManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, teamId }: { id: string; teamId: string }) =>
      api<BackendCreatedUser>(`/users/${id}/manager`, {
        method: 'PATCH',
        json: { teamId },
      }),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      void queryClient.invalidateQueries({ queryKey: [...USERS_KEY, id] });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

export { qs };