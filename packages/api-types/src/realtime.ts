// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Realtime module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// T-E2 (Week 6, 2026-09-04): the SSE realtime layer.
//
// Flow:
//   1. Browser POSTs /api/realtime/ticket with `{ channel: "chat:<id>" }`.
//   2. Backend mints a 5-minute StreamTicket row, returns the cuid as
//      the ticket. The browser passes it as a query-string param to
//      the SSE endpoint:
//        GET /api/sse/notifications?ticket=<cuid>
//        GET /api/sse/audit?ticket=<cuid>
//        GET /api/sse/chat/<leadId>?ticket=<cuid>
//   3. The SSE controller consumes (deletes) the ticket on connect,
//      then emits MessageEvent / NotificationEvent / AuditEvent
//      payloads with `id: <row-id>` so the browser can reconnect
//      with `Last-Event-ID` for resume.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * POST /api/realtime/ticket - request body.
 *
 * `channel` is a freeform string with a small fixed vocabulary:
 *   - "notifications"             - current user's Notification inbox
 *   - "audit"                     - current user's AuditLog visibility
 *   - `chat:<cuid>`               - Message stream for a specific lead
 *
 * The MintTicketDto schema accepts the union shape; the controller
 * dispatches to the correct validator (leadId cuids for chat, role
 * checks for audit) per channel.
 */
export const MintTicketDtoSchema = z.object({
  channel: z.string().min(1).max(120),
});
export type MintTicketDto = z.infer<typeof MintTicketDtoSchema>;

/**
 * POST /api/realtime/ticket - response shape.
 *
 * `ticket` is the StreamTicket cuid - the browser passes it as the
 * `?ticket=` query-string param to the SSE endpoint. `expiresAt` is
 * an ISO datetime so the client can refresh before expiry.
 */
export const MintTicketResponseSchema = z.object({
  ticket: z.string().cuid2(),
  channel: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type MintTicketResponse = z.infer<typeof MintTicketResponseSchema>;

/**
 * Canonical channel vocabulary. Helpers below parse a channel string
 * into a typed discriminator; the controller uses them to dispatch.
 *
 * `chat` channels carry the leadId - `parseChannel()` validates it as
 * a cuid and rejects unknown channel shapes with a typed error.
 */
export type RealtimeChannel =
  | { kind: 'notifications' }
  | { kind: 'audit' }
  | { kind: 'chat'; leadId: string };

const CUID_RE = /^c[a-z0-9]{20,}$/i;

export function parseChannel(raw: string): RealtimeChannel | null {
  if (raw === 'notifications') return { kind: 'notifications' };
  if (raw === 'audit') return { kind: 'audit' };
  if (raw.startsWith('chat:')) {
    const leadId = raw.slice('chat:'.length);
    if (CUID_RE.test(leadId)) return { kind: 'chat', leadId };
    return null;
  }
  return null;
}

/**
 * Audit event payload emitted on the audit SSE channel.
 * Mirrors the row shape returned by `GET /api/audit` minus the
 * userName join (the SSE consumer can join locally if needed).
 */
export const AuditEventSchema = z.object({
  id: z.string().cuid2(),
  userId: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;