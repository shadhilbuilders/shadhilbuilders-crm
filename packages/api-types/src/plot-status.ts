// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Plot availability (the CMDA layout map)
// ────────────────────────────────────────────────────────────────────────────
// The interactive plot map paints 125 plots traced from the approved CMDA
// drawing. Those plots are NOT rows in the database - the geometry is a static
// trace of the drawing - so their availability is DERIVED from the project's
// units.
//
// THE BRIDGE IS THE UNIT NUMBER. A unit whose number is a bare integer is read
// as that CMDA plot: unit "37" is plot 37. Anything else - "D-101", "A-12",
// "Villa 3" - is NOT a plot number and is excluded rather than coerced, so a
// marketing number can never be misread as a plot. Numbering units by phase
// ("D-101" = phase D, unit 101) is the scheme the repository actually uses, so
// today this endpoint legitimately returns an empty row set: the map then reads
// every plot as available, which is the truth - nothing is sold against a plot
// the CRM cannot identify. Do not paper over that by renumbering seed data.
//
// Roles: GET /api/inventory/plots - every authenticated role, matching the
// inventory grid this is derived from.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import { UnitStatusSchema, type UnitStatus } from './enums';

/**
 * Availability of one plot on the layout. Deliberately a DIFFERENT vocabulary
 * from UnitStatus: a unit walks a sales lifecycle (AVAILABLE/HOLD/TOKEN/SOLD),
 * while a plot is simply sellable or not. Keeping them separate is what stops
 * the map from having to know about tokens and holds.
 */
export const PlotStatusSchema = z.enum(['available', 'booked', 'blocked']);
export type PlotStatus = z.infer<typeof PlotStatusSchema>;

/** Row shape for GET /api/inventory/plots. */
export const PlotStatusRowSchema = z.object({
  /** Plot number on the approved layout. 1-113 regular, 114-125 EWS. */
  plotNumber: z.number().int().min(1).max(125),
  status: PlotStatusSchema,
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

/** Plot numbers on the approved CMDA layout. */
export const MIN_PLOT_NUMBER = 1;
export const MAX_PLOT_NUMBER = 125;

/** Every plot number the layout defines, as the strings a unit number compares against. */
export const PLOT_NUMBER_STRINGS: readonly string[] = Array.from(
  { length: MAX_PLOT_NUMBER - MIN_PLOT_NUMBER + 1 },
  (_, index) => String(MIN_PLOT_NUMBER + index),
);

/**
 * Read a unit number as a CMDA plot number, or `null` when it is not one.
 *
 * Strict on purpose, and STRICT IN THE SAME WAY AS THE SQL PRE-FILTER. The
 * backend narrows the query with `unitNumber IN (PLOT_NUMBER_STRINGS)` - the
 * canonical `"1"`..`"125"` spellings - so anything this function accepts that
 * the filter does not is dead code, and anything it refuses that an operator
 * would reasonably write is a plot that silently never maps. Keeping one
 * definition behind both halves is what stops the two from drifting.
 *
 * Therefore a zero-padded `"037"` is refused, not folded onto plot 37: a padded
 * project would not match the filter either, so folding here would only make
 * the two halves disagree about the same string. Name a unit `"37"`.
 *
 * `Number()` alone is not enough whatever the policy: it turns `" "` into 0,
 * `"1e2"` into 100 and `"0x10"` into 16, none of which is a plot number.
 */
export function parsePlotNumber(unitNumber: string): number | null {
  const trimmed = unitNumber.trim();
  if (!/^[0-9]{1,3}$/.test(trimmed)) return null;
  if (trimmed !== String(Number(trimmed))) return null;
  const value = Number(trimmed);
  if (value < MIN_PLOT_NUMBER || value > MAX_PLOT_NUMBER) return null;
  return value;
}

/**
 * Resolve the status of a plot claimed by more than one unit.
 *
 * `Unit` is unique on (phaseId, unitNumber), so two phases of one project can
 * both hold a unit numbered "37". Rather than silently pick one, take the most
 * binding claim - a sold plot must never read available because a different
 * phase has a free unit with the same number.
 */
export function mostBindingPlotStatus(statuses: readonly PlotStatus[]): PlotStatus {
  if (statuses.includes('booked')) return 'booked';
  if (statuses.includes('blocked')) return 'blocked';
  return 'available';
}

/** Runtime guard used by the backend to validate the unit status it reads. */
export { UnitStatusSchema };
