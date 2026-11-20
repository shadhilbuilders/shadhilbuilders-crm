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
 * Two chat thread kinds exist because a Message belongs to exactly one
 * thread (`leadId` XOR `contactId`, enforced by the schema CHECK):
 *   - `chat:<leadId>`              - a known customer's thread
 *   - `chat-contact:<contactId>`   - a number that is not a lead yet
 * Both carry a cuid, which `parseChannel()` validates, and both reject
 * unknown shapes with a typed error.
 *
 * The contact form was added 2026-11-21: before it, the inbox opened an
 * SSE stream on `chat:<contactId>`, which passed the cuid check but then
 * 403'd in mintTicket (no Lead with that id). `openStream` re-mints on
 * every backoff retry, and those 403 loops drained the per-user ticket
 * budget (10/min) shared with `notifications` - so opening one
 * unknown-number thread starved notification realtime app-wide.
 */
export type RealtimeChannel =
  | { kind: 'notifications' }
  | { kind: 'audit' }
  | { kind: 'chat'; leadId: string }
  | { kind: 'chat-contact'; contactId: string };

const CUID_RE = /^c[a-z0-9]{20,}$/i;

const CONTACT_CHAT_PREFIX = 'chat-contact:';
const LEAD_CHAT_PREFIX = 'chat:';

/** Channel string for a lead's chat thread. Never hand-roll this string. */
export function leadChatChannel(leadId: string): string {
  return `${LEAD_CHAT_PREFIX}${leadId}`;
}

/** Channel string for an unknown-contact chat thread. */
export function contactChatChannel(contactId: string): string {
  return `${CONTACT_CHAT_PREFIX}${contactId}`;
}

export function parseChannel(raw: string): RealtimeChannel | null {
  if (raw === 'notifications') return { kind: 'notifications' };
  if (raw === 'audit') return { kind: 'audit' };
  // Checked BEFORE the lead prefix: `chat-contact:` must not be read as a
  // lead id of "-contact:<id>". (It would fail the cuid test today, but
  // relying on that is a trap for whoever adds a non-cuid channel later.)
  if (raw.startsWith(CONTACT_CHAT_PREFIX)) {
    const contactId = raw.slice(CONTACT_CHAT_PREFIX.length);
    if (CUID_RE.test(contactId)) return { kind: 'chat-contact', contactId };
    return null;
  }
  if (raw.startsWith(LEAD_CHAT_PREFIX)) {
    const leadId = raw.slice(LEAD_CHAT_PREFIX.length);
    if (CUID_RE.test(leadId)) return { kind: 'chat', leadId };
    return null;
  }
  return null;
}

/**
 * The `/api/sse` path a channel streams from, e.g. `/chat/<leadId>`.
 *
 * Lives here (not in the web app) so the browser hook and the SSE service
 * cannot drift: the hook builds the URL from this, the service matches the
 * route on it. An unrecognised channel falls back to `/<channel>`, which is
 * what `notifications` and `audit` already use.
 */
export function ssePathForChannel(channel: string): string {
  const parsed = parseChannel(channel);
  if (parsed === null) return `/${channel}`;
  switch (parsed.kind) {
    case 'chat':
      return `/chat/${parsed.leadId}`;
    case 'chat-contact':
      return `/chat-contact/${parsed.contactId}`;
    case 'notifications':
    case 'audit':
      return `/${parsed.kind}`;
  }
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
