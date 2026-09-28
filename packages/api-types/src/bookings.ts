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
 *
 * T-TOKEN-GATE (2026-09-28): `tokenAmount` is REQUIRED on HOLD → TOKEN. That
 * move means "the token payment was received", and the amount is the only record
 * of HOW MUCH was received - yet the transition accepted no amount at all and
 * never wrote the column, so a booking could sit in TOKEN with
 * `tokenAmount = NULL`. That is unverifiable on its own, and it actively
 * corrupts the admin "Booking money" card, which derives its meaning from the
 * column (`tokenPaid = tokenAmount !== null && > 0`): a NULL token renders as
 * "HOLD - no token", i.e. money still with the customer, for a booking the
 * operator just marked as paid.
 *
 * Not simply "always required": `CreateBookingDto` already accepts a token
 * amount at HOLD time, so the value can legitimately exist before this call.
 * The service therefore accepts an already-stored positive amount - the rule is
 * that one must EXIST, from either place.
 */
export const BookingTransitionDtoSchema = z
  .object({
    toStatus: BookingStatusSchema,
    reason: z.string().trim().max(500).optional(),
    /**
     * Token received, in rupees. Required for HOLD → TOKEN unless a positive
     * amount is already stored on the booking.
     */
    tokenAmount: z
      .number()
      .positive('Token amount must be greater than zero')
      .max(1_000_000_000, 'Amount too large (cap ₹100 Cr)')
      .optional(),
  })
  .superRefine((values, ctx) => {
    // T-TOKEN-GATE: a move INTO TOKEN must state the amount received. Checked
    // here (not only in the service) so the error attaches to the `tokenAmount`
    // field and the form highlights the control that is missing the value -
    // the same reason the `reason` rule below lives at this layer.
    //
    // Strict at the boundary on purpose: this DTO is the CLIENT contract, and a
    // client always knows the booking's stored amount, so it can always send one
    // (the UI prefills it). The service keeps a more tolerant rule - see
    // `transition()` - because a direct service call may legitimately rely on an
    // amount already recorded at HOLD time. Boundary strict, invariant tolerant.
    if (values.toStatus === 'TOKEN' && values.tokenAmount === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tokenAmount'],
        message: 'Enter the token amount received before marking the token as received',
      });
    }
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
