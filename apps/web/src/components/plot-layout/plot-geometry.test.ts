// Integrity tests for the traced plot geometry.
//
// `plot-geometry.ts` is generated, so this file is the guard that the
// extraction stayed honest: every plot number present exactly once, the
// regular/EWS split the drawing states, and polygons that are actually
// polygons. A bad regeneration fails here instead of shipping a map with a
// plot in the wrong place.

import { describe, expect, it } from 'vitest';

import { PLOT_GEOMETRY, PLAN_SOURCE, PLAN_VIEWBOX } from './plot-geometry';
import { polygonBounds, polygonCentroid } from './plot-shapes';

describe('PLOT_GEOMETRY', () => {
  it('has exactly the 125 plots the drawing states', () => {
    expect(PLOT_GEOMETRY).toHaveLength(125);
    expect(PLAN_SOURCE.regularPlots + PLAN_SOURCE.ewsPlots).toBe(125);
  });

  it('covers plot numbers 1-125 exactly once', () => {
    const numbers = PLOT_GEOMETRY.map((plot) => plot.plotNumber);
    expect(new Set(numbers).size).toBe(125);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(125);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('splits regular (1-113) and EWS (114-125) as the drawing does', () => {
    const regular = PLOT_GEOMETRY.filter((plot) => plot.category === 'regular');
    const ews = PLOT_GEOMETRY.filter((plot) => plot.category === 'ews');
    expect(regular).toHaveLength(113);
    expect(ews).toHaveLength(12);
    expect(Math.min(...ews.map((plot) => plot.plotNumber))).toBe(114);
    expect(Math.max(...ews.map((plot) => plot.plotNumber))).toBe(125);
  });

  it('describes every plot with a real, positively-sized polygon', () => {
    for (const plot of PLOT_GEOMETRY) {
      expect(plot.boundary.length, `plot ${plot.plotNumber} vertex count`).toBeGreaterThanOrEqual(
        3
      );
      expect(Number.isFinite(plot.areaSqM)).toBe(true);
      expect(plot.areaSqM, `plot ${plot.plotNumber} area`).toBeGreaterThan(20);
      for (const vertex of plot.boundary) {
        expect(Number.isFinite(vertex.x)).toBe(true);
        expect(Number.isFinite(vertex.y)).toBe(true);
      }
    }
  });

  it('anchors every centroid inside its own polygon bounds', () => {
    for (const plot of PLOT_GEOMETRY) {
      const bounds = polygonBounds(plot.boundary);
      expect(plot.centroid.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(plot.centroid.x).toBeLessThanOrEqual(bounds.maxX);
      expect(plot.centroid.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(plot.centroid.y).toBeLessThanOrEqual(bounds.maxY);
      // Stored centroid must agree with what the polygon implies, or labels
      // and neighbour navigation would disagree with the shape on screen.
      const derived = polygonCentroid(plot.boundary);
      expect(Math.abs(derived.x - plot.centroid.x)).toBeLessThan(1);
      expect(Math.abs(derived.y - plot.centroid.y)).toBeLessThan(1);
    }
  });

  it('keeps every polygon inside the plan viewBox', () => {
    for (const plot of PLOT_GEOMETRY) {
      const bounds = polygonBounds(plot.boundary);
      expect(bounds.minX).toBeGreaterThanOrEqual(PLAN_VIEWBOX.x);
      expect(bounds.maxX).toBeLessThanOrEqual(PLAN_VIEWBOX.x + PLAN_VIEWBOX.width);
      expect(bounds.minY).toBeGreaterThanOrEqual(PLAN_VIEWBOX.y);
      expect(bounds.maxY).toBeLessThanOrEqual(PLAN_VIEWBOX.y + PLAN_VIEWBOX.height);
    }
  });

  it("sums to the drawing's own plottable area (12421 - 1269 OSR - 133 public purpose)", () => {
    const total = PLOT_GEOMETRY.reduce((sum, plot) => sum + plot.areaSqM, 0);
    // 11019 sq.m is what the approved area statement implies for the plots.
    // 1% tolerance - this is a check on the trace, not a survey.
    expect(total).toBeGreaterThan(11019 * 0.99);
    expect(total).toBeLessThan(11019 * 1.01);
  });

  it('places named plots where the drawing puts them (catches a coordinate-transform error)', () => {
    // A page-rotation or scaling bug moves EVERY plot together, so a
    // bounds check still passes while the whole overlay sits rotated away
    // from the artwork. These coordinates come from the trace, verified
    // against the rendered drawing: every polygon's perimeter lands on drawn
    // ink. Pinning a few anchors is what makes such a regression fail loudly.
    const anchor = (plotNumber: number) => {
      const plot = PLOT_GEOMETRY.find((candidate) => candidate.plotNumber === plotNumber);
      expect(plot, `plot ${plotNumber}`).toBeDefined();
      return plot!.centroid;
    };
    expect(anchor(1).x).toBeCloseTo(248.02, 1);
    expect(anchor(1).y).toBeCloseTo(246.31, 1);
    expect(anchor(20).x).toBeCloseTo(399.88, 1);
    expect(anchor(20).y).toBeCloseTo(349.33, 1);
    expect(anchor(114).x).toBeCloseTo(438.51, 1);
    expect(anchor(114).y).toBeCloseTo(568.33, 1);
    expect(anchor(125).x).toBeCloseTo(268.66, 1);
    expect(anchor(125).y).toBeCloseTo(314.58, 1);
  });

  it('keeps the drawing the right way up: the low-numbered rows sit north of the high-numbered ones', () => {
    // Plot 1 is in the northern row (smaller y) and plots 85-96 run along the
    // southern edge. If the page's 270 degree rotation were dropped or applied
    // twice, this ordering inverts - so it is a cheap orientation guard.
    const plot1 = PLOT_GEOMETRY.find((plot) => plot.plotNumber === 1)!;
    const plot85 = PLOT_GEOMETRY.find((plot) => plot.plotNumber === 85)!;
    expect(plot85.centroid.y).toBeGreaterThan(plot1.centroid.y);
    expect(plot85.centroid.y).toBeLessThan(PLAN_VIEWBOX.y + PLAN_VIEWBOX.height);
  });

  it('carries at least one printed dimension for most plots', () => {
    const withLabels = PLOT_GEOMETRY.filter((plot) => plot.printedLabelsFt.length > 0);
    // The drawing prints a side on the shared wall between neighbours, so a
    // few plots legitimately carry none.
    expect(withLabels.length).toBeGreaterThan(100);
  });
});

describe('PLAN_VIEWBOX', () => {
  it('matches the traced artwork, not an arbitrary canvas', () => {
    expect(PLAN_VIEWBOX.width).toBeGreaterThan(0);
    expect(PLAN_VIEWBOX.height).toBeGreaterThan(0);
    // Roughly A3 landscape proportions after the page's 270 deg rotation.
    const aspect = PLAN_VIEWBOX.width / PLAN_VIEWBOX.height;
    expect(aspect).toBeGreaterThan(1.0);
    expect(aspect).toBeLessThan(1.4);
  });
});
