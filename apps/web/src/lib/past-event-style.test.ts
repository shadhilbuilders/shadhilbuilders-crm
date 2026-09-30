// T-PAST-VISIT-SURFACE (2026-09-30) - the history view's card surface.
//
// THE REPORT, then five calibration passes: soft background -> diluted -> decent
// -> `-500` -> border-left restored -> "undo background color". The CURRENT state
// is a LIGHT `-50` fill with a STRONG `-500` 4px left accent and dark text.
//
// WHAT THIS FILE GUARDS. Class-string assertions cannot catch the failures this
// treatment can introduce - `bg-green-500 text-white` is well-formed and
// unreadable (2.28:1), and an accent the same colour as its fill is present in
// the markup and invisible on screen. So the contrast test COMPUTES the ratio from
// the palette and the accent test compares shades, rather than trusting that the
// right-looking classes were typed.
import { describe, expect, it } from 'vitest';

import {
  PAST_ACCENT_WIDTH_CLASS,
  PAST_TEXT_ON_FILL,
  pastEventClass,
} from './past-event-style';

const COLOURED_TONES = ['blue', 'green', 'red', 'yellow', 'purple', 'orange'] as const;
const ALL_TONES = [...COLOURED_TONES, 'gray'] as const;

/**
 * Tailwind's default `50` shades (the fill). Hard-coded ON PURPOSE: if the palette
 * moves these must be re-checked by a human, and a test that read the stylesheet
 * at runtime would silently follow a change into an inaccessible combination.
 */
const SHADE_50: Readonly<Record<string, string>> = {
  blue: '#eff6ff',
  green: '#f0fdf4',
  red: '#fef2f2',
  yellow: '#fefce8',
  purple: '#faf5ff',
  orange: '#fff7ed',
};

/** `text-foreground` in the light theme (neutral-950). */
const TEXT_HEX = '#0a0a0a';

function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (
    0.2126 * channelToLinear(r as number) +
    0.7152 * channelToLinear(g as number) +
    0.0722 * channelToLinear(b as number)
  );
}

/** WCAG 2.x contrast ratio between two opaque colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}

describe('pastEventClass - the history surface', () => {
  it('tints the surface LIGHTLY - the `-50` fill, not a `-500` block', () => {
    // "Undo background color" reverted the `-500` fill to the light tint the owner
    // had already accepted as "decent". Asserted so the heavy block cannot creep
    // back on a future pass.
    for (const tone of COLOURED_TONES) {
      const cls = pastEventClass(tone);
      expect(cls, `${tone} is not a light fill`).toContain(`bg-${tone}-50`);
      expect(cls, `${tone} still carries the solid -500 fill`).not.toContain(`bg-${tone}-500`);
    }
  });

  it('carries NO opacity modifier (`/70` was explicitly rejected)', () => {
    for (const tone of ALL_TONES) {
      expect(pastEventClass(tone)).not.toMatch(/bg-[a-z]+-\d+\//);
    }
  });

  it('keeps the 4px LEFT ACCENT the owner asked to restore', () => {
    // Pass 5: "Use previously used border left". UNAFFECTED by the background undo
    // - the two directions are independent, which is the point of keeping fill and
    // accent as separate decisions within one per-tone entry.
    for (const tone of ALL_TONES) {
      expect(pastEventClass(tone), `${tone} has no left accent`).toContain(
        PAST_ACCENT_WIDTH_CLASS,
      );
    }
  });

  it('uses the STRONG -500 shade for the accent, by design', () => {
    // `-500` was too heavy as a full surface and is exactly right as a 4px stripe:
    // the small area is what makes the strong shade work. This is also the literal
    // "previously used border left" treatment, restored rather than reinvented.
    for (const tone of COLOURED_TONES) {
      expect(pastEventClass(tone)).toContain(`border-l-${tone}-500`);
    }
  });

  it('gives the accent a DIFFERENT shade from the fill, or it would not read', () => {
    // The failure this rules out: an accent in the fill's own shade is invisible,
    // and a test that only checked "a border-l class exists" would happily pass it.
    //
    // The negative assertion needs a digit boundary: `border-l-blue-500` CONTAINS
    // the substring `border-l-blue-50`, so a plain `not.toContain` fails on the
    // very class it is meant to allow. (Caught by running it.)
    for (const tone of COLOURED_TONES) {
      const cls = pastEventClass(tone);
      expect(cls).toContain(`border-l-${tone}-500`);
      expect(cls).not.toMatch(new RegExp(`border-l-${tone}-50(?!\\d)`));
      // ... and it is not the frame's neutral, which stays deliberately quiet.
      expect(cls).toContain('border-border');
    }
  });

  // ── THE ASSERTION THAT MATTERS ────────────────────────────────────────────
  it('pairs the light fill with text that passes WCAG AA', () => {
    for (const tone of COLOURED_TONES) {
      const ratio = contrast(SHADE_50[tone] as string, TEXT_HEX);
      expect(
        ratio,
        `${tone}-50 vs the text colour is only ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses DARK text on the light fill (white is the wrong direction here)', () => {
    for (const tone of COLOURED_TONES) {
      const cls = pastEventClass(tone);
      expect(cls).toContain(PAST_TEXT_ON_FILL);
      expect(cls).not.toContain('text-white');
      // The variant's saturated text must be replaced, or the merge could leave it
      // and the row would read loud again.
      expect(cls).not.toMatch(new RegExp(`text-${tone}-\\d00`));
    }
  });

  it('leaves the outcome DOT ALONE - on a light fill its own hue is the cue', () => {
    // THE REVERSAL, made explicit. The `-500`-fill pass had to re-point the dot to
    // `currentColor`, because `fill-{tone}-600` sat adjacent to `bg-{tone}-500` and
    // vanished. On a `-50` fill that same fill is clearly visible, so the override
    // is REMOVED and the variant's dot survives. Asserted rather than merely
    // deleted, so the override cannot silently return.
    for (const tone of ALL_TONES) {
      expect(pastEventClass(tone), `${tone} overrides the dot`).not.toContain('event-dot');
    }
  });

  it('uses LITERAL classes per tone (a composed name would not compile)', () => {
    // Tailwind only emits classes it can see as literal strings. A
    // `bg-${tone}-50` template would work in dev and vanish in the production
    // build, so every tone must map to a complete, literal class.
    for (const tone of ALL_TONES) {
      const cls = pastEventClass(tone);
      expect(cls).toMatch(/bg-[a-z]+-\d+/);
      expect(cls).not.toContain('${');
    }
  });

  it('keeps `gray` muted on BOTH the fill and the stripe', () => {
    // `gray` is unreachable from a real VisitStatus; it exists so a newer backend
    // enum renders neutral. A strong stripe would read as a confident claim about a
    // status we do not understand.
    const cls = pastEventClass('gray');
    expect(cls).toContain('bg-neutral-50');
    expect(cls).toContain('border-l-neutral-400');
    expect(cls).not.toContain('-500');
  });

  it('falls back to the muted neutral for an unknown tone', () => {
    expect(pastEventClass('chartreuse' as never)).toBe(pastEventClass('gray'));
  });

  it('handles dark mode on every tone', () => {
    // The variants set `dark:bg-{tone}-950` and `dark:text-{tone}-300`; without
    // dark overrides those would survive the merge and flip history back to the
    // live treatment at night.
    for (const tone of ALL_TONES) {
      const cls = pastEventClass(tone);
      expect(cls).toContain('dark:bg-');
      expect(cls).toContain('dark:border');
    }
  });
});
