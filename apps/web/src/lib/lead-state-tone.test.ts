// T-LEAD-STATE-CHIP-TONE (2026-09-30) - the lead-state tone map, and the drift
// tripwire against the pill map it must agree with.
//
// THE BUG this exists for. The visit detail dialog printed the LEAD's pipeline
// state ("Won 🎉", "Didn't show up") inside a chip coloured by the VISIT's
// status. A lead green-lighted "Won 🎉" because its VISIT was COMPLETED - two
// records, one colour, and the colour answering the wrong question. The fix
// colours the chip from `leadStateTone`, and the calendar card keeps colouring
// by the visit.
//
// These tests pin three things:
//   1. Every LeadState has a tone (and the map is exhaustive BY TYPE, so this
//      test is a second line rather than the only one).
//   2. The tone GROUPING agrees with `STATE_BADGE_CLASS` in LeadStatusBadge -
//      the established pill mapping - so the dialog chip and the lead page's
//      badge cannot drift into saying different things with the same colour.
//   3. Unknown input degrades to neutral, never to a confident colour claim.
import { describe, expect, it } from 'vitest';

import { LEAD_STATES } from '@/lib/leads';
import { LEAD_STATE_TONES, leadStateTone } from './lead-state-tone';

// The pill's surface per state. Imported from its real home so a change there
// fails HERE rather than silently diverging.
import { STATE_BADGE_CLASS } from '@/components/shared/LeadStatusBadge';

/**
 * Which "family" a `STATE_BADGE_CLASS` value belongs to, read from the class
 * string. `destructive` counts as the danger family alongside the destructive
 * soft variant: a pill is either the soft tint or the solid one depending on how
 * loud the state is, and both mean the same thing to a reader.
 */
function pillFamily(cls: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (cls.includes('destructive')) return 'danger';
  if (cls.includes('success')) return 'success';
  if (cls.includes('warning')) return 'warning';
  if (cls.includes('info')) return 'info';
  return 'neutral';
}

/** The same families, read off a calendar tone. */
function toneFamily(tone: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (tone === 'green') return 'success';
  if (tone === 'red') return 'danger';
  if (tone === 'yellow') return 'warning';
  if (tone === 'blue') return 'info';
  return 'neutral';
}

describe('leadStateTone', () => {
  it('has an EXPLICIT entry for every LeadState (nothing falls through to gray)', () => {
    // `gray` is a real tone here - NEW and RNR are deliberately neutral - so
    // "the value is not gray" would be the wrong assertion. What matters is that
    // every state is an EXPLICIT KEY, so a state added to the enum is visibly
    // missing from this map rather than silently inheriting the unknown-input
    // fallback. (The Record<LeadState, …> type on the map is the first line of
    // defence; this is the second, because a cast or a widened type could slip
    // past tsc.)
    for (const state of LEAD_STATES) {
      expect(
        Object.hasOwn(LEAD_STATE_TONES, state),
        `${state} is missing from LEAD_STATE_TONES`,
      ).toBe(true);
    }
  });

  it('carries no stale keys that are not real LeadStates', () => {
    // The other direction: a renamed enum member would leave its old key behind,
    // doing nothing but looking authoritative.
    const known = new Set<string>(LEAD_STATES);
    const stale = Object.keys(LEAD_STATE_TONES).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it('agrees with STATE_BADGE_CLASS about which family each state is in', () => {
    // THE DRIFT TRIPWIRE. The dialog chip and the lead page's badge show the
    // same words for the same lead; if their colours disagree, the operator sees
    // two surfaces contradicting each other about one deal.
    for (const state of LEAD_STATES) {
      const pill = STATE_BADGE_CLASS[state];
      expect(pill, `${state} missing from STATE_BADGE_CLASS`).toBeDefined();
      expect(
        toneFamily(leadStateTone(state)),
        `${state}: tone=${leadStateTone(state)} but pill classes="${pill}"`,
      ).toBe(pillFamily(pill as string));
    }
  });

  it('marks the states the owner called out: WON green, NO_SHOW red', () => {
    // The exact report: "Won" and "Didn't show up" both rendered green. WON IS
    // green (the deal closed) and NO_SHOW must not be - that is the whole point
    // of the two being different tones.
    expect(leadStateTone('WON')).toBe('green');
    expect(leadStateTone('NO_SHOW')).toBe('red');
    expect(leadStateTone('NO_SHOW')).not.toBe(leadStateTone('WON'));
  });

  it('keeps death and no-show on the same tone (LOST == NO_SHOW == red)', () => {
    // Both mean "this did not work out"; a reader should not have to learn two
    // colours for one outcome.
    expect(leadStateTone('LOST')).toBe('red');
    expect(leadStateTone('NO_SHOW')).toBe('red');
  });

  it('does not use a tone for a state it has never seen', () => {
    // A newer backend enum the web app has not shipped for must look neutral,
    // never like a confident colour claim.
    expect(leadStateTone('SOMETHING_NEW')).toBe('gray');
    expect(leadStateTone('')).toBe('gray');
    expect(leadStateTone(null)).toBe('gray');
    expect(leadStateTone(undefined)).toBe('gray');
  });

  it('gives no two VISIT-loop states the same tone except deliberately', () => {
    // The visit loop the user is looking at: requested/booked/postponed all mean
    // "waiting on a visit", so they share yellow. Visited is green. Asserted so
    // that grouping is a decision rather than an accident.
    expect(leadStateTone('VISIT_REQUESTED')).toBe('yellow');
    expect(leadStateTone('VISIT_SCHEDULED')).toBe('yellow');
    expect(leadStateTone('RESCHEDULED')).toBe('yellow');
    expect(leadStateTone('VISITED')).toBe('green');
  });
});
