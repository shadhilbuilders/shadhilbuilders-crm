// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Bookings module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Manager approval flow: §0.11 - Manager sees full-screen modal, Sales Exec
// sees drawer. Both call the same POST /bookings/:id/approve endpoint.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { BookingStatusSchema } from './enums';

/**
 * POST /api/bookings - start a new booking (HOLD state).
 * Sales Exec initiates. Manager approves later via /approve.
 */
export const CreateBookingDtoSchema = z.object({
  leadId: z.string().cuid(),
  unitId: z.string().cuid(),
  amount: z
    .number()
    .positive()
    .max(1_000_000_000, 'Amount too large (cap ₹100 Cr)'),
  tokenAmount: z.number().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateBookingDto = z.infer<typeof CreateBookingDtoSchema>;

/**
 * PATCH /api/bookings/:id - edit the editable booking fields.
 * leadId/unitId/status/userId/approvedById are NOT editable here:
 *   - status changes go through /transition (state machine)
 *   - unit/lead reassignment is out of scope for v1
 * Editable: amount / tokenAmount / notes.
 */
export const UpdateBookingDtoSchema = z.object({
  amount: z
    .number()
    .positive()
    .max(1_000_000_000, 'Amount too large (cap ₹100 Cr)')
    .optional(),
  tokenAmount: z.number().positive().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateBookingDto = z.infer<typeof UpdateBookingDtoSchema>;

/**
 * POST /api/bookings/:id/approve - Manager approves or rejects.
 * `approved: false` requires a reason (audit + customer follow-up).
 */
export const ApproveBookingDtoSchema = z.object({
  approved: z.boolean(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ApproveBookingDto = z.infer<typeof ApproveBookingDtoSchema>;

/**
 * PATCH /api/bookings/:id/transition - advance booking state.
 * Used for: HOLD → TOKEN (after token payment) | any → CANCELLED.
 */
export const BookingTransitionDtoSchema = z.object({
  toStatus: BookingStatusSchema,
  reason: z.string().trim().max(500).optional(),
});
export type BookingTransitionDto = z.infer<typeof BookingTransitionDtoSchema>;

/**
 * GET /api/bookings query filter.
 */
export const BookingFilterDtoSchema = z.object({
  leadId: z.string().cuid().optional(),
  unitId: z.string().cuid().optional(),
  // Project.id is a real cuid2 (T-PROJID-CUID2, 2026-09-08). Resolved
  // through Lead.projectId on the server.
  projectId: z.cuid2().optional(),
  status: z
    .union([BookingStatusSchema, z.array(BookingStatusSchema)])
    .optional(),
  approvedById: z.string().cuid().optional(),
  // Server-side search over the parent Lead's name/phone (the booking has
  // no name of its own). Mirrors the leads D9 contract (≥2 chars).
  search: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type BookingFilterDto = z.infer<typeof BookingFilterDtoSchema>;
