// ProjectTeam hooks - T-TEAM-AUTHORITATIVE (2026-09-13). Backs the Staff
// page's grouped team view (GET/POST/DELETE /api/projects/:id/teams).
// Mirrors hooks/queries/projects.ts's ProjectMember hooks shape.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/apis/client';

export type TeamMembership = {
  userId: string;
  teamId: string;
  name: string;
  email: string;
  role: string;
  assignedAt: string;
  isManagerSlot: boolean;
};

export type ProjectTeamRow = {
  teamId: string;
  teamName: string;
  manager: { id: string; name: string } | null;
  memberCount: number;
  leadCount: number;
  members: TeamMembership[];
  canUnlink: boolean;
};

export type ProjectTeamsResponse = {
  projectId: string;
  teams: ProjectTeamRow[];
};

const PROJECT_TEAMS_KEY = (projectId: string) =>
  ['projects', 'teams', projectId] as const;

/** GET /api/projects/:id/teams - linked teams with roster + capabilities. */
export function useProjectTeams(projectId: string | undefined) {
  return useQuery({
    queryKey: PROJECT_TEAMS_KEY(projectId ?? ''),
    enabled: projectId !== undefined && projectId.length > 0,
    queryFn: ({ signal }) =>
      api<ProjectTeamsResponse>(`/projects/${projectId as string}/teams`, {
        signal,
      }),
    staleTime: 30_000,
  });
}

/** POST /api/projects/:id/teams - link a team. ADMIN/OWNER only. */
export function useLinkProjectTeam(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) =>
      api<ProjectTeamRow>(`/projects/${projectId as string}/teams`, {
        method: 'POST',
        json: { teamId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECT_TEAMS_KEY(projectId ?? ''),
      });
    },
  });
}

/**
 * DELETE /api/projects/:id/teams/:teamId - unlink a team. ADMIN/OWNER only.
 * 409 PROJECT_TEAM_HAS_LEADS when any lead still carries this (project,
 * team) pair - the caller reads `error.code` off the thrown `ApiError`.
 */
export function useUnlinkProjectTeam(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) =>
      api<{ ok: true }>(`/projects/${projectId as string}/teams/${teamId}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECT_TEAMS_KEY(projectId ?? ''),
      });
    },
  });
}
