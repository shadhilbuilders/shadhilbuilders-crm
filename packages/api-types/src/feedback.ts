// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Feedback (public submissions from the landing page) DTOs
// ────────────────────────────────────────────────────────────────────────────
// Endpoints served by apps/backend/src/feedbacks/:
//
//   POST /api/public/feedback                  (public, API-key-gated)
//     - the landing page calls this when a visitor submits the feedback
//       form; feedback now lands in the CRM DB instead of Supabase.
//     - auth: `x-api-key: <FEEDBACK_API_KEY>` header (constant-time compare).
//     - body: { name?, phone?, rating (required 1-5), project?, message?,
//              page? }. ipAddress + userAgent are captured server-side and
//              are NOT part of the request body.
//     - response: { ok: true, id: string }
//
//   GET /api/feedback?status=...&limit=...&cursor=...       (ADMIN/OWNER)
//     - list feedback for triage, cursor-paginated, status filter.
//
//   PATCH /api/feedback/:id  body: { status }               (ADMIN/OWNER)
//     - flip status (NEW -> REVIEWED -> ARCHIVED). No body mutation -
//       feedback content is immutable; only triage status changes.
// ────────────────────────────────────────────────────────────────────────────
import { z } from 'zod';

import { FeedbackStatusSchema } from './enums';

// Re-export the status enum so consumers don't have to import from ./enums.
export { FeedbackStatusSchema } from './enums';

// ────────────────────────────────────────────────────────────────────────
// Public submit DTO (POST /api/public/feedback)
// ────────────────────────────────────────────────────────────────────────

/** Validate + shape-check the public submission before it reaches the DB.
 *  Mirrors lib/feedback-schema.ts on the landing page, but the DB layer
 *  enforces its own independent contract (defense in depth: the landing
 *  page is one client; another client could hit the API directly). */
export const CreateFeedbackDtoSchema = z.object({
  name: z
    .string()
    .trim()
    .max(100, 'Name is too long')
    .optional()
    .or(z.literal('')),
  phone: z
    .string()
    .trim()
    .regex(/^$|^\d{10,13}$/, 'Please enter a valid phone number')
    .optional()
    .or(z.literal('')),
  // Required 1-5. The landing form never sends a rating-less payload;
  // the API rejects one anyway so a direct caller can't sneak it by.
  rating: z
    .number({ error: 'rating is required' })
    .int('rating must be an integer')
    .min(1, 'rating must be between 1 and 5')
    .max(5, 'rating must be between 1 and 5'),
  project: z
    .string()
    .trim()
    .max(100, 'project is too long')
    .optional()
    .or(z.literal('')),
  message: z
    .string()
    .trim()
    .max(2000, 'Message is too long')
    .optional()
    .or(z.literal('')),
  page: z.string().trim().max(200, 'page is too long').optional().or(z.literal('')),
});
export type CreateFeedbackDto = z.infer<typeof CreateFeedbackDtoSchema>;

/** Shape of POST /api/public/feedback success. `id` is the new row's cuid
 *  (the landing page can log it / show it as a reference, mirroring the
 *  old Supabase `feedbackId`). */
export interface CreateFeedbackResult {
  ok: true;
  id: string;
}

// ────────────────────────────────────────────────────────────────────────
// Admin list DTO (GET /api/feedback)
// ────────────────────────────────────────────────────────────────────────
export const FeedbackListQuerySchema = z.object({
  status: FeedbackStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type FeedbackListQuery = z.infer<typeof FeedbackListQuerySchema>;

/** Shape of one row in the list response (ISO timestamps). */
export interface FeedbackRow {
  id: string;
  name: string | null;
  phone: string | null;
  rating: number;
  project: string | null;
  message: string | null;
  page: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  status: 'NEW' | 'REVIEWED' | 'ARCHIVED';
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Shape of GET /api/feedback response. */
export interface FeedbackListResult {
  total: number;
  rows: FeedbackRow[];
  /** Opaque cursor for the next page; null when no more rows. */
  nextCursor: string | null;
}

// ────────────────────────────────────────────────────────────────────────
// Admin status-change DTO (PATCH /api/feedback/:id)
// ────────────────────────────────────────────────────────────────────────

/** Only `status` may change; feedback content is immutable. */
export const UpdateFeedbackStatusDtoSchema = z.object({
  status: FeedbackStatusSchema,
});
export type UpdateFeedbackStatusDto = z.infer<
  typeof UpdateFeedbackStatusDtoSchema
>;

/** Shape of the PATCH response - the updated row. */
export interface UpdateFeedbackResult {
  row: FeedbackRow;
}
