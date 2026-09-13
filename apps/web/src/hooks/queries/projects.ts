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
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api, qs } from '@/apis/client';

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

export type ProjectsFilter = {
  search?: string;
  limit?: number;
  offset?: number;
};

export type ProjectsListResult = {
  projects: ProjectListItem[];
  total: number;
};

/**
 * GET /api/projects?search=&limit=&offset= - server-side search + pagination
 * for the Projects admin table (mirrors useUsers). The sidebar switcher keeps
 * using `useProjects` (full registry, no params); this hook is scoped to the
 * admin page's table.
 */
export function useProjectsTable(filter: ProjectsFilter = {}) {
  return useQuery({
    queryKey: [
      'projects',
      'list',
      filter.search ?? '',
      filter.limit,
      filter.offset,
    ],
    queryFn: ({ signal }) =>
      api<ProjectsListResult>(
        `/projects${qs({
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
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

// ProjectMember (per-user project linking) was RETIRED T-TEAM-AUTHORITATIVE
// (2026-09-13, clean cutover) - see packages/api-types/src/projects.ts.
// Project staffing is exclusively team-based now: see
// hooks/queries/project-teams.ts (useProjectTeams/useLinkProjectTeam/
// useUnlinkProjectTeam) and components/teams/project-team-list.tsx.

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