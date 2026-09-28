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
  // T-AUTOASSIGN (2026-09-17): admin toggle for the auto-assign lead routing.
  autoAssignLeads?: boolean;
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
  // T-AUTOASSIGN (2026-09-17): relative routing weight (higher = more leads).
  weight?: number;
  // T-MAXOPENLEADS (2026-09-28): hard ceiling on open leads before auto-assign
  // stops routing here. null/undefined = no cap.
  maxOpenLeads?: number | null;
};

export type TeamDetail = {
  id: string;
  name: string;
  manager: { id: string; name: string; email: string } | null;
  members: TeamMemberRow[];
  // T-AUTOASSIGN (2026-09-17): routing flag carried through so the edit-team
  // switch reflects reality.
  autoAssignLeads?: boolean;
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
  // T-AUTOASSIGN (2026-09-17): auto-assign new leads to the least-loaded
  // telecaller across project teams. Optional; server defaults false.
  autoAssignLeads?: boolean;
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

// T-AUTOASSIGN (2026-09-17): update a member's auto-assign routing weight.
// ADMIN/OWNER or the team's manager only (service-enforced).
export function updateTeamMemberWeight(args: {
  teamId: string;
  userId: string;
  weight: number;
}): Promise<{ userId: string; teamId: string; weight: number }> {
  return api<{ userId: string; teamId: string; weight: number }>(
    `/teams/${args.teamId}/members/${args.userId}/weight`,
    { method: 'PATCH', json: { weight: args.weight } },
  );
}

// Mutation wrapper so the weight change also invalidates the cached team
// detail. Without this, `useTeam(id)` (staleTime 30s) keeps serving the old
// member weights, so reopening the weight/manage dialog shows a stale value
// until the cache naturally expires. `id` is taken at mutation time (the
// per-open selected team), mirroring the codebase's mutate-time-resource rule.
export function useUpdateTeamMemberWeight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateTeamMemberWeight,
    onSuccess: (_data, { teamId }) => {
      void queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
      // The team list row badges only read autoAssignLeads (unchanged), but
      // invalidating TEAMS_KEY keeps any derived weight surfaces consistent.
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
    },
  });
}

// T-MAXOPENLEADS (2026-09-28): set or clear a member's hard ceiling on open
// leads. `maxOpenLeads: null` clears it (unlimited). Same admin/manager gate as
// the weight update (service-enforced).
export function updateTeamMemberCap(args: {
  teamId: string;
  userId: string;
  maxOpenLeads: number | null;
}): Promise<{ userId: string; teamId: string; maxOpenLeads: number | null }> {
  return api<{ userId: string; teamId: string; maxOpenLeads: number | null }>(
    `/teams/${args.teamId}/members/${args.userId}/cap`,
    { method: 'PATCH', json: { maxOpenLeads: args.maxOpenLeads } },
  );
}

// Same invalidation contract as useUpdateTeamMemberWeight: the cached team
// detail (staleTime 30s) would otherwise keep serving the old ceiling.
export function useUpdateTeamMemberCap() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateTeamMemberCap,
    onSuccess: (_data, { teamId }) => {
      void queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
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
