// Leads, visits, chat, bookings, notifications, and audit hooks.
//
// Wire-shape contract (verified 2026-09-04, Pass 1 backend live):
//   - `users` is the only list-returning module that returns a bare
//     array - every other list endpoint returns
//     `{ total: number, rows: T[] }`. Each hook here unwraps `rows` so
//     page consumers can read `.data` as a normal array.
//
// T24 (PR3): every list-shape query has `placeholderData: keepPreviousData`
// so the skeleton only renders on first load, not on refetch (avoids the
// "stale data → skeleton → fresh data" flicker on navigation).
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';

import type {
  BookingTransitionDto,
  ChatConversationsResult,
  // T-WA-WINDOW (2026-09-29): the thread's WhatsApp reply-window state and the
  // welcome-template send payload.
  ChatThreadState,
  CreateBookingDto,
  CreateLeadDto,
  CreateSiteVisitDto,
  LeadActivitiesResponse,
  LeadDetail,
  LeadStateTransitionDto,
  RescheduleVisitDto,
  SendContactMessageDto,
  SendWelcomeMessageDto,
  UpdateBookingDto,
  SendMessageDto,
  UpdateLeadDto,
  UpdateVisitOutcomeDto,
  ReassignLeadDto,
  SetLeadCoOwnerDto,
} from '@shadhil/api-types';

// ---------------------------------------------------------------------------
// Wire-shape helpers (pass-through to the API; pages consume `.data` as the
// row shape, not the wrapper)
// ---------------------------------------------------------------------------

type WithRows<T> = { total: number; rows: T[] };

function unwrapRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray((payload as WithRows<T>).rows)
  ) {
    return (payload as WithRows<T>).rows;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Leads (contracts: packages/api-types/src/leads.ts)
// ---------------------------------------------------------------------------

export type LeadFilterInput = {
  state?: string[];
  ownerId?: string;
  /**
   * Leads the user is LINKED to: owner OR co-owner (T-USER-LEADS,
   * 2026-09-24). Distinct from `ownerId`, which stays strict owner-only.
   * Used by the user-detail page so a co-owner's workload shows on their
   * own profile.
   */
  linkedUserId?: string;
  teamId?: string;
  // T-ProjectSwitch: the active project filter (sidebar switcher).
  projectId?: string;
  search?: string;
  limit?: number;
  offset?: number;
  // Server-side sort (T-SRVPG): the DataTable sorts client-side over the
  // loaded page, which is wrong under server pagination. The page passes
  // the sort column + direction and the service applies it in the SQL
  // ORDER BY.
  sortBy?: 'updatedAt' | 'createdAt' | 'name';
  sortDir?: 'asc' | 'desc';
};

export function useLeads(filter: LeadFilterInput = {}) {
  return useQuery({
    queryKey: ['leads', filter] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/leads${qs({
          state: filter.state?.join(','),
          ownerId: filter.ownerId,
          linkedUserId: filter.linkedUserId,
          teamId: filter.teamId,
          projectId: filter.projectId,
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
          sortBy: filter.sortBy,
          sortDir: filter.sortDir,
        })}`,
        { signal },
      ),
    // T-DashCharts (2026-09-06): backend `leads.service.list` returns
    // `{ total, rows }` (paginated response, app/contracts LeadListResult).
    // The dashboard charts (PipelineFunnelChart) and the leads inbox
    // page both iterate `data` directly, so unwrap here instead of
    // re-shaping in every consumer. Same pattern as useBookings /
    // useNotifications / useAuditLog. Without `select: unwrapRows` the
    // charts threw `TypeError: data is not iterable` and React's
    // error-boundary fallback surfaced the "Hydration failed because
    // the server rendered HTML didn't match the client" log.
    //
    // autoplan 2026-09-07 (D22): the inbox also needs `total` for the
    // "Showing first 100 of N" truncation-honesty line. Keep `data` as
    // the plain rows array (charts + tests depend on it) and expose the
    // raw envelope via `select`-adjacent state: read it from
    // `leadsQueryTotal` below, computed from the same cache entry.
    select: unwrapRows<unknown>,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Read the raw `{ total, rows, overdueCount, newTodayCount }` envelope for
 * the SAME query key the useLeads hook caches under (T-SRVPG, 2026-09-07).
 * Returns null before the first fetch resolves. Separate hook because
 * `select` already projects `data` to rows; two subscribers share one cache
 * entry, so this adds no extra request.
 *
 * The leads inbox needs `total` (pagination + truncation honesty) and the
 * summary counts (`overdueCount` / `newTodayCount`) which the server now
 * computes for the FULL filtered set (not the page) so the summary line
 * stays correct across pages.
 */
export type LeadsEnvelope = {
  total: number;
  overdueCount: number;
  newTodayCount: number;
};

export function useLeadsEnvelope(filter: LeadFilterInput = {}): LeadsEnvelope | null {
  const query = useQuery({
    queryKey: ['leads', filter] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/leads${qs({
          state: filter.state?.join(','),
          ownerId: filter.ownerId,
          linkedUserId: filter.linkedUserId,
          teamId: filter.teamId,
          projectId: filter.projectId,
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
          sortBy: filter.sortBy,
          sortDir: filter.sortDir,
        })}`,
        { signal },
      ),
    // No row projection here - the consumer reads `.data.total` etc.
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const raw = query.data;
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as { total?: unknown; overdueCount?: unknown; newTodayCount?: unknown };
    if (typeof obj.total === 'number') {
      return {
        total: obj.total,
        overdueCount: typeof obj.overdueCount === 'number' ? obj.overdueCount : 0,
        newTodayCount: typeof obj.newTodayCount === 'number' ? obj.newTodayCount : 0,
      };
    }
  }
  return null;
}

/**
 * GET /api/leads/badge?projectId= - count of NEW leads the actor can see
 * in the given project. Powers the sidebar "Leads" badge. A lead leaves
 * NEW the moment anyone works it, so the badge clears as leads get
 * attention. Project-scoped via `projectId`; role-scoped server-side.
 */
export function useNewLeadsBadge(projectId: string | null) {
  return useQuery({
    queryKey: ['leads', 'badge', projectId] as const,
    enabled: projectId !== null && projectId.length > 0,
    queryFn: ({ signal }) =>
      api<{ newLeads: number }>(`/leads/badge${qs({ projectId })}`, { signal }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['leads', id] as const,
    enabled: id !== null && id.length > 0,
    queryFn: ({ signal }) => api<LeadDetail>(`/leads/${id as string}`, { signal }),
  });
}

/**
 * Lead timeline, cursor-paged BACKWARDS in time: page 0 is the newest slice and
 * `fetchNextPage` loads the next-older one. Still under the `['leads']` prefix,
 * so every lead mutation's invalidation refreshes it.
 */
export function useLeadActivities(id: string | null) {
  return useInfiniteQuery({
    queryKey: ['leads', id, 'activities'] as const,
    enabled: id !== null && id.length > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      api<LeadActivitiesResponse>(
        `/leads/${id as string}/activities${qs({ cursor: pageParam })}`,
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Create a new lead. Invalidates the leads-list query cache on success so the
 * inbox shows the new lead without a manual refresh. The form's success
 * handler should `router.push(\`/${projectId}/leads/${data.id}\`)` for the
 * optimistic flow (T-ProjectSwitch: work surfaces live under the active
 * project's URL segment).
 *
 * Note: owner is assigned server-side by the ManagerAssignmentRule engine
 * (IMPLEMENTATION-PLAN §7). The form does NOT pick the owner.
 */
export function useCreateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLeadDto) =>
      api<unknown>('/leads', { method: 'POST', json: body }),
    onSuccess: () => {
      invalidateLeadCaches(queryClient);
    },
  });
}

/**
 * Partial update - name and email only (per LeadUpdateDto contract;
 * state transitions and ownership go through dedicated endpoints).
 */
export function useUpdateLead(leadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLeadDto) => {
      if (leadId === null) {
        return Promise.reject(new Error('Lead id required'));
      }
      return api<unknown>(`/leads/${leadId}`, {
        method: 'PATCH',
        json: body,
      });
    },
    onSuccess: () => {
      invalidateLeadCaches(queryClient, leadId ?? undefined);
    },
  });
}

