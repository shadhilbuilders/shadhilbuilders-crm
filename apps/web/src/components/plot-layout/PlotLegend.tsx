'use client';

// Colour key for the map.
//
// Every swatch reads from `plot-colors.ts`, so this cannot drift from what the
// polygons are actually painted with - including "Selected", which is a filled
// swatch (`PLOT_SELECTED_FILL`) just like booked and blocked.

import {
  PLOT_FILL_OPACITY,
  PLOT_SELECTED_FILL,
  PLOT_STATUS_FILL,
  PLOT_STATUS_LABEL,
} from './plot-colors';
import type { PlotStatus } from './plot-types';

export interface PlotLegendProps {
  /** How many plots carry each status in the current dataset. */
  counts: Record<PlotStatus, number>;
  /** Plots matching the active filter - shown so the legend reflects the map. */
  matchCount: number;
  totalCount: number;
}

const LEGEND_ORDER: readonly PlotStatus[] = ['available', 'booked', 'blocked'];

export function PlotLegend({ counts, matchCount, totalCount }: PlotLegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-qa="plot-legend">
      {LEGEND_ORDER.map((status) => (
        <span key={status} className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className="border-border inline-block size-3.5 rounded-sm border"
            style={{
              backgroundColor: PLOT_STATUS_FILL[status],
              opacity: Math.max(PLOT_FILL_OPACITY, 0.6),
            }}
          />
          <span className="text-foreground">
            {PLOT_STATUS_LABEL[status]}
            <span className="text-muted-foreground"> ({counts[status]})</span>
          </span>
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-xs">
        <span
          aria-hidden="true"
          className="inline-block size-3.5 rounded-sm"
          style={{
            backgroundColor: PLOT_SELECTED_FILL,
            opacity: Math.max(PLOT_FILL_OPACITY, 0.6),
          }}
        />
        <span className="text-foreground">Selected</span>
      </span>
      <span className="text-muted-foreground ml-auto text-xs">
        {matchCount === totalCount
          ? `${totalCount} plots`
          : `${matchCount} of ${totalCount} plots match`}
      </span>
    </div>
  );
}
