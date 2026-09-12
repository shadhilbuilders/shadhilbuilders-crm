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
      filter.limit,
      filter.offset,
    ],
    queryFn: ({ signal }) =>
      api<UsersListResult>(
        `/users${qs({
          role: filter.role?.join(','),
          search: filter.search,
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
export function useTeamMembers() {
  return useQuery({
    queryKey: ['users', 'team'] as const,
    queryFn: ({ signal }) => api<BackendCreatedUser[]>('/users/team', { signal }),
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