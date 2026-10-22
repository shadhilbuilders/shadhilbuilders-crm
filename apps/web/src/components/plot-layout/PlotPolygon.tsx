'use client';

// One plot's clickable shape.
//
// Everything visual comes from `plot-colors.ts` so the legend, the tooltip
// and the panel can never disagree with the map about what a colour means.

import { memo } from 'react';

import {
  PLOT_DIMMED_OPACITY,
  PLOT_FILL_OPACITY,
  PLOT_SELECTED_FILL,
  PLOT_SELECTED_NUMBER,
  PLOT_STATUS_NUMBER,
  getPlotColor,
} from './plot-colors';
import { polygonCentroid, toPointsAttribute } from './plot-shapes';
import type { Plot } from './plot-types';

export interface PlotPolygonProps {
  plot: Plot;
  selected: boolean;
  /** True when the plot does not match the active search/filter. */
  dimmed: boolean;
  /** Human-readable status/category, used for the accessible name. */
  statusLabel: string;
  categoryLabel: string;
  onSelect: (plotNumber: number) => void;
  onHoverChange: (plotNumber: number | null) => void;
}

/**
 * Font size of the plot number drawn on the fill, in plan units.
 *
 * The drawing prints its own plot number at font-size ~6.2, and the traced
 * polygon is 12.8 x 24.8 units, so 6.2 matches the approved plan's own
 * typography. The number is drawn at the polygon's centroid, which is where
 * the drawing puts it.
 */
const PLOT_NUMBER_FONT_SIZE = 6.2;

function PlotPolygonImpl({
  plot,
  selected,
  dimmed,
  statusLabel,
  categoryLabel,
  onSelect,
  onHoverChange,
}: PlotPolygonProps) {
  const points = toPointsAttribute(plot.boundary);
  const ariaLabel = `Plot ${plot.plotNumber}, ${categoryLabel}, ${statusLabel}`;
  // The area centroid, which is where the approved drawing prints the number.
  const centre = polygonCentroid(plot.boundary);

  return (
    <g
      data-qa="plot-polygon"
      data-plot-number={plot.plotNumber}
      data-plot-status={plot.status}
      opacity={dimmed ? PLOT_DIMMED_OPACITY : 1}
    >
      <polygon
        points={points}
        fill={selected ? PLOT_SELECTED_FILL : getPlotColor(plot.status)}
        fillOpacity={PLOT_FILL_OPACITY}
        stroke="none"
        // Placed AFTER fill/stroke so the class list reads as the interaction
        // contract: hit area, cursor, focus ring.
        className="focus-visible:ring-ring/50 outline-none focus-visible:ring-2"
        style={{
          // Dimmed plots must genuinely stop intercepting clicks, otherwise a
          // filtered-out plot still selects and the filter lies.
          pointerEvents: dimmed ? 'none' : 'auto',
          cursor: dimmed ? 'default' : 'pointer',
        }}
        role="button"
        aria-label={ariaLabel}
        aria-pressed={selected}
        // Negative tabindex keeps the polygon reachable by assistive tech and
        // by the map's arrow-key cursor, without adding 125 stops to the page
        // tab order.
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(plot.plotNumber);
        }}
        // Touch has no hover: a tap would leave the tooltip stuck on screen.
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') onHoverChange(plot.plotNumber);
        }}
        onPointerLeave={() => onHoverChange(null)}
        onFocus={() => onHoverChange(plot.plotNumber)}
        onBlur={() => onHoverChange(null)}
      />
      {/*
        The plot number, drawn on the fill.

        The status fill is opaque, so it hides the number the APPROVED DRAWING
        prints inside the same plot - and the number is the one thing that
        makes a plan readable, so it is re-drawn here, at the area centroid
        (where the drawing prints it) in the plan's own typeface size.

        The colour comes from `PLOT_STATUS_NUMBER`, so it always reads against
        the fill it sits on. A DIMMED plot gets no number: it is excluded by
        the active filter, and a filtered-out plot must not read as a live,
        sellable plot.
      */}
      {dimmed ? null : (
        <text
          x={centre.x}
          y={centre.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={PLOT_NUMBER_FONT_SIZE}
          fontFamily="Helvetica,Arial,sans-serif"
          fontWeight={600}
          fill={selected ? PLOT_SELECTED_NUMBER : PLOT_STATUS_NUMBER[plot.status]}
          pointerEvents="none"
          data-qa="plot-number"
        >
          {plot.plotNumber}
        </text>
      )}
    </g>
  );
}

export const PlotPolygon = memo(PlotPolygonImpl);
