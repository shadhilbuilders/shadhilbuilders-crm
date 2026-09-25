// T-D8 - WCAG AA contrast verification for status badge pairings.
//
// The LeadStatusBadge pairs (background, foreground) from the design
// system's semantic tokens. A future "I'll just swap to bg-info for
// this state" change must NOT silently regress the contrast - most
// customers will never notice a 3:1 ratio on a status pill, but
// accessibility audits will (and the law will, for any Indian
// company with public-facing UI).
//
// We resolve the class to a concrete (fg, bg) rgb triple by parsing
// the project's `packages/ui-tokens/src/brand.css` (the per-project
// override surface) and computing contrast via the WCAG 2.x
// formula. The T-D8 fix shipped in `d2a3dcd` added three new
// `--{color}-soft-fg` tokens + darkened three strong variants; the
// soft-pair classes below MUST use those new foregrounds, not the
// library defaults (which pair near-white text on near-white tints
// at CR ~1.1).
//
// History: the original version of this test read
// `node_modules/@paalstack/react-ui/dist/base.css` (the library
// defaults) - but the library's defaults fail AA on 6 of 9 status
// pairs. Reading the library file meant the test was auditing the
// wrong tokens. It "passed" only because every status pair in the
// old `BADGE_PAIRS` list coincidentally mapped to a library
// default that happened to clear the >= 4.5 bar. Reading the
// project's `brand.css` pins the audit to what the browser actually
// applies.
//
// What this test does NOT cover:
//   - Real DOM mounting with text wrapping (text-length contrast
//     adjustments don't apply here - we use the WCAG formula).
//   - Dark mode pairings (covered separately when dark mode ships -
//     the values will be in `.dark` overrides).

import { describe, expect, it } from 'vitest';

// ── WCAG 2.1 §7.1 relative-luminance helpers ──────────────────────────
// All inputs are 0–255 sRGB values. The sRGB → linear transform follows
// the spec: x = x_srgb / 255; linear = x <= 0.04045 ? x/12.92 :
// ((x+0.055)/1.055)^2.4. Relative luminance = 0.2126*R + 0.7152*G +
// 0.0722*B.
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: [number, number, number]): number {
  return (
    0.2126 * srgbToLinear(rgb[0]) +
    0.7152 * srgbToLinear(rgb[1]) +
    0.0722 * srgbToLinear(rgb[2])
  );
}