/**
 * Drive the lead state machine (Model C - DECISION-CHANGELOG §3).
 * Server enforces role + transition guards; UI shows all TRANSITIONS
 * for the current state (server may reject with 403 ROLE_FORBIDDEN).
 */
export function useTransitionLead(leadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LeadStateTransitionDto) => {
      if (leadId === null) {
        return Promise.reject(new Error('Lead id required'));
      }
      return api<unknown>(`/leads/${leadId}/transition`, {
        method: 'POST',
        json: body,
      });
    },
    onSuccess: () => {
      invalidateLeadCaches(queryClient, leadId ?? undefined);
      if (leadId !== null) {
        void queryClient.invalidateQueries({
          queryKey: ['lead', leadId, 'activities'],
        });
      }
    },
  });
}

/**
 * Hard delete a lead (autoplan 2026-09-07, D14/D18). Server allows
 * OWNER/ADMIN only - the UI must hide the action for every other role
 * (defense in depth: a hidden-but-allowed action is still a 403).
 *
 * Cache semantics (D18): the list invalidates (refetch) but the DETAIL
 * cache is REMOVED, not invalidated - invalidate would refetch a deleted
 * row into ['lead', id] and render a 404-shaped error page if the user
 * later follows a stale link. removeQueries drops it entirely.
 */
export function useDeleteLead(leadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (leadId === null) {
        return Promise.reject(new Error('Lead id required'));
      }
      return api<{ id: string }>(`/leads/${leadId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      invalidateLeadCaches(queryClient, leadId ?? undefined);
      if (leadId !== null) {
        // Detail cache is REMOVED (not invalidated) so a stale link cannot
        // refetch a deleted row into ['lead', id] and render a 404 page.
        void queryClient.removeQueries({ queryKey: ['lead', leadId] });
      }
    },
  });
}

/**
 * Manually reassign a lead to another staff member. Server enforces role +
 * team + state-lane guards inside one withRlsContext transaction:
 *   - MANAGER can reassign leads in their own team to a teammate.
 *   - ADMIN/OWNER can reassign to any user (cross-team).
 * ReassignLeadDto = { leadId, targetUserId, reason } - the reason is
 * mandatory (audit + manager visibility).
 *
 * Cache semantics: invalidate the lead list (owner changed → the inbox
 * re-slices by owner) and the detail row (ownerName updated).
 */
export function useReassignLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ReassignLeadDto) =>
      api<{ id: string; ownerId: string; ownerName: string | null }>(
        `/leads/${body.leadId}/reassign`,
        { method: 'POST', json: body },
      ),
    onSuccess: (row) => {
      invalidateLeadCaches(queryClient, row?.id);
      if (row?.id) {
        void queryClient.invalidateQueries({
          queryKey: ['lead', row.id, 'activities'],
        });
      }
    },
  });
}

/**
 * Set or clear a lead's co-owner. Server enforces the same role + team
 * guards as reassign (MANAGER same-team / ADMIN-OWNER any), inside one
 * withRlsContext transaction + audit row. SetLeadCoOwnerDto =
 * { leadId, coOwnerId (nullable = clear), reason (mandatory) }.
 *
 * Cache: invalidate the detail row (coOwnerName shown on the detail page).
 */
export function useSetLeadCoOwner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetLeadCoOwnerDto) =>
      api<{ id: string; ownerId: string; ownerName: string | null }>(
        `/leads/${body.leadId}/co-owner`,
        { method: 'PATCH', json: body },
      ),
    onSuccess: (row) => {
      // useLead/useLeadActivities read keys as `['leads', id]` (plural).
      // Invalidate the broad `['leads']` prefix (matches the detail +
      // inbox list) and the specific detail/activities keys so the new
      // co-owner appears immediately without a refresh. Also bust the
      // dashboard KPIs - ownership changes reshuffle overdue lanes.
      invalidateLeadCaches(queryClient, row?.id);
      if (row?.id) {
        void queryClient.invalidateQueries({ queryKey: ['leads', row.id] });
        void queryClient.invalidateQueries({
          queryKey: ['leads', row.id, 'activities'],
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Visits (contract: packages/api-types/src/visits.ts)
// ---------------------------------------------------------------------------

export function useVisits(
  params: {
    from?: string;
    to?: string;
    projectId?: string;
    leadId?: string;
    limit?: number;
  } = {},
) {
  return useQuery({
    queryKey: ['visits', params] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/visits${qs({
          from: params.from,
          to: params.to,
          projectId: params.projectId,
          leadId: params.leadId,
          limit: params.limit,
        })}`,
        { signal },
      ),
    // T-DashCharts (2026-09-06): backend `visits.service.list` returns
    // `{ total, rows }` (VisitListResult). Dashboard VisitsThisWeekChart
    // iterates `data` directly; the /visits page also expects an array.
    // Unwrap here so all consumers see the same shape - same pattern as
    // useLeads / useBookings / useNotifications.
    select: unwrapRows<unknown>,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

const VISIT_PAGE_SIZE = 200; // VisitFilterDtoSchema max

/**
 * Every visit inside [from, to], paged to completion.
 *
 * The API caps one page at 200 rows, so a single call silently truncates a busy
 * range. This follows `total` until all rows are loaded. Same ['visits'] key
 * prefix as useVisits, so create/reschedule invalidations refetch it.
 */
export function useVisitsInRange(params: { from: string; to: string; projectId?: string }) {
  return useQuery({
    queryKey: ['visits', 'range', params] as const,
    queryFn: async ({ signal }) => {
      const all: unknown[] = [];
      for (let offset = 0; ; offset += VISIT_PAGE_SIZE) {
        const payload = await api<unknown>(
          `/visits${qs({
            from: params.from,
            to: params.to,
            projectId: params.projectId,
            limit: VISIT_PAGE_SIZE,
            offset,
          })}`,
          { signal },
        );
        const rows = unwrapRows<unknown>(payload);
        all.push(...rows);
        const total = (payload as { total?: number } | null)?.total;
        if (rows.length < VISIT_PAGE_SIZE || (typeof total === 'number' && all.length >= total)) {
          return all;
        }
      }
    },
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Schedule a new site visit. Invalidates ['visits'] + the parent
 * lead's caches on success - the parent lead auto-advances from
 * VISIT_REQUESTED → VISIT_SCHEDULED on the server, so the lead
 * inbox needs a fresh fetch.
 */
export function useCreateVisit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSiteVisitDto) =>
      api<unknown>('/visits', { method: 'POST', json: body }),
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['visits'] });
      const leadId =
        typeof (data as { leadId?: string } | undefined)?.leadId === 'string'
          ? (data as { leadId: string }).leadId
          : variables.leadId;
      invalidateLeadCaches(
        queryClient,
        typeof leadId === 'string' ? leadId : undefined,
      );
    },
  });
}

