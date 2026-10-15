// Domain model for the interactive residential plot layout.
//
// The model is deliberately split in two:
//
//   PlotGeometry  - static, traced from the approved CMDA drawing. Never
//                   carries availability. Regenerate only via
//                   `scripts/extract-cmda-layout.py`.
//   Plot          - geometry + live availability, which is what the map
//                   renders and what the API response refreshes.
//
// Keeping availability off the geometry is what lets
// `GET /api/inventory/plots` repaint the map without touching (or re-deriving)
// a single coordinate.
//
// `PlotStatus` itself lives in `@shadhil/api-types`, not here: the backend
// derives it from `UnitStatus` and the web paints it, and two declarations of
// one union is how a status ends up unhandled on one side only.

import type { PlotStatus } from '@shadhil/api-types';

export type { PlotStatus };

/**
 * Which schedule of the approved layout the plot belongs to.
 * `regular` = plots 1-113, `ews` = Economically Weaker Section, plots 114-125.
 */
export type PlotCategory = 'regular' | 'ews';

/** A single vertex in the shared plan coordinate system (SVG user units). */
export interface PlotVertex {
  x: number;
  y: number;
}

/**
 * A plot as rendered by the map: traced geometry plus live availability.
 *
 * `areaSqFt` and `price` are optional because they are only known once a real
 * backend supplies them - the layout drawing carries no sale price and the UI
 * must not invent one. `areaSqM` on the geometry is measured, not estimated
 * (see the `plot-geometry.ts` header).
 */
export interface Plot {
  id: string;
  plotNumber: number;
  category: PlotCategory;
  status: PlotStatus;
  areaSqFt?: number;
  price?: number;
  boundary: PlotVertex[];
}

/** Static geometry for one plot, traced from `docs/CMDA LAYOUT.pdf`. */
export interface PlotGeometry {
  plotNumber: number;
  category: PlotCategory;
  /** Interior point of the plot - used to anchor labels and neighbour navigation. */
  centroid: PlotVertex;
  /** Closed polygon, in plan coordinates. */
  boundary: PlotVertex[];
  /** Measured polygon area, square metres. */
  areaSqM: number;
  /** Max extents of the polygon's minimum bounding rectangle, in feet. */
  measuredSizeFt: { width: number; length: number };
  /** The dimension figures printed inside this plot on the drawing, in feet. */
  printedLabelsFt: readonly number[];
}

/** Filters applied to the map surface. `all` means "do not narrow". */
export interface PlotFilters {
  category: PlotCategory | 'all';
  status: PlotStatus | 'all';
  /** Raw search text - a plot number, or a partial one. */
  query: string;
}
