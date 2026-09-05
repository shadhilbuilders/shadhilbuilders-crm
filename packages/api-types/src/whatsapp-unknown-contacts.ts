// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM — WhatsappUnknownContact (T-E2b follow-up queue) DTOs
// ────────────────────────────────────────────────────────────────────────────
// Endpoints served by apps/backend/src/whatsapp-unknown-contacts/:
//
//   GET    /api/whatsapp-unknown-contacts?status=...&limit=...&cursor=...
//     — list contacts in the follow-up queue, paginated
//   POST   /api/whatsapp-unknown-contacts/:id/convert
//     body: CreateLeadDto (name, phone, email?, source='WHATSAPP', projectId?, notes?)
//     — creates a Lead, links the contact via convertedToLeadId,
//       flips status to CONVERTED, all in one transaction
//   POST   /api/whatsapp-unknown-contacts/:id/spam
//     — flips status to SPAM (no Lead required)
//
// The convert flow reuses CreateLeadDtoSchema from ./leads so the
// lead-create contract stays in one place (manager assignment,
// RLS checks, audit log — all driven by LeadsService.create).
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import { CreateLeadDtoSchema } from './leads';
import { WhatsappUnknownContactStatusSchema } from './enums';

// Re-export the status enum so consumers don't have to import
// from ./enums directly.
export { WhatsappUnknownContactStatusSchema } from './enums';

// ────────────────────────────────────────────────────────────────────
// Query / response DTOs
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/whatsapp-unknown-contacts — filter DTO. Status is optional
 * (defaults to "PENDING" — the queue the admin UI defaults to). Limit
 * caps page size; cursor is opaque (base64 of last-seen
 * `${createdAt.toISOString()}_${id}`), passed back by the previous
 * response's `nextCursor` field.
 */
export const WhatsappUnknownContactListQuerySchema = z.object({
  status: WhatsappUnknownContactStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type WhatsappUnknownContactListQuery = z.infer<
  typeof WhatsappUnknownContactListQuerySchema
>;

/** Shape of one row in the list response. */
export interface WhatsappUnknownContactRow {
  id: string;
  phoneE164: string;
  firstMessageAt: string; // ISO
  lastMessageAt: string;  // ISO
  messageCount: number;
  firstMessageBody: string | null;
  status: 'PENDING' | 'CONVERTED' | 'SPAM';
  convertedToLeadId: string | null;
  notes: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Shape of GET /api/whatsapp-unknown-contacts response. */
export interface WhatsappUnknownContactListResult {
  total: number;
  rows: WhatsappUnknownContactRow[];
  /** Opaque cursor for the next page; null when no more rows. */
  nextCursor: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Convert endpoint
// ────────────────────────────────────────────────────────────────────

/**
 * POST /api/whatsapp-unknown-contacts/:id/convert — the body is
 * the same CreateLeadDto that POST /api/leads accepts, with the
 * source field pre-populated to 'WHATSAPP' by the UI modal. We
 * re-use the schema verbatim — same field validation, same manager
 * assignment engine, same audit log.
 */
export const ConvertUnknownContactDtoSchema = CreateLeadDtoSchema;
export type ConvertUnknownContactDto = z.infer<typeof ConvertUnknownContactDtoSchema>;

/** Shape of the convert response — returns the new Lead + the
 *  updated contact row, so the UI can navigate to the Lead
 *  detail page after a successful convert. */
export interface ConvertUnknownContactResult {
  lead: {
    id: string;
    name: string;
    phone: string;
    phoneE164: string | null;
    state: string;
    ownerId: string;
    teamId: string;
    createdAt: string;
  };
  contact: WhatsappUnknownContactRow;
}

// ────────────────────────────────────────────────────────────────────
// Spam endpoint
// ────────────────────────────────────────────────────────────────────

/** POST /api/whatsapp-unknown-contacts/:id/spam — no body needed. */
export interface SpamUnknownContactResult {
  contact: WhatsappUnknownContactRow;
}
