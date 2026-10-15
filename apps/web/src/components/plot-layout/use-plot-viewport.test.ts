// Zoom/pan maths.
//
// The invariants that matter: zoom never distorts the drawing's aspect ratio,
// the viewport never leaves the plan (or a user could pan into blank space
// with no way back), and zooming about a point keeps that point still - which
// is what makes cursor-anchored wheel zoom feel right.

import { describe, expect, it } from 'vitest';

import { PLAN_VIEWBOX } from './plot-geometry';
import {
  MAX_PLOT_ZOOM,
  MIN_PLOT_ZOOM,
  centreOnPoint,
  clampViewport,
  viewBoxFor,
  zoomAtPoint,
  type PlotViewport,
} from './use-plot-viewport';

const PLAN_ASPECT = PLAN_VIEWBOX.width / PLAN_VIEWBOX.height;
const FULL: PlotViewport = { zoom: 1, x: PLAN_VIEWBOX.x, y: PLAN_VIEWBOX.y };

describe('viewBoxFor', () => {
  it('shows the whole plan at 1x', () => {
    const box = viewBoxFor(FULL);
    expect(box.width).toBeCloseTo(PLAN_VIEWBOX.width, 6);
    expect(box.height).toBeCloseTo(PLAN_VIEWBOX.height, 6);
  });

  it('keeps the plan aspect ratio at every zoom level', () => {
    for (const zoom of [1, 1.7, 4, 9, MAX_PLOT_ZOOM]) {
      const box = viewBoxFor({ ...FULL, zoom });
      expect(box.width / box.height).toBeCloseTo(PLAN_ASPECT, 6);
    }
  });
});

describe('clampViewport', () => {
  it('holds the zoom inside its range', () => {
    expect(clampViewport({ ...FULL, zoom: 0.1 }).zoom).toBe(MIN_PLOT_ZOOM);
    expect(clampViewport({ ...FULL, zoom: 1000 }).zoom).toBe(MAX_PLOT_ZOOM);
  });

  it('keeps the visible window inside the plan', () => {
    const clamped = clampViewport({ zoom: 4, x: -9999, y: 9999 });
    const box = viewBoxFor(clamped);
    expect(box.x).toBeGreaterThanOrEqual(PLAN_VIEWBOX.x);
    expect(box.y).toBeGreaterThanOrEqual(PLAN_VIEWBOX.y);
    expect(box.x + box.width).toBeLessThanOrEqual(PLAN_VIEWBOX.x + PLAN_VIEWBOX.width + 1e-6);
    expect(box.y + box.height).toBeLessThanOrEqual(PLAN_VIEWBOX.y + PLAN_VIEWBOX.height + 1e-6);
  });
});

describe('zoomAtPoint', () => {
  it('leaves the anchor point exactly where it was', () => {
    const anchor = { x: 400, y: 350 };
    for (const factor of [1.5, 2, 0.7, 0.5]) {
      const before = zoomAtPoint({ ...FULL, zoom: 3 }, factor, anchor);
      const boxBefore = viewBoxFor({ ...FULL, zoom: 3 });
      const boxAfter = viewBoxFor(before);
      const relativeBefore = (anchor.x - boxBefore.x) / boxBefore.width;
      const relativeAfter = (anchor.x - boxAfter.x) / boxAfter.width;
      expect(relativeAfter).toBeCloseTo(relativeBefore, 6);
    }
  });

  it('is a no-op when already at the zoom limit', () => {
    const atMax: PlotViewport = {
      zoom: MAX_PLOT_ZOOM,
      x: PLAN_VIEWBOX.x,
      y: PLAN_VIEWBOX.y,
    };
    expect(zoomAtPoint(atMax, 2, { x: 300, y: 300 })).toEqual(atMax);
  });
});

describe('centreOnPoint', () => {
  it('puts the point at the middle of the visible window', () => {
    const point = { x: 300, y: 350 };
    const box = viewBoxFor(clampViewport(centreOnPoint(point, 4)));
    // The clamp may shift it at the plan edge; this point is interior.
    expect(box.x + box.width / 2).toBeCloseTo(point.x, 4);
    expect(box.y + box.height / 2).toBeCloseTo(point.y, 4);
  });

  it('clamps the requested zoom into range', () => {
    expect(centreOnPoint({ x: 300, y: 350 }, 1000).zoom).toBe(MAX_PLOT_ZOOM);
    expect(centreOnPoint({ x: 300, y: 350 }, 0.01).zoom).toBe(MIN_PLOT_ZOOM);
  });
});