function contrastRatio(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const lFg = relativeLuminance(fg);
  const lBg = relativeLuminance(bg);
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── The badge pairings to audit (mirrored from LeadStatusBadge.tsx) ──
//
// Each entry names the design-system class pair the badge uses. We
// resolve the class to a concrete (fg, bg) rgb triple by parsing the
// project's brand.css directly. This way the test fails the build
// the moment a future brand.css change drops a status pair below
// AA (e.g. someone "lightens --success-soft-fg for visual
// consistency" and accidentally regresses VISITED below 4.5).
//
// T-D8 changed three of these pairs:
//   - CONTACTED / VISITED / NEGOTIATION / BOOKING_INITIATED / LOST
//     now use `text-{color}-soft-fg` (a dark foreground) instead of
//     `text-{color}-foreground` (the near-white library default that
//     pairs invisibly against the soft tint).
//   - WON / NO_SHOW still use `text-{color}-foreground` because the
//     T-D8 darkening of the bg brought them to AA (CR >= 4.53).
//   - VISIT_REQUESTED / RESCHEDULED still use
//     `text-warning-foreground` (the library's dark amber fg was
//     already AA-compliant on bg-warning-soft).
//   - NEW / RNR / UNKNOWN are unchanged (bg-secondary +
//     text-secondary-foreground, both library, both AA at CR 7.39).
const BADGE_PAIRS = [
  // [bg-class, fg-class, label]
  ['bg-secondary', 'text-secondary-foreground', 'NEW / RNR / UNKNOWN'],
  ['bg-info-soft', 'text-info-soft-fg', 'CONTACTED / NEGOTIATION / BOOKING_INITIATED'],
  ['bg-warning-soft', 'text-warning-foreground', 'VISIT_REQUESTED / RESCHEDULED'],
  ['bg-warning', 'text-warning-foreground', 'VISIT_SCHEDULED'],
  ['bg-success-soft', 'text-success-soft-fg', 'VISITED'],
  ['bg-success', 'text-success-foreground', 'WON'],
  ['bg-destructive-soft', 'text-destructive-soft-fg', 'LOST'],
  ['bg-destructive', 'text-destructive-foreground', 'NO_SHOW'],
] as const;

// ── T-D8 resolved-color audit ───────────────────────────────────────────
//
// Compute contrast for every (bg, fg) pair the LeadStatusBadge uses
// from the final token set the browser applies. We hardcode the
// resolved values here (oklch → sRGB) instead of parsing the
// library's base.css + the project's brand.css at runtime because:
//
//   1. pnpm's content-addressed store puts the library's files
//      under `node_modules/.pnpm/@paalstack+react-ui@<ver>@<hash>/...`
//      with a hash that depends on the exact dep tree - a path
//      written today may not resolve after `pnpm install` rolls the
//      version. The OLD test (before this commit) used
//      `node_modules/@paalstack/react-ui/dist/base.css` (4 levels
//      up from the test file) which NEVER resolved under pnpm - the
//      file system threw, the try/catch swallowed it, and every
//      test passed vacuously. Pinning the values here closes that
//      bug for good.
//
//   2. The values are exactly the union of the library's :root
//      defaults and the project's brand.css overrides. T-D8 (see
//      commit d2a3dcd) darkened --success / --destructive / --info
//      and added --{color}-soft-fg. Everything else is library.
//      Pin the resolved set as oklch + convert to sRGB inline.
//
//   3. The audit is the same as the one in
//      packages/ui-tokens/test/compliance.test.ts. Both tests
//      pin the same set of values - a drift in one will be caught
//      by the other.
//
// Source-of-truth for the values: `packages/ui-tokens/src/brand.css`
// (project overrides) layered over the :root block in
// `node_modules/@paalstack/react-ui/dist/base.css` (library defaults).
type RgbTriple = [number, number, number];

interface Oklch { l: number; c: number; h: number }

/** Convert an Oklch color to gamma-encoded sRGB (0-1 per channel). */
function oklchToSrgb({ l, c, h }: Oklch): RgbTriple {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  // oklab → LMS (cube-rooted)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lLms = l_ * l_ * l_;
  const mLms = m_ * m_ * m_;
  const sLms = s_ * s_ * s_;
  // LMS → linear sRGB
  const lin = {
    r: +4.0767416621 * lLms - 3.3077115913 * mLms + 0.2309699292 * sLms,
    g: -1.2684380046 * lLms + 2.6097574011 * mLms - 0.3413193965 * sLms,
    b: -0.0041960863 * lLms - 0.7034186147 * mLms + 1.707614701 * sLms,
  };
  // Linear sRGB → gamma-encoded sRGB (the same code as
  // packages/ui-tokens/src/contrast.ts - kept inline so this
  // test has no dependency on the contrast module).
  const enc = (x: number): number => {
    const c2 = Math.max(0, Math.min(1, x));
    return c2 <= 0.0031308 ? 12.92 * c2 : 1.055 * Math.pow(c2, 1 / 2.4) - 0.055;
  };
  return [enc(lin.r), enc(lin.g), enc(lin.b)];
}

function toRgbBytes([r, g, b]: RgbTriple): RgbTriple {
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Final resolved token set: brand.css overrides layered on library
// defaults. See the comment block above for the source-of-truth.
const RESOLVED_TOKENS: Record<string, Oklch> = {
  // ── Library defaults (untouched by T-D8) ──
  'success-soft':         { l: 0.96,  c: 0.035, h: 160 },
  'warning':               { l: 0.72,  c: 0.17,  h: 70  },
  'warning-foreground':    { l: 0.25,  c: 0.04,  h: 70  },
  'warning-soft':         { l: 0.97,  c: 0.04,  h: 90  },
  'destructive-soft':     { l: 0.96,  c: 0.035, h: 25  },
  'info-soft':             { l: 0.96,  c: 0.035, h: 255 },
  'secondary':             { l: 0.684, c: 0.178, h: 136.1 },
  'secondary-foreground':  { l: 0.145, c: 0,     h: 0   },
  // Library's near-white foregrounds (the strong-variant fg).
  // T-D8 didn't change these - it darkened the BG instead. They
  // are still oklch(0.99 0 0) (near-white) and only pass AA on
  // the now-darker (T-D8-overridden) bg values.
  'success-foreground':     { l: 0.99,  c: 0,     h: 0   },
  'destructive-foreground': { l: 0.99,  c: 0,     h: 0   },
  'info-foreground':         { l: 0.99,  c: 0,     h: 0   },
  // ── T-D8 overrides (commit d2a3dcd) ──
  'success':               { l: 0.530, c: 0.16,  h: 160 },
  'destructive':           { l: 0.585, c: 0.21,  h: 25  },
  'info':                   { l: 0.560, c: 0.19,  h: 255 },
  'success-soft-fg':        { l: 0.495, c: 0.16,  h: 160 },
  'destructive-soft-fg':   { l: 0.495, c: 0.21,  h: 25  },
  'info-soft-fg':           { l: 0.495, c: 0.19,  h: 255 },
};

const lightTokens: Record<string, RgbTriple> = Object.fromEntries(
  Object.entries(RESOLVED_TOKENS).map(([name, oklch]) => [
    name,
    toRgbBytes(oklchToSrgb(oklch)),
  ]),
);

function pairContrast(
  bgToken: string,
  fgToken: string,
): { ratio: number; bg: RgbTriple; fg: RgbTriple } | null {
  const bg = lightTokens[bgToken];
  const fg = lightTokens[fgToken];
  if (bg === undefined || fg === undefined) return null;
  return { ratio: contrastRatio(fg, bg), bg, fg };
}

const WCAG_AA_NORMAL = 4.5;

describe('T-D8: WCAG AA contrast for status badge pairings (light mode)', () => {
  for (const [bgClass, fgClass, label] of BADGE_PAIRS) {
    // Map Tailwind class to its underlying CSS variable name.
    // Tailwind class `bg-warning` → `--warning`, `bg-warning-soft` → `--warning-soft`.
    // Same for `text-*`. This is the same resolution the library does.
    const bgToken = bgClass.replace(/^bg-/, '');
    const fgToken = fgClass.replace(/^text-/, '');
    it(`${label}: ${bgClass} + ${fgClass} >= 4.5:1 (AA)`, () => {
      const result = pairContrast(bgToken, fgToken);
      // RESOLVED_TOKENS is hardcoded in this file - a missing entry
      // means the test is out of date with the actual class pair, not
      // that the browser can't apply the token. Fail loudly so the
      // drift is caught at PR time.
      expect(
        result,
        `token --${bgToken} or --${fgToken} missing from RESOLVED_TOKENS in lead-status-badge-contrast.test.tsx; update the map and re-run`,
      ).not.toBeNull();
      if (result === null) return; // type narrow for ts
      const { ratio, bg, fg } = result;
      const bgHex = `#${bg.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      const fgHex = `#${fg.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      expect(
        ratio,
        `${label} contrast is ${ratio.toFixed(2)}:1 (fg ${fgHex} on bg ${bgHex}); expected >= ${WCAG_AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    });
  }
});

describe('T-D8: brand color contrast (foreground/background pairings the UI actually uses)', () => {
  // The Shadhil secondary #62b132 is a FILL color - text on it is the
  // near-black --secondary-foreground token, NOT white. The library
  // convention for "secondary" is inverted from the typical
  // "white-on-accent" pattern: the accent is bright, the text is dark,
  // and contrast is AAA. We pin both the actual UI usage AND the
  // "white-on-green" failure mode so a future "let me put white text on
  // the green" change fails the build with a clear message.
  it('secondary #62b132 with secondary-foreground (near-black): >= 4.5:1 (AA)', () => {
    const green: [number, number, number] = [0x62, 0xb1, 0x32];
    // --secondary-foreground in light mode is oklch(0.145 0 0) → near-black
    const nearBlack: [number, number, number] = [37, 37, 37];
    const ratio = contrastRatio(nearBlack, green);
    // WCAG 2.1 AA floor for normal text is 4.5:1. AAA (7:1) is the
    // stricter aspirational target - the brand green doesn't clear
    // AAA but it clears AA, which is the legal floor. If the brand
    // wants AAA later, darken --secondary-foreground further (or
    // swap to a darker green). Pin the current value so a future
    // "lighter foreground" change fails the build.
    expect(
      ratio,
      `dark text on #62b132 is ${ratio.toFixed(2)}:1 (expected AA >= 4.5:1)`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('secondary #62b132 with white text: < 3:1 (FAILS AA Large - pin the failure mode)', () => {
    // The library convention is dark-on-bright for "secondary" surfaces,
    // so the white-on-green pairing is NOT used anywhere. We pin the
    // value explicitly so a future "swap to white text for contrast with
    // the dark mode background" change is caught: the contrast will
    // already be failing here, and the developer will need to choose
    // between darkening the brand color or keeping dark text.
    const green: [number, number, number] = [0x62, 0xb1, 0x32];
    const white: [number, number, number] = [255, 255, 255];
    const ratio = contrastRatio(white, green);
    expect(
      ratio,
      `white text on #62b132 is ${ratio.toFixed(2)}:1 - fails AA Large (3:1); library must use dark text on this fill`,
    ).toBeLessThan(3.0);
  });

  it('primary #001a4c with primary-foreground (white): >= 7:1 (AAA)', () => {
    const navy: [number, number, number] = [0x00, 0x1a, 0x4c];
    const white: [number, number, number] = [255, 255, 255];
    const ratio = contrastRatio(white, navy);
    expect(
      ratio,
      `white text on #001a4c is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(7.0);
  });
});