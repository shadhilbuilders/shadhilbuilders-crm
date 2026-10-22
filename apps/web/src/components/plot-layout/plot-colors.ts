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
 * These are the literal hex values, exported as literal strings (not CSS
 * custom properties) because they are painted into SVG `fill` attributes
 * inside a single `<svg>`, where the app's semantic tokens are not reachable -
 * and because an SVG export of the map must keep the same colours outside the
 * app's cascade.
 *
 * available = green, booked = red, blocked = gold.
 *
 * WHY blocked is NOT orange. The brief asked for orange, and orange was the
 * first implementation - but orange-600 (#EA580C) and red-600 (#DC2626) are
 * adjacent hues in the same ramp, and they are not distinguishable:
 *
 *   - CIE dE76 between them is 23.3, which is the "noticeable" band, not
 *     "clearly different" (>25). At a glance on the map they read as the same
 *     colour. That was the reported bug.
 *   - Under deuteranopia the gap collapses to dE 5.7 - effectively identical.
 *     #EA580C and #DC2626 both render as the same olive.
 *   - White text on #EA580C is 3.56:1, which fails WCAG AA (4.5:1) for the
 *     plot number.
 *
 * Gold (#E3C563) is the replacement: dE 75.5 from the booked red in normal
 * vision, and dE 27.7 worst-case across normal vision, deuteranopia,
 * protanopia and tritanopia. It is a different hue family from both red and
 * green, and it is the conventional colour for a held or pending state.
 *
 * WHY available is green-700 and not green-600. #16A34A (green-600) carries
 * white text at only 3.30:1, which fails WCAG AA. #15803D (green-700) carries
 * it at 5.02:1, and the two are a barely perceptible step apart (dE 17.6, a
 * difference in lightness only - the hue is identical at 131 degrees).
 */
export const PLOT_STATUS_FILL: Record<PlotStatus, string> = {
  available: '#15803D',
  blocked: '#E3C563',
  booked: '#DC2626',
};

/**
 * The colour the plot NUMBER is painted in, on top of the status fill.
 *
 * The status fills are opaque, so the number needs a colour that reads against
 * the fill it sits on. That colour is NOT the same for every status: a light
 * gold fill cannot carry white text (1.69:1), so the gold carries a DARK
 * number instead, while the green and red fills carry white.
 *
 * This is the same rule the app's own design system uses: its `warning` token
 * pairs a light amber background with a dark foreground.
 */
export const PLOT_STATUS_NUMBER: Record<PlotStatus, string> = {
  available: '#FFFFFF',
  blocked: '#1F2937',
  booked: '#FFFFFF',
};

/** The number colour for the plot that is currently selected. */
export const PLOT_SELECTED_NUMBER = '#FFFFFF';

/**
 * Fill opacity for a plot.
 *
 * Status fills are OPAQUE on purpose. The status colour has to carry the plot
 * number, and the number is unreadable on a translucent fill - whatever the
 * drawing shows through breaks it. The drawing's own printed plot number is
 * hidden by the fill, so the number is re-drawn on top of it in
 * `PLOT_STATUS_NUMBER` - see `plot-shapes.ts` for where it goes.
 *
 * DIMMED plots (excluded by the active filter) are the exception: they stay
 * translucent so the layout does not look broken, and they carry no number,
 * because a filtered-out plot must not shout its number.
 */
export const PLOT_FILL_OPACITY = 1;

/** Opacity of a plot that does not match the active search/filter. */
export const PLOT_DIMMED_OPACITY = 0.12;

/** Fill of the selected plot - painted like the booked/blocked fills, and used by the legend swatch. No selection stroke. */
export const PLOT_SELECTED_FILL = '#2563EB';

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
