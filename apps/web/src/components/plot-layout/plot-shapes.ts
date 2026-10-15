// Polygon maths for plot hit areas.
//
// Derived from the boundary itself rather than stored on `Plot`, so the data
// model stays exactly as specified and a plot supplied by a future API (with
// no centroid field) still works.

import type { PlotVertex } from './plot-types';

/** SVG `points` attribute for a closed polygon. */
export function toPointsAttribute(boundary: readonly PlotVertex[]): string {
  return boundary.map((vertex) => `${vertex.x},${vertex.y}`).join(' ');
}

/**
 * Area-weighted centroid of a simple polygon, with a vertex-average fallback
 * for degenerate (zero-area) rings. Used to anchor labels and tooltips.
 */
export function polygonCentroid(boundary: readonly PlotVertex[]): PlotVertex {
  if (boundary.length === 0) return { x: 0, y: 0 };
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < boundary.length; i += 1) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    if (a === undefined || b === undefined) continue;
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (twiceArea === 0) {
    const sum = boundary.reduce((acc, vertex) => ({ x: acc.x + vertex.x, y: acc.y + vertex.y }), {
      x: 0,
      y: 0,
    });
    return { x: sum.x / boundary.length, y: sum.y / boundary.length };
  }
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

/** Axis-aligned bounds of a polygon. */
export function polygonBounds(boundary: readonly PlotVertex[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const vertex of boundary) {
    if (vertex.x < minX) minX = vertex.x;
    if (vertex.y < minY) minY = vertex.y;
    if (vertex.x > maxX) maxX = vertex.x;
    if (vertex.y > maxY) maxY = vertex.y;
  }
  return { minX, minY, maxX, maxY };
}
