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
    .max(100_000_000_00, 'Amount too large (cap ₹100 Cr)'),
  tokenAmount: z.number().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateBookingDto = z.infer<typeof CreateBookingDtoSchema>;

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
  // Seed project ids are readable (`seed-project-metro-heights`), not
  // cuids - same convention as leads.ts projectId. Resolved through
  // Lead.projectId on the server.
  projectId: z.string().trim().min(1).max(64).optional(),
  status: z
    .union([BookingStatusSchema, z.array(BookingStatusSchema)])
    .optional(),
  approvedById: z.string().cuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type BookingFilterDto = z.infer<typeof BookingFilterDtoSchema>;