/**
 * Record visit outcome (COMPLETED, NO_SHOW, CANCELLED). On COMPLETED
 * the parent lead auto-advances to VISITED via the server-side lead
 * state machine.
 */
export function useUpdateVisitOutcome(visitId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateVisitOutcomeDto) => {
      if (visitId === null) {
        return Promise.reject(new Error('Visit id required'));
      }
      return api<unknown>(`/visits/${visitId}/outcome`, {
        method: 'PATCH',
        json: body,
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['visits'] });
      const leadId =
        typeof (data as { leadId?: string } | undefined)?.leadId === 'string'
          ? (data as { leadId: string }).leadId
          : undefined;
      invalidateLeadCaches(queryClient, leadId);
    },
  });
}

/**
 * The wire fields the visit mutations return that this module needs.
 * `useCreateVisit`/`useRescheduleVisit`/`useUpdateVisitOutcome` are typed
 * `unknown` (they serve several endpoints), so the note is read defensively.
 */
export function leadSyncNoteOf(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const note = (data as { leadSyncNote?: unknown }).leadSyncNote;
  return typeof note === 'string' && note.length > 0 ? note : null;
}

/**
 * Reschedule a site visit (drag-and-drop on the calendar). PATCH
 * /api/visits/:id/reschedule - the old visit is marked RESCHEDULED and a
 * new row carries `rescheduledFromId`. The server enforces `scheduledFor`
 * must be in the future.
 */
