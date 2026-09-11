// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Chat module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Used by the in-app chat pane and the WhatsApp inbound webhook handler.
// SSE resume (eng review A9) replays from Message.id so clients can reconnect
// with Last-Event-ID.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import {
  MessageChannelSchema,
  MessageDirectionSchema,
  MessageKindSchema,
} from './enums';

/**
 * POST /api/chat/send - staff sends a message to a lead.
 * Channel defaults to IN_APP; the WhatsApp path is auto-routed by the message
 * service if the lead has consented and the channel is unset.
 * `kind` defaults to CUSTOMER. INTERNAL = staff-only note (never enqueues
 * WhatsApp; the customer never sees it).
 */
export const SendMessageDtoSchema = z.object({
  leadId: z.string().cuid2(),
  body: z.string().trim().min(1).max(4000),
  channel: MessageChannelSchema.optional(),
  kind: MessageKindSchema.optional(),
  mediaUrl: z.string().url().optional(),
});
export type SendMessageDto = z.infer<typeof SendMessageDtoSchema>;

/**
 * GET /api/chat/:leadId query - load message history.
 * `since` is a cursor (createdAt ISO) for incremental load.
 * `kind` filters to a single thread (default: CUSTOMER).
 */
export const MessageFilterDtoSchema = z.object({
  leadId: z.string().cuid2(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  kind: MessageKindSchema.optional(),
});
export type MessageFilterDto = z.infer<typeof MessageFilterDtoSchema>;

/**
 * Internal shape of a Message row as serialized to the SSE client.
 * `id` is the SSE event-id (eng review A9 - Last-Event-ID resume).
 */
export const MessageEventSchema = z.object({
  id: z.string().cuid2(),
  leadId: z.string().cuid2(),
  direction: MessageDirectionSchema,
  channel: MessageChannelSchema,
  kind: MessageKindSchema.optional(),
  body: z.string(),
  mediaUrl: z.string().url().nullable().optional(),
  // Display name of the sender. OUT = the staff member who sent it
  // (Message.user.name); IN = the customer (the lead's name). Null when
  // the sender can't be resolved (e.g. a deleted user). The chat pane
  // renders this in the MessageHeader.
  senderName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;
