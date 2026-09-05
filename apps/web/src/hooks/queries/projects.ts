// useProjects - project registry data source + admin-class mutations.
//
// T-ProjectSwitch (2026-09-05): the sidebar switcher and the per-project
// list pages consume the REAL Project table (GET /api/projects). The
// Team-as-registry hack (useTeams) is deleted with this change; the
// backend teams module stays for the users page's future needs.
//
// Honest-state contract (per shadhil-crm-dev skill): an API error renders
// an empty list, never a fake spinner - same as useLeads / useTeams.
//
// Mutations mirror hooks/queries/users.ts: invalidate the registry query
// on success so the switcher reflects the change immediately.

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api } from '@/apis/client';

export type ProjectListItem = {
  id: string;
  slug: string;
  name: string;
  address: string;
  reraNumber: string | null;
  cmdaNumber: string | null;
  createdAt: string;
};

type ProjectListResponse = {
  projects: ProjectListItem[];
  total: number;
};

export type CreateProjectInput = {
  name: string;
  address: string;
  reraNumber?: string;
  cmdaNumber?: string;
};

export type UpdateProjectInput = {
  name?: string;
  address?: string;
  reraNumber?: string | null;
  cmdaNumber?: string | null;
};

export function useProjects() {
  return useQuery<ProjectListItem[]>({
    queryKey: ['projects', 'list'],
    queryFn: async (): Promise<ProjectListItem[]> => {
      try {
        const res = await api<ProjectListResponse>('/projects');
        return Array.isArray(res?.projects) ? res.projects : [];
      } catch {
        // Module not wired / network error - render empty, not a stub.
        return [];
      }
    },
    staleTime: 60_000,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProjectInput) =>
      api<ProjectListItem>('/projects', { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: UpdateProjectInput & { id: string }) =>
      api<ProjectListItem>(`/projects/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      api<{ id: string }>(`/projects/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}

/**
 * The DEFAULT active project: the product-locked primary project
 * (DESIGN.md §317 - v1 gates to Shadhil Metro Heights), falling back to
 * the first registry row. Deterministic even when test-fixture projects
 * pollute a dev DB's createdAt ordering.
 */
export const DEFAULT_PROJECT_SLUG = 'shadhil-metro-heights';

export function pickDefaultProject(
  projects: ProjectListItem[],
): ProjectListItem | null {
  return (
    projects.find((p) => p.slug === DEFAULT_PROJECT_SLUG) ??
    projects[0] ??
    null
  );
}