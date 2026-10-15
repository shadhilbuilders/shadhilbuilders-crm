// Keyboard navigation between plots.
//
// 125 plots is far too many tab stops, so the map exposes ONE focusable
// element and arrow keys move the selection across the plan. Picking the
// neighbour by geometry (not array order) is what makes that feel like
// walking the layout instead of stepping through a list.

import { polygonCentroid } from './plot-shapes';
import type { Plot } from './plot-types';

export type PlotDirection = 'up' | 'down' | 'left' | 'right';

const DIRECTION_VECTOR: Record<PlotDirection, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * How much a plot's off-axis offset counts against it.
 *
 * Scoring is `along + perpendicular * DIAGONAL_PENALTY`, i.e. near and roughly
 * level beats far and perfectly level. Ranking on perpendicular offset alone
 * looks reasonable and is wrong: the layout has rows offset by a few units, so
 * a plot two metres away and slightly off-axis lost to one at the far end of
 * the site that happened to share its exact y. Arrow keys jumped across the
 * drawing.
 */
const DIAGONAL_PENALTY = 2;

/**
 * Nearest plot from `fromPlotNumber` in `direction`.
 *
 * Candidates must lie ahead of the origin (positive projection on the
 * direction) and inside a 45 degree cone - without the cone, an arrow press
 * that leaves a row would jump to a plot across the site. Ties break on the
 * along-axis distance.
 */
export function findNeighbour(
  plots: readonly Plot[],
  fromPlotNumber: number,
  direction: PlotDirection
): number | null {
  const origin = plots.find((plot) => plot.plotNumber === fromPlotNumber);
  if (origin === undefined) return null;
  const from = polygonCentroid(origin.boundary);
  const vector = DIRECTION_VECTOR[direction];

  let best: number | null = null;
  let bestScore = Infinity;
  let bestAlong = Infinity;

  for (const plot of plots) {
    if (plot.plotNumber === fromPlotNumber) continue;
    const point = polygonCentroid(plot.boundary);
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const along = dx * vector.x + dy * vector.y;
    if (along <= 0.5) continue;
    const perpendicular = Math.abs(dx * vector.y - dy * vector.x);
    if (perpendicular > along) continue; // outside the 45 degree cone
    const score = along + perpendicular * DIAGONAL_PENALTY;
    const better = score < bestScore - 0.001;
    const tieButNearer = Math.abs(score - bestScore) <= 0.001 && along < bestAlong;
    if (best === null || better || tieButNearer) {
      best = plot.plotNumber;
      bestScore = score;
      bestAlong = along;
    }
  }

  return best;
}
