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
  getPlotColor,
} from './plot-colors';
import { toPointsAttribute } from './plot-shapes';
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
        onPointerEnter={() => onHoverChange(plot.plotNumber)}
        onPointerLeave={() => onHoverChange(null)}
        onFocus={() => onHoverChange(plot.plotNumber)}
        onBlur={() => onHoverChange(null)}
      />
    </g>
  );
}

export const PlotPolygon = memo(PlotPolygonImpl);
