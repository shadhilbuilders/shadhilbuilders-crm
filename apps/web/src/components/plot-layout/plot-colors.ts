// The one place a plot status becomes a colour.
//
// Every surface that paints a plot reads from here: the polygon fill, the
// hover tooltip, the details panel swatch, the legend, and any list that
// grows later. Two copies of this map is how a legend ends up saying
// "booked = green" while the map paints a booked plot grey.

import type { PlotCategory, PlotStatus } from './plot-types';

/**
 * Fill colour per status.
 *
 * These are the literal hex values the brief specifies. They are exported as
 * literal strings (not CSS custom properties) because they are painted into
 * SVG `fill` attributes inside a single `<svg>`, where the app's semantic
 * tokens are not reachable - and because an SVG export of the map must keep
 * the same colours outside the app's cascade.
 */
export const PLOT_STATUS_FILL: Record<PlotStatus, string> = {
  available: '#9CA3AF',
  booked: '#16A34A',
  blocked: '#DC2626',
};

/**
 * Fill opacity for every plot. Kept low on purpose: the drawing's own plot
 * number, dimension figures and boundary lines must stay readable through the
 * fill. Raising this above ~0.5 starts hiding the printed dimensions.
 */
export const PLOT_FILL_OPACITY = 0.34;

/**
 * The map sheet colour.
 *
 * Repeats the `bg-white` on the map's `<svg>` as a literal, because an SVG
 * `stroke`/`fill` attribute cannot read the app's CSS tokens. If the sheet in
 * `PlotMap.tsx` changes, change this with it.
 */
export const PLOT_MAP_BACKGROUND = '#2563EB';

/** Fill of the selected plot - painted like the booked/blocked fills, and used by the legend swatch. No selection stroke. */
export const PLOT_SELECTED_FILL = '#2563EB';

/**
 * Opacity applied to a plot that does not match the active search/filter.
 * Dimmed plots stay visible (the layout must not look broken) but stop
 * accepting pointer events, so a filter genuinely narrows the map.
 */
export const PLOT_DIMMED_OPACITY = 0.12;

/**
 * Centralised status -> colour lookup. Use this instead of indexing
 * `PLOT_STATUS_FILL` directly so a future palette change (or a
 * status-aware override) has exactly one seam.
 */
export function getPlotColor(status: PlotStatus): string {
  return PLOT_STATUS_FILL[status];
}

/** Human-readable status names, shared by the legend, tooltip and details panel. */
export const PLOT_STATUS_LABEL: Record<PlotStatus, string> = {
  available: 'Available',
  booked: 'Booked',
  blocked: 'Blocked',
};

/** Human-readable category names. */
export const PLOT_CATEGORY_LABEL: Record<PlotCategory, string> = {
  regular: 'Regular plot',
  ews: 'EWS plot',
};
