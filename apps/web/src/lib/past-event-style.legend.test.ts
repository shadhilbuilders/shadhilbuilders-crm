// The visit colour legend (2026-09-30).
//
// "I don't understand what each colors means in visits page card." The legend
// exists to answer that, so the tests have to prove it answers it COMPLETELY and
// CORRECTLY:
//
//   1. Every `SiteVisit.status` appears - a status with no row is a colour the
//      reader still cannot look up, which is the original complaint.
//   2. Each row's tone is the tone the CALENDAR actually paints, read from the
//      same map. A legend that disagrees with the picture is worse than none.
//   3. The order follows the status list, so the key reads in the sequence the
//      status machine does rather than in object-key order.
//   4. Every row carries words, not just a swatch - WCAG 1.4.1, and the whole
//      point of a key.
import { describe, expect, it } from 'vitest';

import { VISIT_STATUSES, labelFor } from '@/lib/labels';
import { VISIT_STATUS_COLOR, visitStatusColor } from '@/lib/visit-status';

import { VISIT_LEGEND, legendSwatchClass, PAST_ACCENT_WIDTH_CLASS, pastEventClass } from './past-event-style';

describe('VISIT_LEGEND', () => {
  it('covers EVERY SiteVisit status the calendar can paint', () => {
    const covered = VISIT_LEGEND.map((e) => e.status);
    for (const status of VISIT_STATUSES) {
      expect(covered, `${status} is missing from the legend`).toContain(status);
    }
    // And nothing extra: a stale row would explain a colour that never appears.
    expect([...covered].sort()).toEqual([...VISIT_STATUSES].sort());
  });

  it('reads in VISIT_STATUSES order, not object-key order', () => {
    expect(VISIT_LEGEND.map((e) => e.status)).toEqual([...VISIT_STATUSES]);
  });

  it('gives every row the tone the CALENDAR actually paints', () => {
    // THE DRIFT TRIPWIRE. Read the tone through the same function the card
    // calls, so a change to the calendar's colouring fails HERE rather than
    // leaving the key quietly describing a palette that no longer exists.
    for (const entry of VISIT_LEGEND) {
      expect(
        entry.tone,
        `${entry.status}: legend says ${entry.tone}, calendar paints ${visitStatusColor(entry.status)}`,
      ).toBe(visitStatusColor(entry.status));
      expect(entry.tone).toBe(VISIT_STATUS_COLOR[entry.status]);
    }
  });

  it('uses the shared friendly words, never raw enum names', () => {
    // This population is using a CRM for the first time; "NO_SHOW" is not a
    // thing anyone says out loud.
    for (const entry of VISIT_LEGEND) {
      expect(entry.label).toBe(labelFor('visit', entry.status));
      expect(entry.label).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('explains each colour in a sentence, not just a swatch', () => {
    // Colour-alone is a WCAG 1.4.1 failure AND useless as a key.
    for (const entry of VISIT_LEGEND) {
      expect(entry.meaning.length, `${entry.status} has no explanation`).toBeGreaterThan(0);
    }
  });

  it('distinguishes the two green-ish outcomes that matter most', () => {
    // The reader's real question on a past visit: did it happen, or did they not
    // turn up? Those must not share a tone or a sentence.
    const completed = VISIT_LEGEND.find((e) => e.status === 'COMPLETED');
    const noShow = VISIT_LEGEND.find((e) => e.status === 'NO_SHOW');
    expect(completed?.tone).toBe('green');
    expect(noShow?.tone).toBe('red');
    expect(completed?.meaning).not.toBe(noShow?.meaning);
  });

  it('gives each tone a literal swatch class', () => {
    for (const entry of VISIT_LEGEND) {
      expect(legendSwatchClass(entry.tone)).toMatch(/^bg-(blue|green|red|yellow|purple|orange|neutral)-\d00$/);
    }
  });

  it('has a swatch for every tone the legend can produce', () => {
    // A missing tone would fall back to `gray` silently, so the swatch would
    // claim "neutral" for something the calendar paints coloured.
    for (const entry of VISIT_LEGEND) {
      expect(legendSwatchClass(entry.tone)).not.toBe(legendSwatchClass('gray'));
    }
  });
});

describe('the past-view surface and the legend agree', () => {
  it('both key on the same tone for the same status', () => {
    // The past view tints the row with the outcome; the legend explains the
    // outcome. If they disagreed, a history row's colour would contradict the key
    // sitting above it. Read through the SAME tone the legend carries, so a
    // change to either side fails here.
    for (const entry of VISIT_LEGEND) {
      const surface = pastEventClass(entry.tone);
      const shade = entry.tone === 'gray' ? 'neutral' : entry.tone;
      expect(
        surface,
        `${entry.status}: legend tone ${entry.tone} but history surface is "${surface}"`,
      ).toContain(`bg-${shade}-`);
    }
  });

  it('uses the SAME shade as the card, not two similar ones', () => {
    // The legend's whole job is "the colour you are looking at means X". A swatch
    // one shade off the card is a key that is nearly right, which is worse than
    // obviously wrong - and it is exactly what a hand-tuned palette drifts into.
    //
    // The swatch matches the card's ACCENT STRIPE (`border-l-{tone}-500`), not its
    // fill: the stripe is the strongest mark a history row carries, and a `-50`
    // swatch at legend size would be barely visible. `gray` matches the card's
    // muted stripe.
    for (const entry of VISIT_LEGEND) {
      const shade = entry.tone === 'gray' ? 'neutral' : entry.tone;
      const borderShade = entry.tone === 'gray' ? 'neutral-400' : `${shade}-500`;
      expect(
        legendSwatchClass(entry.tone),
        `${entry.status}: legend swatch and card accent are different shades`,
      ).toBe(`bg-${shade}-${entry.tone === 'gray' ? '400' : '500'}`);
      expect(pastEventClass(entry.tone)).toContain(`border-l-${borderShade}`);
    }
  });

  it('carries the 4px left accent on every tone, matching the cards', () => {
    // The legend explains the same colours the cards use. Direction has flipped
    // twice on this treatment ("instead of border color" -> "Use previously used
    // border left"); this asserts the CURRENT state so the two cannot end up
    // disagreeing about whether history has an accent at all.
    for (const entry of VISIT_LEGEND) {
      expect(pastEventClass(entry.tone)).toContain(PAST_ACCENT_WIDTH_CLASS);
    }
  });
});
