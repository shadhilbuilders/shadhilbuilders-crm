// Past-visit presentation (2026-09-30).
//
// WHAT THE OWNER SAW. On the visits page with "Show past visits" on, a VISITED
// or WON lead's event card rendered as a solid coloured block because the card's
// surface came from the VISIT's status - COMPLETED is green. His words: "when i
// select show past visits, for Arjun Reddy lead status was won but in visit card
// background color shows green".
//
// OWNER DIRECTION, in six passes on one appearance call:
//   1. the past view used the live card's treatment (full `-50` fill +
//      saturated `text-{tone}-700`) -> a wall of loud colour on every row;
//   2. colour moved off the surface onto a 4px left border -> "I want soft
//      background color instead of border color in visit page";
//   3. tint back on the surface, diluted to `bg-{tone}-50/70` -> "I don't want
//      so soft background color, i want decent background color";
//   4. fill at full `-50` -> then "Use *-500";
//   5. -> "Use previously used border left" (the 4px accent from step 2 returns);
//   6. -> "Undo background color".
//
// STEP 6, AS READ HERE: undo the `-500` BACKGROUND (step 4/5), keeping the accent
// the owner asked for in step 5. So the fill is back to the step-4 `-50` tint -
// the "decent background color" they accepted - and the accent is the
// "previously used" `border-l-{tone}-500` from step 2.
//
// THE OTHER READING, recorded because it is one word away: "undo background
// color" could mean strip the background entirely (the step-2 neutral row). That
// would be `bg-card` instead of `bg-{tone}-50` below, and nothing else changes.
// Say the word and it is a one-line edit to PAST_TONE_SURFACE.
//
// THE SEQUENCE IS RECORDED because it is the useful part: this is a call the
// owner is calibrating by eye, and the next reader should not have to re-derive
// why the fill is a light tint while the accent is a strong stripe.
//
// SO THE HISTORY CARD IS: LIGHT `-50` FILL + STRONG 4px LEFT ACCENT + DARK TEXT.
// Three things follow, and each is MEASURED rather than assumed
// (`past-event-style.test.ts` re-computes the WCAG contrast from the palette):
//
//   1. THE TEXT IS DARK (`text-foreground`, near-black). On a `-50` fill that is
//      an 18:1 pairing. White would fail, so the direction is asserted, not
//      assumed - a future "make it pop" edit that lightened the text breaks the
//      test rather than shipping an unreadable row.
//   2. THE ACCENT IS `-500`, WHICH IS THE POINT OF IT. `-500` was too strong as a
//      FILL and is exactly right as a 4px STRIPE: the small area is what makes the
//      strong shade work. It is also the literal "previously used border left",
//      so the class restored here is the one that shipped in step 2.
//   3. THE DOT KEEPS ITS OWN HUE FILL. Unlike the `-500`-fill attempt, where
//      `fill-{tone}-600` was adjacent to the surface and invisible, on a light
//      `-50` fill the variant's own dot IS the visible cue. This module therefore
//      deliberately does NOT override `[&_.event-dot]` - and a test asserts that,
//      because the previous pass added the override and the reversal must be
//      explicit.
//
// NOTE ON THE SHADE. Tailwind only emits classes it can see as literal strings,
// so the fill and accent shades CANNOT be composed from a variable
// (`bg-${tone}-50` compiles to nothing). Changing a shade means editing every
// entry of PAST_TONE_SURFACE - which is exactly why the map is small, literal and
// grouped by tone rather than split across helpers.
//
// THE LIVE CALENDAR IS UNTOUCHED by any of this: it keeps the `-50` tint, the
// saturated text/frame and no accent, because there the colour answers "did this
// visit happen yet" and should read as a tint rather than a flagged row.
//
// WHY THIS LIVES HERE, NOT IN THE CARD COMPONENTS. The three card components
// (agenda, week/day block, month badge) are VENDORED from lramos33/big-calendar
// and take a `color` variant; none of them knows what "past" means. This module
// is the app's own layer over them: one place that decides how history looks, so
// the three surfaces cannot drift.

import { labelFor, VISIT_STATUSES } from '@/lib/labels';
import { VISIT_STATUS_COLOR } from '@/lib/visit-status';

import type { TEventColor } from '@/components/calendar/types';

/**
 * The per-tone surface of a history card: a light `-50` fill, a neutral hairline
 * frame, and a strong `-500` left accent.
 *
 * Fill, frame and accent are kept TOGETHER per tone because they are one
 * decision - a light fill needs a strong stripe to be scannable, and pairing them
 * anywhere else is how the accent drifts to a shade that either vanishes or
 * shouts.
 */
const PAST_TONE_SURFACE: Readonly<Record<TEventColor, string>> = {
  blue: 'bg-blue-50 border-border border-l-blue-500 dark:bg-blue-950 dark:border-border dark:border-l-blue-500',
  green:
    'bg-green-50 border-border border-l-green-500 dark:bg-green-950 dark:border-border dark:border-l-green-500',
  red: 'bg-red-50 border-border border-l-red-500 dark:bg-red-950 dark:border-border dark:border-l-red-500',
  yellow:
    'bg-yellow-50 border-border border-l-yellow-500 dark:bg-yellow-950 dark:border-border dark:border-l-yellow-500',
  purple:
    'bg-purple-50 border-border border-l-purple-500 dark:bg-purple-950 dark:border-border dark:border-l-purple-500',
  orange:
    'bg-orange-50 border-border border-l-orange-500 dark:bg-orange-950 dark:border-border dark:border-l-orange-500',
  // `gray` is unreachable from a real VisitStatus - it exists so a newer backend
  // enum renders neutral instead of falsely coloured - so it stays muted on both
  // the fill and the stripe.
  gray: 'bg-neutral-50 border-border border-l-neutral-400 dark:bg-neutral-900 dark:border-border dark:border-l-neutral-400',
};

