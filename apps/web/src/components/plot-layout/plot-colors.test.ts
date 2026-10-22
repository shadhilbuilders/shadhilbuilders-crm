// The single source of truth for status colours.
//
// If this file changes, the map, the legend, the tooltip and the details
// swatch all change together - which is the point of the module.

import { describe, expect, it } from 'vitest';

import {
  PLOT_DIMMED_OPACITY,
  PLOT_FILL_OPACITY,
  PLOT_SELECTED_NUMBER,
  PLOT_STATUS_FILL,
  PLOT_STATUS_LABEL,
  PLOT_STATUS_NUMBER,
  getPlotColor,
} from './plot-colors';
import { PLOT_GEOMETRY } from './plot-geometry';
import { buildPlots } from './plot-data';
import type { PlotStatus } from './plot-types';

const STATUSES: readonly PlotStatus[] = ['available', 'booked', 'blocked'];

// --- Colour maths, so the test asserts the REASON the palette is what it is
// rather than just restating the hex codes.

/** sRGB component -> linear-light. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toHex(channel: number): string {
  const c = Math.max(0, Math.min(1, channel));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255)
    .toString(16)
    .padStart(2, '0');
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** CIE L*a*b* from sRGB hex. */
function toLab(hex: string): [number, number, number] {
  const rgbParts = rgb(hex);
  const r = toLinear(rgbParts[0]);
  const g = toLinear(rgbParts[1]);
  const b = toLinear(rgbParts[2]);
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const Z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  const f = (t: number) => (t > 6 / 29 ? t ** (1 / 3) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const fx = f(X / 0.95047);
  const fy = f(Y / 1);
  const fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE dE76 - the standard "how different do these look" measure. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const rgbParts = rgb(hex);
  const r = toLinear(rgbParts[0]);
  const g = toLinear(rgbParts[1]);
  const b = toLinear(rgbParts[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Simulate dichromatic vision (Vienot 1999 matrices) and return the
 * simulated hex.
 */
function simulate(hex: string, kind: 'deuteranopia' | 'protanopia'): string {
  const matrices = {
    deuteranopia: [
      [0.625, 0.375, 0],
      [0.7, 0.3, 0],
      [0, 0.3, 0.7],
    ],
    protanopia: [
      [0.567, 0.433, 0],
      [0.558, 0.442, 0],
      [0, 0.242, 0.758],
    ],
  } as const;
  const m = matrices[kind];
  const rgbParts = rgb(hex);
  const r = toLinear(rgbParts[0]);
  const g = toLinear(rgbParts[1]);
  const b = toLinear(rgbParts[2]);
  const R = m[0][0] * r + m[0][1] * g + m[0][2] * b;
  const G = m[1][0] * r + m[1][1] * g + m[1][2] * b;
  const B = m[2][0] * r + m[2][1] * g + m[2][2] * b;
  const enc = (c: number) => {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return `#${toHex(enc(R))}${toHex(enc(G))}${toHex(enc(B))}`;
}

describe('getPlotColor', () => {
  it('returns the specified palette', () => {
    // available = green, booked = red, blocked = gold.
    expect(getPlotColor('available')).toBe('#15803D');
    expect(getPlotColor('booked')).toBe('#DC2626');
    expect(getPlotColor('blocked')).toBe('#E3C563');
  });

  it('gives every status its own colour', () => {
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
});

describe('the status colours are actually distinguishable', () => {
  it('keeps blocked clearly different from booked in NORMAL vision', () => {
    // The reported bug: orange (#EA580C) and red (#DC2626) sit at dE 23.3,
    // which reads as the same colour at a glance. dE 25 is the threshold for
    // "clearly different".
    expect(deltaE(PLOT_STATUS_FILL.blocked, PLOT_STATUS_FILL.booked)).toBeGreaterThan(25);
  });

  it('keeps blocked clearly different from available in NORMAL vision', () => {
    expect(deltaE(PLOT_STATUS_FILL.blocked, PLOT_STATUS_FILL.available)).toBeGreaterThan(25);
  });

  it('keeps blocked different from booked for a red-green colourblind user', () => {
    // This is why blocked is not orange: under deuteranopia, orange and red
    // both render as the same olive (dE 5.7 - indistinguishable).
    for (const kind of ['deuteranopia', 'protanopia'] as const) {
      const d = deltaE(
        simulate(PLOT_STATUS_FILL.blocked, kind),
        simulate(PLOT_STATUS_FILL.booked, kind)
      );
      expect(d).toBeGreaterThan(25);
    }
  });

  it('keeps blocked different from available for a red-green colourblind user', () => {
    for (const kind of ['deuteranopia', 'protanopia'] as const) {
      const d = deltaE(
        simulate(PLOT_STATUS_FILL.blocked, kind),
        simulate(PLOT_STATUS_FILL.available, kind)
      );
      expect(d).toBeGreaterThan(25);
    }
  });
});

describe('the plot number is readable on every status fill', () => {
  it('passes WCAG AA (4.5:1) on every status colour', () => {
    // The plot number is small text, so AA's 4.5:1 applies, not the 3:1 that
    // large text gets. The number's colour follows its fill: white on the
    // dark green and red, dark ink on the light gold.
    for (const status of STATUSES) {
      expect(
        contrast(PLOT_STATUS_FILL[status], PLOT_STATUS_NUMBER[status])
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('passes WCAG AA (4.5:1) on the selected fill', () => {
    expect(contrast('#2563EB', PLOT_SELECTED_NUMBER)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('fill opacity', () => {
  it('paints the status fill opaque, so the plot number reads on it', () => {
    // The plot number sits ON the status fill. A translucent fill would let
    // the drawing show through and the number would be unreadable.
    expect(PLOT_FILL_OPACITY).toBe(1);
  });

  it('paints the number in white on the dark fills and dark ink on the light one', () => {
    expect(PLOT_STATUS_NUMBER.available).toBe('#FFFFFF');
    expect(PLOT_STATUS_NUMBER.booked).toBe('#FFFFFF');
    // A light gold fill cannot carry white text (1.69:1), so it carries a
    // dark number instead - the same rule the app's warning token uses.
    expect(PLOT_STATUS_NUMBER.blocked).toBe('#1F2937');
  });

  it('keeps a dimmed plot translucent and well clear of opaque', () => {
    // A filtered-out plot must still read as "present but excluded", not as a
    // live, sellable plot.
    expect(PLOT_DIMMED_OPACITY).toBeLessThan(PLOT_FILL_OPACITY);
    expect(PLOT_DIMMED_OPACITY).toBeGreaterThan(0);
  });
});

describe('rendered status colours', () => {
  it('paints each plot with its own status colour', () => {
    const plots = buildPlots(PLOT_GEOMETRY, [{ plotNumber: 20, status: 'booked', units: [] }]);
    const booked = plots.find((plot) => plot.plotNumber === 20);
    const available = plots.find((plot) => plot.plotNumber === 21);
    expect(getPlotColor(booked!.status)).toBe('#DC2626');
    expect(getPlotColor(available!.status)).toBe('#15803D');
  });
});