export function useRescheduleVisit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RescheduleVisitDto) =>
      api<unknown>(`/visits/${body.visitId}/reschedule`, {
        method: 'PATCH',
        json: body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['visits'] });
      invalidateLeadCaches(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// Chat (contract: packages/api-types/src/chat.ts)
// ---------------------------------------------------------------------------

export function useMessages(leadId: string | null, kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER') {
  return useQuery({
    queryKey: ['chat', leadId, kind] as const,
    enabled: leadId !== null && leadId.length > 0,
    queryFn: ({ signal }) =>
      api<unknown[]>(`/chat/${leadId as string}?kind=${kind}`, { signal }),
  });
}

// T-E2 (Week 6): live chat updates via the SSE channel instead of
// send-triggered refetch only. Mount inside the lead detail page; the
// subscription invalidates the chat query whenever a new Message row
// appears (inbound WhatsApp, another staff member, or the customer).
/**
 * T-WA-WINDOW (2026-09-29): a lead thread's WhatsApp reply-window state.
 *
 * The composer cannot infer "can I type?" from local state: Meta opens the 24h
 * window on the CUSTOMER's inbound, so the answer depends on their last message,
 * which only the server knows. `enabled` on a null id keeps the two-pane
 * pattern (hooks are never called conditionally).
 *
 * Polls on an interval because this state EXPIRES on its own - a window that was
 * open when the page loaded closes 24h later with no user action, and a stale
 * "you can reply" would be the exact silent-failure the gate exists to prevent.
 */
export function useChatThreadState(leadId: string | null) {
  return useQuery({
    queryKey: ['chat-state', leadId] as const,
    enabled: leadId !== null && leadId.length > 0,
    queryFn: ({ signal }) =>
      api<ChatThreadState>(`/chat/${leadId as string}/state`, { signal }),
    refetchInterval: 60_000,
  });
}

/**
 * T-WA-WINDOW: send the approved welcome template to a lead.
 *
 * Invalidates the thread state too - the send updates `lastTemplateSentAt`, which
 * is what swaps the welcome button for "waiting for their reply".
 */
export function useSendWelcomeMessage(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: true; templateName: string }>('/chat/welcome', {
        method: 'POST',
        json: { leadId } satisfies SendWelcomeMessageDto,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-state', leadId] });
    },
  });
}

export function useMessagesRealtime(leadId: string | null, kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER'): void {
  const queryClient = useQueryClient();
  useRealtimeChannel(leadId !== null && leadId.length > 0 ? `chat:${leadId}` : null, () => {
    void queryClient.invalidateQueries({ queryKey: ['chat', leadId, kind] });
  });
}

// ---------------------------------------------------------------------------
// Media upload (MEDIA 2026-09-17): staff attaches a file in the chat composer.
// The browser reads the File → base64 → POST /api/media → receives a storage
// key. That key + mime + filename are then sent with the chat message.
// ---------------------------------------------------------------------------

/** Base64-encode a File for the JSON upload body (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // Strip the `data:<mime>;base64,` prefix.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** POST /api/media to upload a chat attachment; returns the storage key. */
export async function uploadChatMedia(
  file: File,
): Promise<{ mediaKey: string; mediaMimeType: string; mediaFilename: string }> {
  const base64 = await fileToBase64(file);
  const res = await api<{ key: string }>('/media', {
    method: 'POST',
    json: { filename: file.name, mimeType: file.type || 'application/octet-stream', base64 },
  });
  return {
    mediaKey: res.key,
    mediaMimeType: file.type || 'application/octet-stream',
    mediaFilename: file.name,
  };
}

