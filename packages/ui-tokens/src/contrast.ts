// T-D8 - WCAG 2.x contrast computation for the shadhil-crm design system.
//
// The oklch → sRGB conversion is the standard sRGB transform from
// CSS Color Module Level 4 (https://www.w3.org/TR/css-color-4/#color-conversion-code).
// The WCAG relative luminance + contrast ratio formulas are from
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio.
//
// Why this lives in @shadhil/ui-tokens (not @paalstack/react-ui):
// the math is shared by every surface (web footer, WhatsApp Cloud
// templates, mobile push titles, landing site) and the audit script
// pinned by the plan's T-D8 verify line lives in
// `packages/ui-tokens/test/compliance.test.ts`. Keeping the math
// here makes the source of truth auditable.

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** Oklch color in CSS Color Module Level 4 ranges. */
export interface Oklch {
  /** Lightness [0, 1]. 0 = black, 1 = white. */
  l: number;
  /** Chroma >= 0. 0 = grayscale, higher = more saturated. */
  c: number;
  /** Hue in degrees [0, 360). Unused when c = 0. */
  h: number;
}

/** sRGB color in [0, 1] per channel. */
export interface Srgb {
  r: number;
  g: number;
  b: number;
}

/* -------------------------------------------------------------------------- */
/*  Oklch → sRGB                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Convert an Oklch color to linear sRGB. May return channels outside
 * [0, 1] for out-of-gamut colors - the caller MUST clamp.
 */
export function oklchToLinearSrgb({ l, c, h }: Oklch): Srgb {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  // Oklab → LMS (cube-rooted)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lLms = l_ * l_ * l_;
  const mLms = m_ * m_ * m_;
  const sLms = s_ * s_ * s_;
  // LMS → linear sRGB
  return {
    r: +4.0767416621 * lLms - 3.3077115913 * mLms + 0.2309699292 * sLms,
    g: -1.2684380046 * lLms + 2.6097574011 * mLms - 0.3413193965 * sLms,
    b: -0.0041960863 * lLms - 0.7034186147 * mLms + 1.707614701 * sLms,
  };
}

/** Clamp + apply the sRGB gamma transfer (linear → gamma-encoded). */
function gamma(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  if (c <= 0.0031308) return 12.92 * c;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Convert Oklch → gamma-encoded sRGB in [0, 1] (clamps out-of-gamut). */
export function oklchToSrgb(color: Oklch): Srgb {
  const lin = oklchToLinearSrgb(color);
  return {
    r: gamma(lin.r),
    g: gamma(lin.g),
    b: gamma(lin.b),
  };
}

/* -------------------------------------------------------------------------- */
/*  WCAG 2.x contrast                                                          */
/* -------------------------------------------------------------------------- */

/** WCAG 2.x relative luminance (sRGB channels in [0, 1]). */
export function relativeLuminance({ r, g, b }: Srgb): number {
  const chan = (c: number): number => {
    if (c <= 0.03928) return c / 12.92;
    return Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/**
 * WCAG 2.x contrast ratio between two colors, in the range [1, 21].
 *   ratio = (L_lighter + 0.05) / (L_darker + 0.05)
 */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = relativeLuminance(oklchToSrgb(a));
  const lb = relativeLuminance(oklchToSrgb(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/* -------------------------------------------------------------------------- */
/*  WCAG AA thresholds                                                        */
/* -------------------------------------------------------------------------- */

/** AA-normal: 4.5:1 for text < 18pt or < 14pt bold. */
export const WCAG_AA_NORMAL = 4.5;

/** AA-large: 3:1 for text >= 18pt or >= 14pt bold, AND for UI components
 *  and graphical objects (icons, form-control borders, focus rings). */
export const WCAG_AA_LARGE = 3.0;

export type AaLevel = 'AA-normal' | 'AA-large';

export interface ContrastVerdict {
  ratio: number;
  passes: Record<AaLevel, boolean>;
}

export function evaluateContrast(
  fg: Oklch,
  bg: Oklch,
): ContrastVerdict {
  const ratio = contrastRatio(fg, bg);
  return {
    ratio,
    passes: {
      'AA-normal': ratio >= WCAG_AA_NORMAL,
      'AA-large': ratio >= WCAG_AA_LARGE,
    },
  };
}
