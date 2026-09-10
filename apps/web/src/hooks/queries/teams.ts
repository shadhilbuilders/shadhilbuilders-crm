// Teams module - GET /api/teams (apps/backend/src/teams).
// Returns the teams the actor is a member of; for ADMIN/OWNER that is ALL
// teams (server-scoped). Used by the create-user dialog to link
// TELECALLER/SALES_EXEC staff to a team (the backend rejects staff users
// without a teamId). Also powers the ADMIN/OWNER org-Teams pages
// (/teams list + /teams/[teamId] roster).
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api } from '@/apis/client';

export type TeamListItem = {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  memberCount: number;
  managerId: string | null;
  managerName: string | null;
};

export type TeamMemberProject = {
  projectId: string;
  projectName: string;
  role: string;
  /** True when this project came only from lead-ownership (read-only). */
  isLeadOwner: boolean;
};

export type TeamMemberRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
  projects: TeamMemberProject[];
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
