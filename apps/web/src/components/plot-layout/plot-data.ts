// Merge traced geometry with live availability.
//
// Geometry and availability arrive from different places and are joined here:
// the polygons are a static trace of the approved drawing (`plot-geometry.ts`),
// the statuses come from `GET /api/inventory/plots` via `usePlotStatuses`.
// Nothing in this file invents a status - a plot the API says nothing about is
// `available`, which is the drawing's own default for an unbooked plot.

import type { PlotStatusRow } from '@shadhil/api-types';

import type { Plot, PlotGeometry, PlotStatus } from './plot-types';

/**
 * Merge traced geometry with availability rows into the `Plot[]` the map draws.
 *
 * Rows are matched by plot number. A plot with no row is `available`, and a row
 * for a plot number that does not exist in the geometry is dropped, so a stale
 * or wrong API row can never conjure a plot out of thin air.
 */
export function buildPlots(
  geometry: readonly PlotGeometry[],
  rows: readonly PlotStatusRow[]
): Plot[] {
  const byPlotNumber = new Map<number, PlotStatusRow>();
  for (const row of rows) byPlotNumber.set(row.plotNumber, row);

  return geometry.map((shape) => {
    const row = byPlotNumber.get(shape.plotNumber);
    // `price` is intentionally absent: the drawing states none and no plot
    // price is recorded, so the details panel renders an explicit "Not set"
    // rather than a zero that reads as a real value.
    return {
      id: `plot-${shape.plotNumber}`,
      plotNumber: shape.plotNumber,
      category: shape.category,
      status: row?.status ?? 'available',
      // Measured from the traced polygon - never estimated.
      areaSqFt: Math.round(shape.areaSqM * 10.7639104 * 10) / 10,
      boundary: shape.boundary.map((vertex) => ({ x: vertex.x, y: vertex.y })),
    } satisfies Plot;
  });
}

/** Counts per status, for the legend and the summary line. */
export function countByStatus(plots: readonly Plot[]): Record<PlotStatus, number> {
  const counts: Record<PlotStatus, number> = { available: 0, booked: 0, blocked: 0 };
  for (const plot of plots) counts[plot.status] += 1;
  return counts;
}

/**
 * True when a plot satisfies every active filter.
 *
 * The dataset is the fixed 125-plot layout, so filtering runs in the browser
 * over the full set - there is no server page to be wrong about. A partially
 * typed number is a prefix match ("1" matches 1, 10, 100...) because that is
 * what a user typing a plot number expects while the digits are still going in.
 */
export function plotMatchesFilters(
  plot: Plot,
  filters: { category: Plot['category'] | 'all'; status: PlotStatus | 'all'; query: string }
): boolean {
  if (filters.category !== 'all' && plot.category !== filters.category) return false;
  if (filters.status !== 'all' && plot.status !== filters.status) return false;
  const query = filters.query.trim();
  if (query === '') return true;
  return String(plot.plotNumber).startsWith(query);
}
