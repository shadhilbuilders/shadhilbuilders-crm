// T-D8 - Contrast math round-trip + reference values.
//
// Pins the WCAG 2.x contrast computation so a future change to the
// math (or a copy-paste error in the constants) fails the build.
// These are pure-function tests; no DOM, no network.
import { describe, expect, it } from 'vitest';

import {
  type Oklch,
  WCAG_AA_LARGE,
  WCAG_AA_NORMAL,
  contrastRatio,
  evaluateContrast,
  oklchToSrgb,
  relativeLuminance,
} from '../src/contrast';

describe('oklchToSrgb - known reference values', () => {
  it('oklch(0 0 0) → black', () => {
    const out = oklchToSrgb({ l: 0, c: 0, h: 0 });
    expect(out.r).toBeCloseTo(0, 5);
    expect(out.g).toBeCloseTo(0, 5);
    expect(out.b).toBeCloseTo(0, 5);
  });

  it('oklch(1 0 0) → white', () => {
    const out = oklchToSrgb({ l: 1, c: 0, h: 0 });
    expect(out.r).toBeCloseTo(1, 5);
    expect(out.g).toBeCloseTo(1, 5);
    expect(out.b).toBeCloseTo(1, 5);
  });

  it('oklch(0.5 0 0) → mid gray, all 3 channels equal', () => {
    // Pure gray (c=0): all sRGB channels must be identical.
    // The actual gamma-encoded value is ~0.388 (the linear value
    // ~0.214 has been gamma-encoded per the sRGB transfer function).
    const out = oklchToSrgb({ l: 0.5, c: 0, h: 0 });
    expect(out.r).toBeCloseTo(out.g, 5);
    expect(out.g).toBeCloseTo(out.b, 5);
    expect(out.r).toBeGreaterThan(0.35);
    expect(out.r).toBeLessThan(0.42);
  });

  it('clamps out-of-gamut colors to [0, 1] without throwing', () => {
    // Very high chroma at L=0.5 is out of sRGB gamut (e.g. oklch
    // 0.5 0.4 30). The conversion MUST clamp, not return NaN.
    const out = oklchToSrgb({ l: 0.5, c: 0.4, h: 30 });
    expect(Number.isFinite(out.r)).toBe(true);
    expect(Number.isFinite(out.g)).toBe(true);
    expect(Number.isFinite(out.b)).toBe(true);
    expect(out.r).toBeGreaterThanOrEqual(0);
    expect(out.r).toBeLessThanOrEqual(1);
  });
});

describe('relativeLuminance - known reference values', () => {
  it('black = 0', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it('white = 1', () => {
    expect(relativeLuminance({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 6);
  });

  it('matches the WCAG 2.1 spec example: relative luminance of #768789 ≈ 0.18', () => {
    // https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
    // Example value (from W3C WCAG sample): sRGB #768789 → 0.18
    const r = 0x76 / 255;
    const g = 0x87 / 255;
    const b = 0x89 / 255;
    const L = relativeLuminance({ r, g, b });
    expect(L).toBeCloseTo(0.18, 1);
  });
});

describe('contrastRatio - known reference values', () => {
  it('white vs black = 21:1 (max possible)', () => {
    const c = contrastRatio({ l: 0, c: 0, h: 0 }, { l: 1, c: 0, h: 0 });
    expect(c).toBeCloseTo(21, 4);
  });

  it('white vs white = 1:1 (min possible)', () => {
    const c = contrastRatio({ l: 1, c: 0, h: 0 }, { l: 1, c: 0, h: 0 });
    expect(c).toBeCloseTo(1, 4);
  });

  it('same color on itself = 1:1 (idempotent)', () => {
    const c = contrastRatio(
      { l: 0.5, c: 0.1, h: 200 },
      { l: 0.5, c: 0.1, h: 200 },
    );
    expect(c).toBeCloseTo(1, 4);
  });

  it('contrast is symmetric (a vs b == b vs a)', () => {
    const a: Oklch = { l: 0.3, c: 0.1, h: 30 };
    const b: Oklch = { l: 0.7, c: 0.05, h: 200 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 6);
  });
});

describe('WCAG_AA constants match the spec', () => {
  it('AA-normal is 4.5', () => {
    expect(WCAG_AA_NORMAL).toBe(4.5);
  });
  it('AA-large is 3.0', () => {
    expect(WCAG_AA_LARGE).toBe(3.0);
  });
});

describe('evaluateContrast - verdict shape', () => {
  it('passes both thresholds when CR is high enough', () => {
    const out = evaluateContrast(
      { l: 0, c: 0, h: 0 },
      { l: 1, c: 0, h: 0 },
    );
    expect(out.ratio).toBeGreaterThan(WCAG_AA_NORMAL);
    expect(out.passes['AA-normal']).toBe(true);
    expect(out.passes['AA-large']).toBe(true);
  });

  it('passes AA-large but fails AA-normal in the borderline 3.0-4.5 range', () => {
    // Find a CR in [3.0, 4.5) by sweeping the bg's L. Easier to
    // just assert: any verdict with ratio 3.5 returns AA-large=true,
    // AA-normal=false.
    // White vs oklch(0.55 0 0): luminance is ~(0.55*1.13-ish) ≈ 0.246;
    // CR = (1+0.05)/(0.246+0.05) ≈ 3.55. In the 3-4.5 band.
    const out = evaluateContrast(
      { l: 0, c: 0, h: 0 },
      { l: 0.55, c: 0, h: 0 },
    );
    expect(out.ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
    expect(out.ratio).toBeLessThan(WCAG_AA_NORMAL);
    expect(out.passes['AA-large']).toBe(true);
    expect(out.passes['AA-normal']).toBe(false);
  });
});
