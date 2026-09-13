// Teams module - GET /api/teams (apps/backend/src/teams).
// Returns the teams the actor is a member of; for ADMIN/OWNER that is ALL
// teams (server-scoped). Used by the create-user dialog to link
// TELECALLER/SALES_EXEC staff to a team (the backend rejects staff users
// without a teamId). Also powers the ADMIN/OWNER org-Teams pages
// (/teams list + /teams/[teamId] roster).
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api } from '@/apis/client';

export type TeamListItem = {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  memberCount: number;
  managerId: string | null;
  managerName: string | null;
};

// T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): TeamMemberProject/
// member.projects were removed - ProjectMember (the per-user project link
// this was derived from) was retired. Project staffing is exclusively
// team-based now (see hooks/queries/project-teams.ts) - the per-project
// Staff page (ProjectTeamList) is the place to see "which projects", not
// a per-row field duplicated on every team roster member.
export type TeamMemberRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
};

export type TeamDetail = {
  id: string;
  name: string;
  manager: { id: string; name: string; email: string } | null;
  members: TeamMemberRow[];
};

const TEAMS_KEY = ['teams'] as const;

export function useTeams() {
  return useQuery({
    queryKey: TEAMS_KEY,
    queryFn: ({ signal }) => api<TeamListItem[]>('/teams', { signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** GET /api/teams/:id - ADMIN/OWNER org-Teams roster. */
export function useTeam(id: string | undefined) {
  return useQuery({
    queryKey: [...TEAMS_KEY, id ?? ''],
    enabled: id !== undefined && id.length > 0,
    queryFn: ({ signal }) =>
      api<TeamDetail>(`/teams/${id as string}`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Team CRUD + reassign (T-TEAM-CRUD, 2026-09-13) - mirrors
// hooks/queries/projects.ts's useCreateProject/useUpdateProject/
// useDeleteProject mutations. ADMIN/OWNER only (service-enforced; a
// non-admin caller sees the 403 verbatim via mutation.error).
// ────────────────────────────────────────────────────────────────────────────

export type CreateTeamInput = {
  name: string;
  managerId?: string | null;
};

export type UpdateTeamInput = Partial<CreateTeamInput>;

export type ReassignTeamMembersInput = {
  targetTeamId: string;
  /** Omit to reassign EVERY current member (the one-click bulk action). */
  userIds?: string[];
};

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTeamInput) =>
      api<TeamListItem>('/teams', { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
    },
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: UpdateTeamInput & { id: string }) =>
      api<TeamListItem>(`/teams/${id}`, { method: 'PATCH', json: input }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      void queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, variables.id] });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      api<{ id: string }>(`/teams/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
    },
  });
}

/**
 * POST /api/teams/:id/reassign-members - move members off a team. Omitting
 * `userIds` reassigns everyone (the one-click bulk action that unblocks
 * delete); passing ids reassigns only those members (the per-member "move
 * to another team" action on the roster page).
 */
export function useReassignTeamMembers(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReassignTeamMembersInput) =>
      api<{ count: number }>(`/teams/${teamId}/reassign-members`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      void queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
      void queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, variables.targetTeamId] });
    },
  });
}
