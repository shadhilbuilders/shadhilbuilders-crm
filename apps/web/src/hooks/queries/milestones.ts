// Project milestone hooks (portal redesign, 2026-11-09):
//   GET /api/milestones/:projectId   PUT /api/milestones/:projectId (ADMIN/OWNER)
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProjectMilestoneRow, ReplaceMilestonesDto } from '@shadhil/api-types';

import { api } from '@/apis/client';

const key = (projectId: string) => ['milestones', projectId] as const;

export function useProjectMilestones(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId ?? ''),
    enabled: projectId !== null,
    queryFn: ({ signal }) =>
      api<ProjectMilestoneRow[]>(`/milestones/${projectId as string}`, { signal }),
    staleTime: 30_000,
  });
}

export function useReplaceMilestones(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ReplaceMilestonesDto) =>
      api<ProjectMilestoneRow[]>(`/milestones/${projectId}`, { method: 'PUT', json: body }),
    onSuccess: (rows) => {
      queryClient.setQueryData(key(projectId), rows);
      // The buyer's `me` payload carries milestones; staff previews must not go stale.
      void queryClient.invalidateQueries({ queryKey: ['customer-portal', 'me'] });
    },
  });
}
