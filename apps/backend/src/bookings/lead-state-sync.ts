// Booking → Lead state sync (T-BOOK-LEADSYNC, 2026-09-15).
//
// WHY: `Booking.status` and `Lead.state` are two independent fields and nothing
// reconciled them. `bookings.service.ts` never wrote `Lead.state`, so a live
// dev DB showed HOLD bookings on leads still marked `NEW`, and APPROVED
// bookings on leads still at `NEGOTIATION` - the leads page and the bookings
// page told different stories about the same deal.
//
// BUSINESS RULE (user-confirmed 2026-09-15), most-advanced active booking wins:
//   HOLD      → NEGOTIATION         (a villa is held, still negotiating)
//   TOKEN     → BOOKING_INITIATED   (DESIGN.md §3: "Token payment received")
//   APPROVED  → WON                 (DESIGN.md §3: "Agreement signed")
//   REJECTED  → NEGOTIATION         (deal opened again for re-negotiation)
//   CANCELLED → NEGOTIATION         (same)
//
// This module is PURE - no DB, no Nest. The service calls into it; the service
// owns persistence, RLS, audit and notifications (mirrors leads.state-machine.ts).
//
// RELATIONSHIP TO leads.state-machine.ts: the lead state machine governs
// USER-driven transitions and is role-aware (SALES_EXEC is limited to
// VISITED/NEGOTIATION/BOOKING_INITIATED; only ADMIN reopens terminal states).
// A booking-driven sync is a SYSTEM write, not a user transition - an exec who
// legitimately approves a booking must not be blocked because the lead machine
// reserves WON for a manager. So this module decides the TARGET state and the
// service writes it, deliberately bypassing the role lanes. It does NOT bypass
// the direction rule: see `advanceLeadState`.
import type { LeadState } from '@shadhil/database';

export type BookingStatusForLead = 'HOLD' | 'TOKEN' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/**
 * Rank on the MAIN pipeline so the sync can refuse to move a lead BACKWARDS.
 * Side states (RNR/LOST/RESCHEDULED/NO_SHOW) are intentionally absent - a
 * booking sync must not drag a lead out of those.
 */
const PIPELINE_RANK: Partial<Record<LeadState, number>> = {
  NEW: 0,
  CONTACTED: 1,
  VISIT_REQUESTED: 2,
  VISIT_SCHEDULED: 3,
  VISITED: 4,
  NEGOTIATION: 5,
  BOOKING_INITIATED: 6,
  WON: 7,
};

/** The lead state an active booking implies, by booking status. */
export const BOOKING_STATUS_TO_LEAD_STATE: Record<BookingStatusForLead, LeadState> = {
  HOLD: 'NEGOTIATION',
  TOKEN: 'BOOKING_INITIATED',
  APPROVED: 'WON',
  REJECTED: 'NEGOTIATION',
  CANCELLED: 'NEGOTIATION',
};

/**
 * Lead states a booking may be STARTED from. The user's rule: "lead must be
 * NEGOTIATION (or later) before a booking starts". A booking on a lead still at
 * NEW/CONTACTED/VISIT_* skips the whole sales conversation.
 *
 * RNR/LOST are excluded - reviving a dead lead is a deliberate act, not a
 * side effect of a booking.
 */
export const BOOKABLE_LEAD_STATES: readonly LeadState[] = [
  'NEGOTIATION',
  'BOOKING_INITIATED',
  'WON',
];

export function isBookableLeadState(state: LeadState): boolean {
  return BOOKABLE_LEAD_STATES.includes(state);
}

/**
 * Target lead state for a single booking status, or null when the sync must
 * not move the lead (side states it must never clobber).
 */
export function leadStateForBookingStatus(status: BookingStatusForLead): LeadState | null {
  const target = BOOKING_STATUS_TO_LEAD_STATE[status];
  return target ?? null;
}

/**
 * The lead state implied by the lead's WHOLE set of bookings - most advanced
 * active booking wins, mirroring the Unit.status rule
 * (one_active_booking_per_unit). When no booking is active the deal is back in
 * NEGOTIATION (user rule for CANCELLED/REJECTED).
 */
export function leadStateForBookings(
  statuses: readonly BookingStatusForLead[],
): LeadState {
  const active = statuses.filter(
    (s): s is BookingStatusForLead => s === 'HOLD' || s === 'TOKEN' || s === 'APPROVED',
  );
  if (active.includes('APPROVED')) return 'WON';
  if (active.includes('TOKEN')) return 'BOOKING_INITIATED';
  if (active.includes('HOLD')) return 'NEGOTIATION';
  return 'NEGOTIATION';
}

/**
 * Decide whether to apply a booking-driven lead move.
 *
 * - Forward moves (rank increases) always apply.
 * - Backward moves apply ONLY when explicitly requested (`allowRegress`) - that
 *   is the CANCELLED/REJECTED release back to NEGOTIATION. Without this guard a
 *   re-synced stale HOLD could drag a `WON` lead back to NEGOTIATION.
 * - A current state that is not on the main pipeline (RNR/LOST/...) is left
 *   alone unless `allowRegress` (an explicit cancel may revive it).
 */
export function shouldApplyLeadState(
  current: LeadState,
  target: LeadState,
  options: { allowRegress: boolean },
): boolean {
  if (current === target) return false;

  const from = PIPELINE_RANK[current];
  const to = PIPELINE_RANK[target];

  // Off-pipeline current state (RNR/LOST/RESCHEDULED/NO_SHOW): never dragged
  // by an ordinary sync.
  if (from === undefined) return options.allowRegress;

  // Target off-pipeline is never produced by this module, but be explicit.
  if (to === undefined) return false;

  if (to > from) return true;
  return options.allowRegress;
}