export function useSendMessage(leadId: string, kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER') {
  const queryClient = useQueryClient();
  return useMutation({
    // MEDIA (2026-09-17): staff can attach a file. The browser uploads the
    // file via POST /api/media (returns mediaKey) then sends mediaKey +
    // mediaMimeType + mediaFilename here so the backend persists the Message
    // row with a mediaUrl and enqueues a WhatsApp media outbound.
    mutationFn: (input: {
      body: string;
      media?: { mediaKey: string; mediaMimeType: string; mediaFilename: string };
      /** T-MENTION-TARGET (2026-09-29): addressed recipients, as picked from the
       *  @ menu. Their ids, not their names - the server no longer name-matches. */
      mentionedUserIds?: string[];
    }) =>
      api<unknown>('/chat/send', {
        method: 'POST',
        json: {
          leadId,
          body: input.body,
          channel: 'IN_APP',
          kind,
          ...(input.mentionedUserIds !== undefined
            ? { mentionedUserIds: input.mentionedUserIds }
            : {}),
          ...(input.media !== undefined
            ? {
                mediaKey: input.media.mediaKey,
                mediaMimeType: input.media.mediaMimeType,
                mediaFilename: input.media.mediaFilename,
              }
            : {}),
        } satisfies SendMessageDto,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', leadId, kind] });
    },
  });
}

// ---------------------------------------------------------------------------
// WhatsApp inbox (T-WA-INBOX, 2026-09-25)
//
// The two-pane chat system: a conversation list on the left (leads + unknown
// contacts) and the chat panel on the right. Distinct from the per-lead chat
// hooks above, which stay as they are for the lead detail page.
// ---------------------------------------------------------------------------

export type ChatConversationFilter = {
  search?: string;
  kind?: 'LEAD' | 'CONTACT';
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
};

/** GET /api/chat/conversations - the inbox list (server-filtered). */
export function useChatConversations(filter: ChatConversationFilter = {}) {
  return useQuery({
    queryKey: ['chat-conversations', filter] as const,
    queryFn: ({ signal }) =>
      api<ChatConversationsResult>(
        `/chat/conversations${qs({
          search: filter.search,
          kind: filter.kind,
          unreadOnly: filter.unreadOnly === true ? 'true' : undefined,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    // Inbox freshness matters (a customer reply must appear without a manual
    // refresh); SSE invalidates this key, and a short poll is the backstop.
    refetchOnWindowFocus: true,
  });
}

/** GET /api/chat/contact/:id - messages on an unknown-contact thread. */
export function useContactMessages(contactId: string | null) {
  return useQuery({
    queryKey: ['chat-contact', contactId] as const,
    enabled: contactId !== null && contactId.length > 0,
    queryFn: ({ signal }) =>
      api<unknown[]>(`/chat/contact/${contactId as string}`, { signal }),
  });
}

/** SSE: invalidate the open contact thread + the list when a message lands. */
export function useContactMessagesRealtime(contactId: string | null): void {
  const queryClient = useQueryClient();
  useRealtimeChannel(
    contactId !== null && contactId.length > 0 ? `chat:${contactId}` : null,
    () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-contact', contactId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
    },
  );
}

/** POST /api/chat/send-to-contact - reply on an unknown-contact thread. */
export function useSendContactMessage(contactId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      body: string;
      media?: { mediaKey: string; mediaMimeType: string; mediaFilename: string };
    }) =>
      api<unknown>('/chat/send-to-contact', {
        method: 'POST',
        json: {
          contactId,
          body: input.body,
          ...(input.media !== undefined
            ? {
                mediaKey: input.media.mediaKey,
                mediaMimeType: input.media.mediaMimeType,
                mediaFilename: input.media.mediaFilename,
              }
            : {}),
        } satisfies SendContactMessageDto,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-contact', contactId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
    },
  });
}

/** POST /api/chat/read - clear THIS user's unread badge for a thread. */
export function useMarkChatRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (thread: { leadId?: string; contactId?: string }) =>
      api<{ ok: true }>('/chat/read', { method: 'POST', json: thread }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Bookings (contract: packages/api-types/src/bookings.ts)
//
// The bookings controller returns `{ total, rows }` (BookingListResult
// - verified 2026-09-04, T-BOOK). `useBookings` unwraps so the page
// reads `.data` as the row array.
// ---------------------------------------------------------------------------

export type BookingFilterInput = {
  status?: string[];
  projectId?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export function useBookings(filter: BookingFilterInput = {}) {
  return useQuery({
    queryKey: ['bookings', filter] as const,
    queryFn: ({ signal }) =>
      api<WithRows<unknown>>(
        `/bookings${qs({
          status: filter.status?.join(','),
          projectId: filter.projectId,
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    select: unwrapRows<unknown>,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/** Read the raw `{ total, rows }` envelope for the SAME key useBookings
 *  caches under (server pagination needs `total`). */
export function useBookingsEnvelope(filter: BookingFilterInput = {}): number {
  const query = useQuery({
    queryKey: ['bookings', filter] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/bookings${qs({
          status: filter.status?.join(','),
          projectId: filter.projectId,
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const raw = query.data;
  if (raw !== null && typeof raw === 'object') {
    const total = (raw as { total?: unknown }).total;
    if (typeof total === 'number') return total;
  }
  return 0;
}

/** Single booking (approval page). Role-scoped; 404s when the actor can't see it. */
export function useBooking(id: string | null) {
  return useQuery({
    queryKey: ['bookings', id] as const,
    enabled: id !== null && id.length > 0,
    queryFn: ({ signal }) => api<unknown>(`/bookings/${id as string}`, { signal }),
  });
}

/** Booking status changes move Unit.status (T-INV-SYNC: a DB trigger recomputes
 *  it), so ANY booking write must also refresh the inventory caches. Without
 *  this the two pages disagree for up to the cache staleTime after a change. */
function invalidateBookingAndInventory(queryClient: QueryClient, bookingId?: string) {
  void queryClient.invalidateQueries({ queryKey: ['bookings'] });
  if (bookingId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: ['bookings', bookingId] });
  }
  void queryClient.invalidateQueries({ queryKey: ['inventory', 'units'] });
}

/**
 * Drop every surface that reads lead state or the derived KPI numbers.
 *
 * The work-dashboard KPI strip (`dashboard-stats`) and the admin problem
 * inbox (`dashboard-exceptions`) are NOT the same cache as `['leads']`.
 * Without busting them here, a queue mutation (create / transition /
 * reassign / delete / visit outcome / booking) refreshes the table while
 * "N overdue" / "new today" lag for up to their staleTime - the exact
 * mismatch operators notice when they clear a lead and the count stays.
 *
 * Exported so visit-replay / team-member / WhatsApp convert paths can
 * call the same helper instead of inventing a partial invalidation.
 *
 * T-BOOK-LEADSYNC: a booking write also moves `Lead.state` server-side
 * (HOLD → NEGOTIATION, TOKEN → BOOKING_INITIATED, APPROVED → WON, and a
 * cancel/reject or delete releases it back to NEGOTIATION). `leadId` is
 * optional because some callers only know the booking id; the `['leads']`
 * list is invalidated regardless.
 */
export function invalidateLeadCaches(queryClient: QueryClient, leadId?: string) {
  void queryClient.invalidateQueries({ queryKey: ['leads'] });
  if (typeof leadId === 'string' && leadId.length > 0) {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
  }
  void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
  void queryClient.invalidateQueries({ queryKey: ['dashboard-exceptions'] });
}

/** Every booking write: bookings + inventory + the parent lead's caches.
 *  Exported for the invalidation test - this repo has no
 *  @testing-library/react, so the wiring is asserted against a real
 *  QueryClient rather than a rendered hook. */
export function invalidateBookingSideEffects(
  queryClient: QueryClient,
  bookingId?: string,
  leadId?: string,
) {
  invalidateBookingAndInventory(queryClient, bookingId);
  invalidateLeadCaches(queryClient, leadId);
}

/**
 * Create a new booking in HOLD state. Invalidates the bookings list, the
 * inventory grid (the unit moves to HOLD), and the parent lead's caches.
 */
export function useCreateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBookingDto) =>
      api<unknown>('/bookings', { method: 'POST', json: body }),
    onSuccess: (data, variables) => {
      const leadId =
        typeof (data as { leadId?: string } | undefined)?.leadId === 'string'
          ? (data as { leadId: string }).leadId
          : variables.leadId;
      invalidateBookingSideEffects(queryClient, undefined, leadId);
    },
  });
}

/**
 * Advance booking state (HOLD → TOKEN → APPROVED, etc.). Manager-only
 * approval. Invalidates the bookings list, the inventory grid, and the parent
 * lead (its state moves with the booking).
 */
export function useUpdateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: BookingTransitionDto }) =>
      api<unknown>(`/bookings/${args.id}`, {
        method: 'PATCH',
        json: args.body,
      }),
    onSuccess: (data, args) => {
      // The response is the updated BookingRow and carries leadId, so the
      // single-lead cache is refreshed too, not just the list.
      const leadId = (data as { leadId?: string } | undefined)?.leadId;
      invalidateBookingSideEffects(queryClient, args.id, leadId);
    },
  });
}

/** Edit the editable booking fields (amount / tokenAmount / notes). */
export function useEditBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: UpdateBookingDto }) =>
      api<unknown>(`/bookings/${args.id}`, {
        method: 'PUT',
        json: args.body,
      }),
    onSuccess: (data, args) => {
      const leadId = (data as { leadId?: string } | undefined)?.leadId;
      invalidateBookingSideEffects(queryClient, args.id, leadId);
    },
  });
}

