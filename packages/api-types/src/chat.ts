// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Chat module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Used by the in-app chat pane and the WhatsApp inbound webhook handler.
// SSE resume (eng review A9) replays from Message.id so clients can reconnect
// with Last-Event-ID.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { MessageChannelSchema, MessageDirectionSchema } from './enums';

/**
 * POST /api/chat/send - staff sends a message to a lead.
 * Channel defaults to IN_APP; the WhatsApp path is auto-routed by the message
 * service if the lead has consented and the channel is unset.
 */
export const SendMessageDtoSchema = z.object({
  leadId: z.string().cuid(),
  body: z.string().trim().min(1).max(4000),
  channel: MessageChannelSchema.optional(),
  mediaUrl: z.string().url().optional(),
});
export type SendMessageDto = z.infer<typeof SendMessageDtoSchema>;

/**
 * GET /api/chat/:leadId query - load message history.
 * `since` is a cursor (createdAt ISO) for incremental load.
 */
export const MessageFilterDtoSchema = z.object({
  leadId: z.string().cuid(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type MessageFilterDto = z.infer<typeof MessageFilterDtoSchema>;

/**
 * Internal shape of a Message row as serialized to the SSE client.
 * `id` is the SSE event-id (eng review A9 - Last-Event-ID resume).
 */
export const MessageEventSchema = z.object({
  id: z.string().cuid(),
  leadId: z.string().cuid(),
  direction: MessageDirectionSchema,
  channel: MessageChannelSchema,
  body: z.string(),
  mediaUrl: z.string().url().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;
