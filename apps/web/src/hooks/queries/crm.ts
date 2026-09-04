// Leads, visits, chat, bookings, notifications, and audit hooks.
//
// IMPORTANT (honest-state contract): the leads/visits/chat/bookings/
// notifications/audit modules on the backend are SCAFFOLDED but not yet
// implemented (only `users` is live as of Aug 31, 2026). These hooks call
// the exact endpoint contracts defined in packages/api-types/src/*.ts so
// they light up automatically when the controllers land. Until then pages
// render their typed error/empty states — never fake data.
//
// T24 (PR3): every list-shape query has `placeholderData: keepPreviousData`
// so the skeleton only renders on first load, not on refetch (avoids the
// "stale data → skeleton → fresh data" flicker on navigation).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';

import type {
  CreateLeadDto,
  CreateSiteVisitDto,
  LeadStateTransitionDto,
  UpdateLeadDto,
  UpdateVisitOutcomeDto,
} from '@shadhil/api-types';

// ---------------------------------------------------------------------------
// Leads (contracts: packages/api-types/src/leads.ts)
// ---------------------------------------------------------------------------

export type LeadFilterInput = {
  state?: string[];
  ownerId?: string;
  teamId?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export function useLeads(filter: LeadFilterInput = {}) {
  return useQuery({
    queryKey: ['leads', filter] as const,
    queryFn: ({ signal }) =>
      api<unknown[]>(
        `/leads${qs({
          state: filter.state?.join(','),
          ownerId: filter.ownerId,
          teamId: filter.teamId,
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['leads', id] as const,
    enabled: id !== null && id.length > 0,
    queryFn: ({ signal }) => api<unknown>(`/leads/${id as string}`, { signal }),
  });
}

export function useLeadActivities(id: string | null) {
  return useQuery({
    queryKey: ['leads', id, 'activities'] as const,
    enabled: id !== null && id.length > 0,
    queryFn: ({ signal }) => api<unknown[]>(`/leads/${id as string}/activities`, { signal }),
  });
}

/**
 * Create a new lead. Invalidates the leads-list query cache on success so the
 * inbox shows the new lead without a manual refresh. The form's success
 * handler should `router.push('/leads/${data.id}')` for the optimistic flow.
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
 * Partial update — name and email only (per LeadUpdateDto contract;
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
 * Drive the lead state machine (Model C — DECISION-CHANGELOG §3).
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

// ---------------------------------------------------------------------------
// Visits (contract: packages/api-types/src/visits.ts)
// ---------------------------------------------------------------------------

export function useVisits(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['visits', params] as const,
    queryFn: ({ signal }) =>
      api<unknown[]>(`/visits${qs({ from: params.from, to: params.to })}`, { signal }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Schedule a new site visit. Invalidates ['visits'] + the parent
 * lead's caches on success — the parent lead auto-advances from
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

// ---------------------------------------------------------------------------
// Chat (contract: packages/api-types/src/chat.ts)
// ---------------------------------------------------------------------------

export function useMessages(leadId: string | null) {
  return useQuery({
    queryKey: ['chat', leadId] as const,
    enabled: leadId !== null && leadId.length > 0,
    queryFn: ({ signal }) => api<unknown[]>(`/chat/${leadId as string}`, { signal }),
  });
}

export function useSendMessage(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<unknown>('/chat/send', {
        method: 'POST',
        json: { leadId, body, channel: 'IN_APP' },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', leadId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Bookings (contract: packages/api-types/src/bookings.ts)
// ---------------------------------------------------------------------------

export function useBookings(params: { status?: string } = {}) {
  return useQuery({
    queryKey: ['bookings', params] as const,
    queryFn: ({ signal }) => api<unknown[]>(`/bookings${qs({ status: params.status })}`, { signal }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Notifications (contract: packages/api-types/src/notifications.ts)
// ---------------------------------------------------------------------------

export function useNotifications(params: { unreadOnly?: boolean } = {}) {
  return useQuery({
    queryKey: ['notifications', params] as const,
    queryFn: ({ signal }) =>
      api<unknown[]>(`/notifications${qs({ unreadOnly: params.unreadOnly })}`, { signal }),
    staleTime: 10_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
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
// ---------------------------------------------------------------------------

export function useAuditLog(
  params: { action?: string; from?: string; to?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: ['audit', params] as const,
    queryFn: ({ signal }) =>
      api<unknown[]>(
        `/audit${qs({
          action: params.action,
          from: params.from,
          to: params.to,
          limit: params.limit,
        })}`,
        { signal },
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}