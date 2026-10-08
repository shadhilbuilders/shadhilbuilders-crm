// Organization settings hooks (T-VISIT-REMINDER). GET/PATCH /organizations/settings
// via the BFF; PATCH is ADMIN/OWNER only (the server enforces it).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationSettings, UpdateOrganizationSettings } from '@shadhil/api-types';

import { api } from '@/apis/client';

const KEY = ['organization', 'settings'] as const;

export function useOrgSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<OrganizationSettings>('/organizations/settings', { signal }),
    staleTime: 30_000,
  });
}

export function useUpdateOrgSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationSettings) =>
      api<OrganizationSettings>('/organizations/settings', { method: 'PATCH', json: input }),
    onSuccess: (data) => {
      queryClient.setQueryData(KEY, data);
    },
  });
}
