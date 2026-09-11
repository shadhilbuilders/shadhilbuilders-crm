// Feedback triage - React Query hooks (admin page).
//
// Wire shape (per the BFF catch-all that proxies GET/PATCH /api/feedback):
//
//   useFeedback({ status, limit, cursor })
//     → GET /api/feedback
//       returns { total, rows: FeedbackRow[], nextCursor: string | null }
//
//   useUpdateFeedbackStatus()
//     → PATCH /api/feedback/:id  body: { status }
//       returns { row: FeedbackRow }
//       On success invalidates the list query so the page refetches.
//
//   useMarkFeedbackSpam isn't needed - feedback triage is status-only
//   (NEW -> REVIEWED -> ARCHIVED), no delete/spam verb.

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api, qs } from '@/apis/client';

import type {
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackRow,
  FeedbackStatus,
  UpdateFeedbackResult,
} from '@shadhil/api-types';

// ---------------------------------------------------------------------------
// List (GET /api/feedback)
// ---------------------------------------------------------------------------

export function useFeedback(query: Partial<FeedbackListQuery> = {}) {
  return useQuery({
    queryKey: ['feedback', query] as const,
    queryFn: ({ signal }) =>
      api<FeedbackListResult>(
        `/feedback${qs({
          status: query.status,
          limit: query.limit,
          cursor: query.cursor,
        })}`,
        { signal },
      ),
    select: (raw): FeedbackListResult => ({
      total: typeof raw.total === 'number' ? raw.total : 0,
      rows: Array.isArray(raw.rows) ? raw.rows : [],
      nextCursor:
        typeof raw.nextCursor === 'string' && raw.nextCursor.length > 0
          ? raw.nextCursor
          : null,
    }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Status update (PATCH /api/feedback/:id)
// ---------------------------------------------------------------------------

export function useUpdateFeedbackStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: FeedbackStatus }) =>
      api<UpdateFeedbackResult>(`/feedback/${args.id}`, {
        method: 'PATCH',
        json: { status: args.status },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feedback'] });
    },
  });
}

// Type re-export for convenience - pages import from here directly.
export type { FeedbackRow };
