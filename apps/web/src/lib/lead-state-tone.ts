// Lead-state → calendar tone, for surfaces that label a LEAD state with a colour.
//
// WHY THIS FILE EXISTS (2026-09-30). The visit detail dialog printed the LEAD's
// pipeline state ("Won 🎉", "Didn't show up") inside a chip coloured by
// `visitStatusColor(status, outcome)` - the VISIT's status. Those are two
// different records with two different axes:
//
//   the visit   what happened on site   COMPLETED / NO_SHOW / CANCELLED /
//                                       RESCHEDULED / SCHEDULED
//   the lead    where the deal stands   NEW … WON / LOST / RNR / NO_SHOW
//
// So the chip's colour answered a question nobody had asked. A green chip
// reading "Won 🎉" meant "the visit was COMPLETED" - not that the deal was won.
// A green chip reading "Didn't show up" meant the visit was COMPLETED while the
// lead had since been marked a no-show, and read as nonsense: one colour, two
// claims, on one line.
//
// The dialog's own comment says its chip is meant to MATCH the lead page's
// `LeadStatusBadge`, which is the surface that shows the lead state. It matched
// the words but not the colour; this closes that gap.
//
// THE CALENDAR CARD KEEPS ITS OWN COLOUR. A calendar is a grid of WHEN things
// happen, and the owner asked for it to answer "did the visit happen" at a
// glance (owner request 2026-09-29), which the visit's status answers exactly.
// Nothing here changes `visitStatusColor` or the event colour.
import type { LeadState } from '@shadhil/api-types';

import type { TEventColor } from '@/components/calendar/types';

/**
 * The colour each LEAD state wears.
 *
 * Exhaustive over `LeadState` BY TYPE, not by convention: the value is typed
 * `Record<LeadState, TEventColor>`, so adding a state to the enum fails the
 * build here until it is given a tone. That is stronger than a coverage test,
 * which can only fail after someone remembers to run it.
 *
 * The groupings are the SAME as `STATE_BADGE_CLASS` in
 * `components/shared/LeadStatusBadge.tsx`, which is the established mapping:
 *
 *   green   VISITED, WON                      the visit happened / the deal
 *                                             closed
 *   yellow  VISIT_REQUESTED, VISIT_SCHEDULED, waiting on a visit, or a visit
 *           RESCHEDULED                       that moved
 *   red     LOST, NO_SHOW                     dead, or the customer did not
 *                                             turn up
 *   blue    CONTACTED, NEGOTIATION,           in play
 *           BOOKING_INITIATED
 *   gray    NEW, RNR                          nothing has happened yet /
 *                                             parked
 *
 * NO_SHOW IS RED, on both records. The pill maps it to `bg-destructive`
 * (LeadStatusBadge.tsx:42) and the calendar maps the visit's NO_SHOW to red
 * (`VISIT_STATUS_COLOR`), so the lead axis agrees: "didn't show up" is bad news
 * wherever it appears, and this matches the owner's "if visit not happened show
 * red color".
 *
 * WHY NOT REUSE `STATE_BADGE_CLASS` DIRECTLY. That map holds Tailwind pill class
 * strings, not a semantic tone; a consumer could not ask "is this positive?"
 * without parsing CSS, and the calendar's chip and its `StatusIcon` both switch
 * on a tone. The two maps are pinned against each other by
 * `lead-state-tone.test.ts` so they cannot drift.
 */
const LEAD_STATE_TONE_BY_STATE: Readonly<Record<LeadState, TEventColor>> = {
  NEW: 'gray',
  CONTACTED: 'blue',
  VISIT_REQUESTED: 'yellow',
  VISIT_SCHEDULED: 'yellow',
  VISITED: 'green',
  NEGOTIATION: 'blue',
  BOOKING_INITIATED: 'blue',
  WON: 'green',
  LOST: 'red',
  RNR: 'gray',
  RESCHEDULED: 'yellow',
  NO_SHOW: 'red',
};

/** Every state this module knows a tone for - for drift assertions in tests. */
export const LEAD_STATE_TONES: Readonly<Record<string, TEventColor>> =
  LEAD_STATE_TONE_BY_STATE;

/**
 * The tone for a lead state.
 *
 * Unknown or missing input degrades to `gray`: a newer backend enum the web app
 * has not shipped for should look neutral, never like a confident colour claim.
 */
export function leadStateTone(state: string | null | undefined): TEventColor {
  if (typeof state !== 'string' || state.length === 0) return 'gray';
  return LEAD_STATE_TONES[state] ?? 'gray';
}
