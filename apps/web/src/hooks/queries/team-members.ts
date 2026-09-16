// Team member removal/reassignment hooks - T-TEAM-AUTHORITATIVE
// (2026-09-13, design doc UI2). Backs TeamMemberRemovalDialog.
//   GET  /api/teams/:teamId/members/:userId/removal-preview
//   POST /api/teams/:teamId/members/:userId/reassign-and-remove

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/apis/client';

export type ReplacementCandidate = {
  userId: string;
  name: string;
  role: string;
  isTeamManager: boolean;
};

export type RemovalPreviewProjectSummary = {
  projectId: string;
  projectName: string;
  ownedCount: number;
  coOwnedCount: number;
};

export type RemovalPreview = {
  teamId: string;
  userId: string;
  ownedCount: number;
  coOwnedCount: number;
  totalAffectedLeads: number;
  projects: RemovalPreviewProjectSummary[];
  ownedStates: string[];
  eligibleReplacements: ReplacementCandidate[];
  previewToken: string;
};

export type ReassignAndRemoveInput = {
  replacementUserId: string | null;
  reason: string;
  previewToken: string;
  requestId: string;
};

export type ReassignAndRemoveResult = {
  batchId: string;
  removedUserId: string;
  teamId: string;
  replacementUserId: string | null;
  transferredLeadCount: number;
};

const REMOVAL_PREVIEW_KEY = (teamId: string, userId: string) =>
  ['teams', teamId, 'members', userId, 'removal-preview'] as const;

/**
 * Removal preview - enabled only while the dialog is open (`enabled`
 * param) so a closed dialog never issues a stale background fetch. The
 * caller reads `error.code` off the thrown `ApiError` to distinguish
 * LAST_TEAM_PARTICIPANT / NO_ELIGIBLE_REPLACEMENT / TOO_MANY_AFFECTED_LEADS
 * from a generic failure.
 */
export function useRemovalPreview(
  teamId: string | undefined,
  userId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: REMOVAL_PREVIEW_KEY(teamId ?? '', userId ?? ''),
    enabled: enabled && teamId !== undefined && userId !== undefined,
    queryFn: ({ signal }) =>
      api<RemovalPreview>(
        `/teams/${teamId as string}/members/${userId as string}/removal-preview`,
        { signal },
      ),
    staleTime: 0,
    retry: false,
  });
}

/**
 * Execute the removal. Invalidates every surface the design doc lists as
 * affected on success: teams (rosters + switcher), project staff
 * (ProjectTeam member counts derive from the same TeamMember rows), users,
 * leads (ownership changed), and dashboards.
 */
export function useReassignAndRemove(teamId: string | undefined, userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReassignAndRemoveInput) =>
      api<ReassignAndRemoveResult>(
        `/teams/${teamId as string}/members/${userId as string}/reassign-and-remove`,
        { method: 'POST', json: input },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['teams'] }),
        queryClient.invalidateQueries({ queryKey: ['projects', 'teams'] }),
        queryClient.invalidateQueries({ queryKey: ['users'] }),
        queryClient.invalidateQueries({ queryKey: ['leads'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

/** Force a fresh removal-preview fetch (STALE_PREVIEW recovery). */
export function removalPreviewQueryKey(teamId: string, userId: string) {
  return REMOVAL_PREVIEW_KEY(teamId, userId);
}