/**
 * Delete a booking. ADMIN/OWNER only (backend enforces). Frees the unit AND
 * releases the parent lead back to NEGOTIATION (T-BOOK-LEADSYNC), so the lead
 * caches must go too. The row is gone after this call, so the lead id cannot be
 * read from the response - the `['leads']` list invalidation covers the grids
 * and the board; a stale single-lead detail cache is refetched on next open.
 */
export function useDeleteBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string }>(`/bookings/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateBookingSideEffects(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// Notifications (contract: packages/api-types/src/notifications.ts)
//
// Controller returns `{ total, unread, rows }` (NotificationListResult).
// We surface `total` + `rows` so the page renders the list and the
// "Mark all as read" handler can show how many were updated.
// ---------------------------------------------------------------------------

export type NotificationsListResult = {
  rows: unknown[];
  total: number;
  unread: number;
};

export function useNotifications(
  params: { unreadOnly?: boolean; projectId?: string; typePrefix?: string } = {},
) {
  return useQuery({
    queryKey: ['notifications', params] as const,
    queryFn: ({ signal }) =>
      api<WithRows<unknown> & { unread?: number }>(
        `/notifications${qs({
          unreadOnly: params.unreadOnly,
          projectId: params.projectId,
          typePrefix: params.typePrefix,
        })}`,
        { signal },
      ),
    select: (raw): NotificationsListResult => ({
      rows: unwrapRows<unknown>(raw),
      total:
        raw !== null && typeof raw === 'object' && typeof (raw as { total?: unknown }).total === 'number'
          ? ((raw as { total: number }).total)
          : 0,
      unread:
        raw !== null && typeof raw === 'object' && typeof (raw as { unread?: unknown }).unread === 'number'
          ? ((raw as { unread: number }).unread)
          : 0,
    }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

// T-E2 (Week 6): the notifications list is kept fresh by the SSE
// realtime channel instead of 60s polling. The subscription lives in
// useNotificationsRealtime() below so hooks stay pure queries.
export function useNotificationsRealtime(): void {
  const queryClient = useQueryClient();
  useRealtimeChannel('notifications', () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationIds: string[]) =>
      api<unknown>('/notifications/mark-read', {
        method: 'PATCH',
        json: { notificationIds },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Audit log (contract: packages/api-types/src/audit.ts)
//
// Controller returns `{ total, rows }` (AuditListResult). Page renders
// the rows; `total` is available if the page later wants to add
// pagination.
// ---------------------------------------------------------------------------

export type AuditListResult = {
  rows: unknown[];
  total: number;
};

export function useAuditLog(
  params: {
    action?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  return useQuery({
    queryKey: ['audit', params] as const,
    queryFn: ({ signal }) =>
      api<WithRows<unknown>>(
        `/audit${qs({
          action: params.action,
          from: params.from,
          to: params.to,
          limit: params.limit,
          offset: params.offset,
        })}`,
        { signal },
      ),
    select: (raw): AuditListResult => ({
      rows: unwrapRows<unknown>(raw),
      total:
        raw !== null && typeof raw === 'object' && typeof (raw as { total?: unknown }).total === 'number'
          ? ((raw as { total: number }).total)
          : 0,
    }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// T-E2 (Week 6): the audit log gains live updates via the SSE channel.
// The initial fetch still happens on page load; new audit rows (from
// lead transitions, booking changes, logins) stream in and invalidate
// the list without a manual refresh.
export function useAuditLogRealtime(enabled: boolean = true): void {
  const queryClient = useQueryClient();
  useRealtimeChannel(enabled ? 'audit' : null, () => {
    void queryClient.invalidateQueries({ queryKey: ['audit'] });
  });
}