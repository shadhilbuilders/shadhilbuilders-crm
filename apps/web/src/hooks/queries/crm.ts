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
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';

import type {
  BookingTransitionDto,
  CreateBookingDto,
  CreateLeadDto,
  CreateSiteVisitDto,
  LeadActivity,
  LeadDetail,
  LeadStateTransitionDto,
  RescheduleVisitDto,
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

export function useLeadActivities(id: string | null) {
  return useQuery({
    queryKey: ['leads', id, 'activities'] as const,
    enabled: id !== null && id.length > 0,
    queryFn: ({ signal }) => api<LeadActivity[]>(`/leads/${id as string}/activities`, { signal }),
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
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
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
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      if (leadId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      }
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
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      if (leadId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
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
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      if (leadId !== null) {
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
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      if (row?.id) {
        void queryClient.invalidateQueries({ queryKey: ['lead', row.id] });
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
      // co-owner appears immediately without a refresh.
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
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
  params: { from?: string; to?: string; projectId?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: ['visits', params] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/visits${qs({
          from: params.from,
          to: params.to,
          projectId: params.projectId,
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
      if (typeof leadId === 'string') {
        void queryClient.invalidateQueries({ queryKey: ['leads'] });
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      }
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
          : null;
      if (leadId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['leads'] });
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      }
    },
  });
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
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
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
export function useMessagesRealtime(leadId: string | null, kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER'): void {
  const queryClient = useQueryClient();
  useRealtimeChannel(leadId !== null && leadId.length > 0 ? `chat:${leadId}` : null, () => {
    void queryClient.invalidateQueries({ queryKey: ['chat', leadId, kind] });
  });
}

export function useSendMessage(leadId: string, kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<unknown>('/chat/send', {
        method: 'POST',
        json: { leadId, body, channel: 'IN_APP', kind } satisfies SendMessageDto,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', leadId, kind] });
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

/**
 * Create a new booking in HOLD state. Invalidates the bookings list and
 * the parent lead's caches on success.
 */
export function useCreateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBookingDto) =>
      api<unknown>('/bookings', { method: 'POST', json: body }),
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      const leadId =
        typeof (data as { leadId?: string } | undefined)?.leadId === 'string'
          ? (data as { leadId: string }).leadId
          : variables.leadId;
      if (typeof leadId === 'string') {
        void queryClient.invalidateQueries({ queryKey: ['leads'] });
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      }
    },
  });
}

/**
 * Advance booking state (HOLD → TOKEN → APPROVED, etc.). Manager-only
 * approval. Invalidates the bookings list on success.
 */
export function useUpdateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: BookingTransitionDto }) =>
      api<unknown>(`/bookings/${args.id}`, {
        method: 'PATCH',
        json: args.body,
      }),
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['bookings', args.id] });
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
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['bookings', args.id] });
    },
  });
}

/** Delete a booking. ADMIN/OWNER only (backend enforces). */
export function useDeleteBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string }>(`/bookings/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
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