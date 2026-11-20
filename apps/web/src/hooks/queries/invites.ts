// Invites query hooks (2026-11-20).
//
// Endpoints mirror apps/backend/src/invites/invites.controller.ts:
//   POST   /api/invites              -> CreateInviteResult (link shown ONCE)
//   GET    /api/invites?status=...   -> InviteListResult
//   POST   /api/invites/:id/resend   -> CreateInviteResult
//   POST   /api/invites/:id/revoke   -> InviteRow
//
// WHY THIS DOES NOT TOUCH THE ['users'] KEY. That key backs six pickers
// (lead reassign, co-owner, team members, engineer assignment, new-lead
// assignee, project sales execs). An unaccepted invite changes NONE of them -
// no user exists yet. Invalidating it here would refetch all six for nothing,
// and more importantly would teach the codebase that the invite surface owns
// user state, which it does not (the User row appears on acceptance, which
// happens on a different device entirely).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';
import type {
  CreateInviteDto,
  CreateInviteResult,
  InviteListResult,
  InviteRow,
  InviteStatus,
} from '@shadhil/api-types';

const INVITES_KEY = ['invites'] as const;

export type InvitesFilter = {
  status?: InviteStatus[];
  limit?: number;
  offset?: number;
};

/**
 * GET /api/invites.
 *
 * `status` is part of the KEY, not just the request: the table caches per
 * filter, and serving an unfiltered page to a filtered view would show
 * accepted invites under a Pending tab.
 */
export function useInvites(filter: InvitesFilter = {}) {
  return useQuery({
    queryKey: [...INVITES_KEY, filter.status ?? [], filter.limit, filter.offset],
    queryFn: ({ signal }) =>
      api<InviteListResult>(
        `/invites${qs({
          status: filter.status !== undefined ? filter.status.join(',') : undefined,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * POST /api/invites.
 *
 * The response is the ONLY time the raw link exists - the caller must render
 * it immediately. There is no re-fetch that could recover it; a lost link
 * means Resend (which rotates the token).
 */
export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInviteDto) =>
      api<CreateInviteResult>('/invites', { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}

/**
 * POST /api/invites/:id/resend - rotates the token, returns a fresh link.
 *
 * Same result shape as create, so the UI reuses one "link shown once" panel.
 */
export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<CreateInviteResult>(`/invites/${encodeURIComponent(id)}/resend`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}

/**
 * POST /api/invites/:id/revoke.
 *
 * Idempotent server-side: revoking twice returns the same REVOKED row rather
 * than a 409, so a double-click is harmless.
 */
export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<InviteRow>(`/invites/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}

export { INVITES_KEY };
