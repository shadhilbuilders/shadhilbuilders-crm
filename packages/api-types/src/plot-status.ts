// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Plot availability (the CMDA layout map)
// ────────────────────────────────────────────────────────────────────────────
// The interactive plot map paints 125 plots traced from the approved CMDA
// drawing. Those plots are NOT rows in the database - the geometry is a static
// trace of the drawing - so their availability is DERIVED from the project's
// units.
//
// THE BRIDGE IS THE UNIT'S PLOT NUMBER, and it is a FIELD, not a coincidence of
// naming. `Unit.plotNumber` carries the villa's position on the approved
// drawing; `Unit.unitNumber` carries the DOOR number printed on the villa
// ("A-101"). They are different identifiers, and the map joins on the former.
// Nothing is parsed out of a door number - "D-101" is not plot 101 and never
// was - so the two can never be confused. A unit with no plot number is simply
// not on the layout; a project where nobody has assigned one gets an empty row
// set and the map reads every plot as available, which is the truth: nothing is
// sold against a plot the CRM cannot place.
//
// EACH ROW CARRIES THE REAL RECORDS behind the plot, not just a colour: the
// unit row itself (the same shape the inventory grid uses) and its one active
// booking with the buyer's name. The map is a second view of inventory, so it
// has to be able to say "villa A-101, plot 37, sold to Demo Vikram" and link to
// both records, instead of showing a green polygon nobody can act on.
//
// Roles: GET /api/inventory/plots - every authenticated role, matching the
// inventory grid this is derived from. Bookings stay governed by their own RLS:
// a caller who may not see a booking gets the unit with `booking: null`, never
// somebody else's deal. The query is scoped to the ACTOR's organization as well
// as the requested project.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import { BookingStatusSchema, UnitStatusSchema, type BookingStatus, type UnitStatus } from './enums';
import { UnitRowSchema } from './inventory';
import { PlotNumberSchema } from './plot-number';

/**
 * Availability of one plot on the layout. Deliberately a DIFFERENT vocabulary
 * from UnitStatus: a unit walks a sales lifecycle (AVAILABLE/HOLD/TOKEN/SOLD),
 * while a plot is simply sellable or not. Keeping them separate is what stops
 * the map from having to know about tokens and holds.
 */
export const PlotStatusSchema = z.enum(['available', 'booked', 'blocked']);
export type PlotStatus = z.infer<typeof PlotStatusSchema>;

/**
 * The live booking behind a plot, as the map needs it: who holds the unit,
 * where the money sits, and where to go to see the whole record.
 *
 * A deliberately NARROW reference, not the full booking row: this travels on
 * the map, whose job is to say which villa is gone and to whom, not to be a
 * second bookings grid. The full row contract stays in the bookings module.
 */
