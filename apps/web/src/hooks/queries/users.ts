// Users module — the one LIVE backend surface (apps/backend/src/users).
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
};

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: Role;
  teamId?: string;
};

const USERS_KEY = ['users'] as const;

export function useUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: ({ signal }) => api<BackendCreatedUser[]>('/users', { signal }),
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

export { qs };