/**
 * The 4px left accent - the "previously used border left" the owner asked to
 * restore. Width only; the colour is per-tone in {@link PAST_TONE_SURFACE}.
 */
export const PAST_ACCENT_WIDTH_CLASS = 'border-l-4';

/**
 * The text colour a history card uses.
 *
 * Dark, because the fill is light: `text-foreground` (near-black in the light
 * theme) on a `-50` fill is an ~18:1 pairing, and white would fail. Exported so
 * the test asserts the measured PAIRING rather than a class string alone.
 */
export const PAST_TEXT_ON_FILL = 'text-foreground';

/**
 * The tone a history card's surface carries - the visit's, since that is the
 * record being shown. Exposed so a caller never has to guess which axis history
 * is keyed on (the card's `color` already is the visit's status; this makes that
 * explicit at the call site).
 */
export function pastEventTone(eventColor: TEventColor): TEventColor {
  return eventColor;
}

/**
 * The full class string for a history card: a light outcome tint, a neutral
 * frame, a strong 4px left accent and dark text.
 *
 * NOTE what is deliberately absent: any `[&_.event-dot]` override. On a `-50`
 * fill the variant's own `fill-{tone}-600` dot is the visible cue, so it is left
 * alone - the opposite of the `-500`-fill attempt, and asserted by test.
 */
export function pastEventClass(tone: TEventColor): string {
  const surface = PAST_TONE_SURFACE[tone] ?? PAST_TONE_SURFACE.gray;
  return `${surface} ${PAST_ACCENT_WIDTH_CLASS} ${PAST_TEXT_ON_FILL}`;
}

// ────────────────────────────────────────────────────────────────────────────
// The LEGEND (2026-09-30)
// ────────────────────────────────────────────────────────────────────────────
//
// "I don't understand what each colors means in visits page card." The calendar
// encoded the visit outcome in colour and never said so anywhere. A colour that
// has to be reverse-engineered from the source is not communication.
//
// DERIVED, NOT WRITTEN BY HAND. The entries come from `VISIT_STATUSES` (the
// app's own list of the five `SiteVisit.status` values, in status-machine
// order), the words from `labelFor('visit', …)` (the existing friendly
// vocabulary: "Visit booked", "Done", "Didn't show up"), and the tones from
// `VISIT_STATUS_COLOR` - the SAME map the calendar paints from. So the legend
// cannot drift from the picture: add a status there and it appears here, change
// a tone and the swatch follows.
//
// That is the whole point. A hand-written legend is the failure mode where the
// key and the thing it explains quietly disagree, and the reader has no way to
// find out which one is lying.

export type VisitLegendEntry = {
  /** The `SiteVisit.status` this entry explains. Drives the test's coverage check. */
  status: string;
  /** The friendly word, from the shared label map. */
  label: string;
  /** The tone the calendar paints it - read off the real map. */
  tone: TEventColor;
  /** What the colour MEANS, in a sentence. Not derivable; this is the content. */
  meaning: string;
};

/**
 * What each colour means, as a sentence.
 *
 * This is the part a map cannot provide - the calendar's tones are the visit's
 * outcome, and the sentence is what turns "yellow" from a mystery into
 * "the visit was moved to a new slot".
 */
const LEGEND_MEANING: Readonly<Record<string, string>> = {
  SCHEDULED: 'Booked and still to happen',
  RESCHEDULED: 'Was moved to a new slot',
  COMPLETED: 'The visit happened',
  NO_SHOW: 'The customer did not turn up',
  CANCELLED: 'The visit was called off',
};

export const VISIT_LEGEND: readonly VisitLegendEntry[] = VISIT_STATUSES.map((status) => ({
  status,
  label: labelFor('visit', status),
  tone: VISIT_STATUS_COLOR[status] ?? 'gray',
  meaning: LEGEND_MEANING[status] ?? '',
}));

/**
 * The swatch class for a legend dot.
 *
 * It matches the card's ACCENT STRIPE (`border-l-{tone}-500`), not its fill.
 * That is the shade that identifies the row on screen: a `-50` swatch at legend
 * size would be barely visible, and the stripe is the strongest mark the card
 * carries. `gray` matches the card's muted stripe.
 *
 * Written literally per tone - Tailwind only emits classes it can see as literal
 * strings, so a composed `bg-${tone}-500` would compile to nothing.
 */
const LEGEND_SWATCH: Readonly<Record<TEventColor, string>> = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  red: 'bg-red-500',
  yellow: 'bg-yellow-500',
  purple: 'bg-purple-500',
  orange: 'bg-orange-500',
  gray: 'bg-neutral-400',
};

export function legendSwatchClass(tone: TEventColor): string {
  return LEGEND_SWATCH[tone] ?? LEGEND_SWATCH.gray;
}
