// useTeams - sidebar-07 team switcher data source.
//
// Hits GET /api/bff/teams which proxies to the NestJS teams module.
// Returns the user's teams (RLS-filtered on the server) for the
// sidebar's <TeamSwitcher> dropdown.
//
// Honest-state contract (per shadhil-crm-dev skill): the backend
// teams module might not be wired (e.g. running before the teams
// migration lands). In that case the BFF returns 404/500, this
// hook sees an error, and the consumer renders an empty array -
// not a fake spinner or stub. The same pattern as useLeads /
// useNotifications.

import { useQuery } from '@tanstack/react-query';

import { api } from '@/apis/client';

export type TeamListItem = {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  memberCount: number;
};

export function useTeams() {
  return useQuery<TeamListItem[]>({
    queryKey: ['teams', 'list'],
    queryFn: async (): Promise<TeamListItem[]> => {
      try {
        const res = await api<TeamListItem[]>('/teams');
        return Array.isArray(res) ? res : [];
      } catch {
        // Module not wired / network error - render empty, not a stub.
        return [];
      }
    },
    staleTime: 5 * 60 * 1000, // teams don't change often; cache 5 min
  });
}
