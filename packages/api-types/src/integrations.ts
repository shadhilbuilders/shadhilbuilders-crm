// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Integration telemetry DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Read-only admin feeds for ops visibility into the WhatsApp/Meta webhook
// pipeline (no write endpoints):
//
//   GET /api/integrations/webhook-events     (ADMIN/OWNER)
//     - raw inbound webhook events (Source/WebhookEvent table). Lets an
//       operator confirm Meta payloads actually reached the API and how they
//       were processed (deduped / Message created / unknown-contact upserted /
//       ignored / status update).
//
//   GET /api/integrations/whatsapp-delivery  (ADMIN/OWNER)
//     - outbound message delivery feed (OutboundMessage table): per-send
//       status SENT → DELIVERED → READ / FAILED via the status webhook, plus
//       attempts / lastError / wamid for diagnosis.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import { WebhookSourceSchema, OutboundStatusSchema } from './enums';

export { WebhookSourceSchema, OutboundStatusSchema } from './enums';

/** GET /api/integrations/webhook-events row. */
export const WebhookEventRowSchema = z.object({
  id: z.string(),
  source: WebhookSourceSchema,
  externalId: z.string(),
  processed: z.boolean(),
  processedAt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Raw Meta payload (opaque JSON; rendered as JSON in the UI). */
  payload: z.record(z.string(), z.unknown()),
});
export type WebhookEventRow = z.infer<typeof WebhookEventRowSchema>;

/** GET /api/integrations/whatsapp-delivery row. */
export const WhatsAppDeliveryRowSchema = z.object({
  id: z.string(),
  leadId: z.string(),
  leadName: z.string(),
  sendType: z.string(), // OutboundSendType
  templateName: z.string().nullable(),
  status: OutboundStatusSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  wamid: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type WhatsAppDeliveryRow = z.infer<typeof WhatsAppDeliveryRowSchema>;

/** Shared list envelope (matches other feed modules). */
export const IntegrationListResultSchema = z.object({
  total: z.number().int().min(0),
  rows: z.array(z.unknown()),
});
export type IntegrationListResult = z.infer<typeof IntegrationListResultSchema>;

/** GET filter (limit/offset, optional source / processed / status). */
export const WebhookEventsQuerySchema = z.object({
  source: WebhookSourceSchema.optional(),
  processed: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type WebhookEventsQuery = z.infer<typeof WebhookEventsQuerySchema>;

export const WhatsAppDeliveryQuerySchema = z.object({
  status: OutboundStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type WhatsAppDeliveryQuery = z.infer<typeof WhatsAppDeliveryQuerySchema>;