export const PlotBookingRefSchema = z.object({
  id: z.string(),
  status: BookingStatusSchema,
  /** Effective total: negotiatedAmount when set, else listAmount. */
  amount: z.string(),
  tokenAmount: z.string().nullable(),
  leadId: z.string(),
  /** The lead's name, so the map names the buyer instead of an id. */
  leadName: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PlotBookingRef = z.infer<typeof PlotBookingRefSchema>;

/**
 * One unit claiming a plot, with its live booking (or none).
 *
 * `unit` is the REAL unit row - the same `UnitRowSchema` the inventory grid
 * carries, not a copy of it. Two shapes for one record is how the grid and the
 * map end up disagreeing about the same villa.
 */
export const PlotUnitClaimSchema = z.object({
  unit: UnitRowSchema,
  /** The one active booking, or null when nothing holds the unit. */
  booking: PlotBookingRefSchema.nullable(),
});
export type PlotUnitClaim = z.infer<typeof PlotUnitClaimSchema>;

/** Row shape for GET /api/inventory/plots. */
export const PlotStatusRowSchema = z.object({
  /** Plot number on the approved layout. 1-113 regular, 114-125 EWS. */
  plotNumber: PlotNumberSchema,
  status: PlotStatusSchema,
  /**
   * Every unit claiming this plot number, most binding claim first, each with
   * its booking. Usually one; two phases that each hold plot 5 give two, and
   * dropping one would hide a sold plot's real owner.
   *
   * Defaults to `[]` so a row from an API that predates the join still parses:
   * the plot then renders with no record behind it, which is exactly what an
   * unmatched plot is.
   */
  units: z.array(PlotUnitClaimSchema).default([]),
});
export type PlotStatusRow = z.infer<typeof PlotStatusRowSchema>;

export const PlotStatusListResultSchema = z.object({
  rows: z.array(PlotStatusRowSchema),
});
export type PlotStatusListResult = z.infer<typeof PlotStatusListResultSchema>;

/**
 * Unit lifecycle -> plot availability. THE single mapping: the map's colours,
 * the details panel and this table must never become three copies of one rule.
 *
 * HOLD and TOKEN both read `blocked` because neither is available for a new
 * booking - HOLD is a live hold, TOKEN means a token was taken. SOLD reads
 * `booked`: the bookings module sets SOLD exactly when a booking reaches
 * APPROVED, so SOLD implies a booked plot.
 */
export const PLOT_STATUS_FROM_UNIT_STATUS: Record<UnitStatus, PlotStatus> = {
  AVAILABLE: 'available',
  HOLD: 'blocked',
  TOKEN: 'blocked',
  SOLD: 'booked',
};

export function plotStatusFromUnitStatus(status: UnitStatus): PlotStatus {
  return PLOT_STATUS_FROM_UNIT_STATUS[status];
}

/**
 * Most binding claim first. ONE ordering, two consumers: the plot's colour
 * (via `mostBindingPlotStatus`) and the order the details panel lists the units
 * in, so the panel's first unit is always the one the colour came from. Two
 * orderings is how a panel ends up saying "Available" about a sold plot.
 */
export const PLOT_STATUS_BINDING_ORDER: readonly PlotStatus[] = ['booked', 'blocked', 'available'];

/** Unit lifecycle statuses, most binding first (mirrors the booking mapping). */
export const UNIT_STATUS_BINDING_ORDER: readonly UnitStatus[] = ['SOLD', 'TOKEN', 'HOLD', 'AVAILABLE'];

/**
 * Booking statuses that still claim their unit, most binding first.
 *
 * The third and last definition of one rule, alongside the DB's partial unique
 * index `one_active_booking_per_unit` and the `unit_recompute_status` trigger's
 * CASE - see `ACTIVE_BOOKING_STATUSES`. Terminal states (REJECTED, CANCELLED)
 * are absent because they release the unit rather than claim it.
 */
export const BOOKING_STATUS_BINDING_ORDER: readonly BookingStatus[] = ['APPROVED', 'TOKEN', 'HOLD'];

/** Rank a unit status by how binding its claim is; 0 is the strongest. */
export function unitClaimRank(status: UnitStatus): number {
  return UNIT_STATUS_BINDING_ORDER.indexOf(status);
}

/**
 * Rank a booking status by how binding its claim is; 0 is the strongest.
 *
 * A status outside the binding order (REJECTED, CANCELLED) sorts LAST rather
 * than first, so a terminal booking can never be presented as the claim on a
 * unit. `indexOf` returning -1 is exactly that case.
 */
export function bookingClaimRank(status: BookingStatus): number {
  const rank = BOOKING_STATUS_BINDING_ORDER.indexOf(status);
  return rank === -1 ? BOOKING_STATUS_BINDING_ORDER.length : rank;
}

/**
 * Resolve the status of a plot claimed by more than one unit.
 *
 * `Unit` is unique on (phaseId, plotNumber), so two phases of one project may
 * each hold plot 5 (a phase can only hold a number once). Rather than silently
 * pick one, take the most binding claim - a sold plot must never read available
 * because a different phase has a free villa on the same number.
 */
export function mostBindingPlotStatus(statuses: readonly PlotStatus[]): PlotStatus {
  for (const candidate of PLOT_STATUS_BINDING_ORDER) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'available';
}

/** Runtime guard used by the backend to validate the unit status it reads. */
export { UnitStatusSchema };
