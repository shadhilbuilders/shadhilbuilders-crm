// The single source of truth for status colours.
//
// If this file changes, the map, the legend, the tooltip and the details
// swatch all change together - which is the point of the module.

import { describe, expect, it } from 'vitest';

import {
  PLOT_FILL_OPACITY,
  PLOT_STATUS_FILL,
  PLOT_STATUS_LABEL,
  getPlotColor,
} from './plot-colors';
import { PLOT_GEOMETRY } from './plot-geometry';
import { buildPlots } from './plot-data';
import type { PlotStatus } from './plot-types';

const STATUSES: readonly PlotStatus[] = ['available', 'booked', 'blocked'];

describe('getPlotColor', () => {
  it('returns the specified palette', () => {
    expect(getPlotColor('available')).toBe('#9CA3AF');
    expect(getPlotColor('booked')).toBe('#16A34A');
  });

  it('gives blocked a colour distinct from available and booked', () => {
    const colours = STATUSES.map(getPlotColor);
    expect(new Set(colours).size).toBe(STATUSES.length);
  });

  it('is the same map the raw table exposes', () => {
    for (const status of STATUSES) {
      expect(getPlotColor(status)).toBe(PLOT_STATUS_FILL[status]);
    }
  });

  it('has a label for every status', () => {
    for (const status of STATUSES) {
      expect(PLOT_STATUS_LABEL[status]).toBeTruthy();
    }
  });

  it('keeps fills translucent enough to read the drawing through them', () => {
    expect(PLOT_FILL_OPACITY).toBeGreaterThan(0.1);
    expect(PLOT_FILL_OPACITY).toBeLessThan(0.5);
  });
});

describe('rendered status colours', () => {
  it('paints each plot with its own status colour', () => {
    const plots = buildPlots(PLOT_GEOMETRY, [{ plotNumber: 20, status: 'booked', units: [] }]);
    const booked = plots.find((plot) => plot.plotNumber === 20);
    const available = plots.find((plot) => plot.plotNumber === 21);
    expect(getPlotColor(booked!.status)).toBe('#16A34A');
    expect(getPlotColor(available!.status)).toBe('#9CA3AF');
  });
});
