// Teams module - GET /api/teams (apps/backend/src/teams).
// Returns the teams the actor is a member of; for ADMIN/OWNER that is ALL
// teams (server-scoped). Used by the create-user dialog to link
// TELECALLER/SALES_EXEC staff to a team (the backend rejects staff users
// without a teamId).
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api } from '@/apis/client';

export type TeamListItem = {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  memberCount: number;
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
