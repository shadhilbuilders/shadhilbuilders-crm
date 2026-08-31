// Lead, visit, chat, booking, notification, and audit hooks.
//
// IMPORTANT (honest-state contract): the leads/visits/chat/bookings/
// notifications/audit modules on the backend are SCAFFOLDED but not yet
// implemented (only `users` is live as of Aug 31, 2026). These hooks call
// the exact endpoint contracts defined in packages/api-types/src/*.ts so
// they light up automatically when the controllers land. Until then pages
// render their typed error/empty states — never fake data.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';

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
    queryFn: () =>
      api<unknown[]>(
        `/leads${qs({
          state: filter.state?.join(','),
          ownerId: filter.ownerId,
          teamId: filter.teamId,
          search: filter.search,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
      ),
    staleTime: 15_000,
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['leads', id] as const,
    enabled: id !== null && id.length > 0,
    queryFn: () => api<unknown>(`/leads/${id as string}`),
  });
}

export function useLeadActivities(id: string | null) {
  return useQuery({
    queryKey: ['leads', id, 'activities'] as const,
    enabled: id !== null && id.length > 0,
    queryFn: () => api<unknown[]>(`/leads/${id as string}/activities`),
  });
}

// ---------------------------------------------------------------------------
// Visits (contract: packages/api-types/src/visits.ts)
// ---------------------------------------------------------------------------

export function useVisits(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['visits', params] as const,
    queryFn: () =>
      api<unknown[]>(`/visits${qs({ from: params.from, to: params.to })}`),
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Chat (contract: packages/api-types/src/chat.ts)
// ---------------------------------------------------------------------------

export function useMessages(leadId: string | null) {
  return useQuery({
    queryKey: ['chat', leadId] as const,
    enabled: leadId !== null && leadId.length > 0,
    queryFn: () => api<unknown[]>(`/chat/${leadId as string}`),
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
    queryFn: () => api<unknown[]>(`/bookings${qs({ status: params.status })}`),
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Notifications (contract: packages/api-types/src/notifications.ts)
// ---------------------------------------------------------------------------

export function useNotifications(params: { unreadOnly?: boolean } = {}) {
  return useQuery({
    queryKey: ['notifications', params] as const,
    queryFn: () =>
      api<unknown[]>(`/notifications${qs({ unreadOnly: params.unreadOnly })}`),
    staleTime: 10_000,
    refetchInterval: 60_000,
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
    queryFn: () =>
      api<unknown[]>(
        `/audit${qs({
          action: params.action,
          from: params.from,
          to: params.to,
          limit: params.limit,
        })}`,
      ),
    staleTime: 30_000,
  });
}