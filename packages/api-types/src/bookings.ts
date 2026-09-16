// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Bookings module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Manager approval flow: §0.11 - Manager sees full-screen modal, Sales Exec
// sees drawer. Both call the same POST /bookings/:id/approve endpoint.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { BookingStatusSchema, type BookingStatus } from './enums';

/**
 * The booking statuses that may only be reached WITH an operator-supplied
 * reason. Single source for the DTO rule, the service guard and the UI form, so
 * the three can never disagree about which moves need a justification.
 * Declared before the DTOs that use it.
 */
export const TransitionReasonRequired: ReadonlySet<BookingStatus> = new Set([
  'CANCELLED',
  'REJECTED',
]);

/**
 * POST /api/bookings - start a new booking (HOLD state).
 * Sales Exec initiates. Manager approves later via /approve.
 */
export const CreateBookingDtoSchema = z.object({
  leadId: z.string().cuid2(),
  unitId: z.string().cuid2(),
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
 *
 * `reason` is REQUIRED when the move ends or reverses the deal
 * (`CANCELLED`, `REJECTED`) and forbidden-to-be-blank there: the audit row and
 * the customer follow-up both depend on it, and a generated
 * "moved by <email>" string is not a reason. Enforced with `.superRefine()` on
 * the parent object (zod v4 cross-field rule) so the error lands on the
 * `reason` field and the form can highlight the right control.
 *
 * Before this, `reason` was merely `.optional()` with a comment claiming it was
 * required - so a cancel with no reason (or a whitespace-only one) went
 * straight through and the audit log substituted a placeholder. Verified
 * against the live service.
 */
export const BookingTransitionDtoSchema = z
  .object({
    toStatus: BookingStatusSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((values, ctx) => {
    if (!TransitionReasonRequired.has(values.toStatus)) return;
    if ((values.reason ?? '').trim().length > 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `A reason is required when moving a booking to ${values.toStatus}`,
    });
  });
export type BookingTransitionDto = z.infer<typeof BookingTransitionDtoSchema>;

/**
 * GET /api/bookings query filter.
 */
export const BookingFilterDtoSchema = z.object({
  leadId: z.string().cuid2().optional(),
  unitId: z.string().cuid2().optional(),
  // Project.id is always a real cuid2 (seed/fixture slug ids were purged),
  // so filter strictly - a non-cuid2 value is a 400.
  projectId: z.cuid2().optional(),
  status: z
    .union([BookingStatusSchema, z.array(BookingStatusSchema)])
    .optional(),
  approvedById: z.string().cuid2().optional(),
  // Server-side search over the parent Lead's name/phone (the booking has
  // no name of its own). Mirrors the leads D9 contract (≥2 chars).
  search: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type BookingFilterDto = z.infer<typeof BookingFilterDtoSchema>;
