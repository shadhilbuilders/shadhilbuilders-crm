// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Webhooks module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Inbound webhook handlers: WhatsApp (Meta) + FreJun (telephony).
// Dedupe via WebhookEvent.externalId unique index.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * WhatsApp Cloud API - inbound message webhook payload.
 * Shape: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 * We only validate the parts we care about; the rest stays as `unknown`.
 */
export const WhatsAppWebhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: z.object({
            messaging_product: z.literal('whatsapp'),
            metadata: z.object({
              display_phone_number: z.string(),
              phone_number_id: z.string(),
            }),
            contacts: z
              .array(
                z.object({
                  profile: z.object({ name: z.string() }),
                  wa_id: z.string(),
                }),
              )
              .optional(),
            messages: z
              .array(
                z.object({
                  from: z.string(),
                  id: z.string(), // externalId - used for dedupe
                  timestamp: z.string(),
                  type: z.string(),
                  text: z.object({ body: z.string() }).optional(),
                  image: z
                    .object({
                      id: z.string(),
                      mime_type: z.string(),
                      sha256: z.string(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          }),
          field: z.literal('messages'),
        }),
      ),
    }),
  ),
});
export type WhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookPayloadSchema>;

/**
 * FreJun inbound call webhook payload.
 * Shape is vendor-specific; we accept the documented fields and ignore the rest.
 */
export const FreJunWebhookPayloadSchema = z.object({
  event: z.enum(['call.completed', 'call.ringing', 'call.missed']),
  callId: z.string(),
  agentNumber: z.string(),
  customerNumber: z.string(),
  duration: z.number().int().nonnegative().optional(),
  recordingUrl: z.string().url().optional(),
  timestamp: z.string().datetime({ offset: true }),
});
export type FreJunWebhookPayload = z.infer<typeof FreJunWebhookPayloadSchema>;

/**
 * Generic WebhookEvent internal shape (matches the Prisma model).
 */
export const WebhookEventDtoSchema = z.object({
  source: z.enum(['WHATSAPP', 'FREJUN']),
  externalId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type WebhookEventDto = z.infer<typeof WebhookEventDtoSchema>;
