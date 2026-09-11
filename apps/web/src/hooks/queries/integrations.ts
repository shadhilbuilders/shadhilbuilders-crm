// Integration telemetry - React Query hooks (admin ops pages).
//
// Wire shape (via the BFF catch-all proxying GET /api/integrations/*):
//
//   useWebhookEvents({ source?, processed?, limit, offset })
//     → GET /api/integrations/webhook-events
//       returns { total, rows: WebhookEventRow[] }
//
//   useWhatsAppDelivery({ status?, limit, offset })
//     → GET /api/integrations/whatsapp-delivery
//       returns { total, rows: WhatsAppDeliveryRow[] }
//
// Both are ADMIN/OWNER-only (service guard + RLS).

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';

import type {
  WebhookEventsQuery,
  WebhookEventRow,
  WhatsAppDeliveryQuery,
  WhatsAppDeliveryRow,
} from '@shadhil/api-types';

export type WebhookEventsResult = {
  total: number;
  rows: WebhookEventRow[];
};
export type WhatsAppDeliveryResult = {
  total: number;
  rows: WhatsAppDeliveryRow[];
};

function totalRows(raw: { total?: unknown; rows?: unknown }): {
  total: number;
  rows: unknown[];
} {
  return {
    total: typeof raw.total === 'number' ? raw.total : 0,
    rows: Array.isArray(raw.rows) ? raw.rows : [],
  };
}

export function useWebhookEvents(query: Partial<WebhookEventsQuery> = {}) {
  return useQuery({
    queryKey: ['integrations', 'webhook-events', query] as const,
    queryFn: ({ signal }) =>
      api<{ total: number; rows: WebhookEventRow[] }>(
        `/integrations/webhook-events${qs({
          source: query.source,
          processed:
            typeof query.processed === 'boolean' ? String(query.processed) : undefined,
          limit: query.limit,
          offset: query.offset,
        })}`,
        { signal },
      ),
    select: (raw): WebhookEventsResult => {
      const t = totalRows(raw);
      return { total: t.total, rows: t.rows as WebhookEventRow[] };
    },
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

export function useWhatsAppDelivery(query: Partial<WhatsAppDeliveryQuery> = {}) {
  return useQuery({
    queryKey: ['integrations', 'whatsapp-delivery', query] as const,
    queryFn: ({ signal }) =>
      api<{ total: number; rows: WhatsAppDeliveryRow[] }>(
        `/integrations/whatsapp-delivery${qs({
          status: query.status,
          limit: query.limit,
          offset: query.offset,
        })}`,
        { signal },
      ),
    select: (raw): WhatsAppDeliveryResult => {
      const t = totalRows(raw);
      return { total: t.total, rows: t.rows as WhatsAppDeliveryRow[] };
    },
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

export type { WebhookEventRow, WhatsAppDeliveryRow };
