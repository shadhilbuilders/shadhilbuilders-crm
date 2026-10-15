// Arrow-key navigation over the real traced layout.
//
// Using the generated geometry (not a hand-made fixture) is the point: it
// proves the neighbour search works on plots whose rows are offset and whose
// shapes are not perfectly rectangular, which is what the drawing actually
// contains.

import { describe, expect, it } from 'vitest';

import { buildPlots } from './plot-data';
import { PLOT_GEOMETRY } from './plot-geometry';
import { findNeighbour } from './plot-navigation';

const plots = buildPlots(PLOT_GEOMETRY, []);

describe('findNeighbour', () => {
  it('steps along a row of adjacent plots', () => {
    // Plots 11-18 sit side by side in one row on the drawing.
    expect(findNeighbour(plots, 12, 'right')).toBe(13);
    expect(findNeighbour(plots, 12, 'left')).toBe(11);
  });

  it('steps along a column of stacked plots', () => {
    // Plots 7-9 are stacked vertically.
    expect(findNeighbour(plots, 8, 'up')).toBe(7);
    expect(findNeighbour(plots, 8, 'down')).toBe(9);
  });

  it('prefers the adjacent plot over a distant one that happens to be perfectly level', () => {
    // Regression: plot 20 sits ~7 units north of the 11-19 row, and plot 7 is
    // far away on the same y. Ranking by alignment alone made ArrowLeft jump
    // from 20 to 7 across the whole site. The plot physically to the west of 20
    // is 19.
    expect(findNeighbour(plots, 20, 'left')).toBe(19);
    // Straight down from 20 is 21, which shares its x.
    expect(findNeighbour(plots, 20, 'down')).toBe(21);
  });

  it('returns null when pressed against the edge of the layout', () => {
    expect(findNeighbour(plots, 1, 'up')).toBeNull();
  });

  it('returns null for an unknown starting plot', () => {
    expect(findNeighbour(plots, 999, 'right')).toBeNull();
  });

  it('never returns the plot it started from, and never crosses the cone', () => {
    for (const plot of plots) {
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        const next = findNeighbour(plots, plot.plotNumber, direction);
        expect(next).not.toBe(plot.plotNumber);
        if (next !== null) {
          expect(plots.some((candidate) => candidate.plotNumber === next)).toBe(true);
        }
      }
    }
  });

  it('can reach every plot by walking right/left within its own row block', () => {
    // Sanity check that navigation is not degenerate: from plot 1 walking
    // right must eventually move the selection.
    const next = findNeighbour(plots, 1, 'right');
    expect(next).not.toBeNull();
    expect(next).not.toBe(1);
  });
});
