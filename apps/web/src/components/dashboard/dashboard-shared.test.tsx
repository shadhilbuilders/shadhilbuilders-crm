// KPI card tone + selected-state styling.
//
// ORIGINAL (T-DASH-QUEUE-SELECTED, 2026-09-16): the count strip doubled as the
// dashboard's filter control, so its SELECTED state had to be unmistakable at
// rest and the owner asked for "light blue" because the previous neutral grey
// did not read as selected. These tests pinned three things:
//   1. the tint used the brand LINK token (bg-link), not a hard-coded hex;
//   2. a SECOND cue existed (border + ring) so the state was never colour-only;
//   3. the secondary text stepped from `text-muted-foreground` to
//      `text-foreground` while selected - measured: --muted-foreground
//      (#64748b) is 4.75:1 on the white card but only ~4.2/3.9/3.7 at
//      bg-link/8/12/15, i.e. BELOW the 4.5 AA floor once the card is tinted.
//
// REVISED (2026-09-29, owner request: "all kpi-card with some background color
// with correct icon"). Every card now carries a SEMANTIC tone tint plus an
// icon, which changes what (1) and (3) mean:
//   - (1) the tint is now the tone, so a selected card can no longer be
//     distinguished BY being the only tinted one. The blue selected tint is
//     dropped rather than layered over the tone (two tint systems on one card
//     read as a change of MEANING, not of filter). Selection is carried by
//     `aria-pressed` + the affordance text.
//   - (3) is now STRONGER, not weaker: because every card is tinted, the muted
//     token is unusable on EVERY card, so the label/sub are pinned to
//     `text-foreground` unconditionally (13.5:1 worst case, on primary-soft).
//
// The real-browser axe audit (src/test/e2e/dashboard-audit.spec.ts) proves the
// computed colours pass; these tests pin the class-level contract cheaply.

import { LuCalendarCheck, LuListChecks, LuPhoneMissed, LuUserPlus } from '@paalstack/react-icons/lu';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { KpiStrip } from './dashboard-shared';

const noop = () => undefined;

function markup(items: Parameters<typeof KpiStrip>[0]['items']): string {
  return renderToStaticMarkup(<KpiStrip items={items} />);
}

describe('KpiStrip tone surfaces and icons', () => {
  it('gives every card a background tone and an icon (the owner request)', () => {
    const html = markup([
      { label: 'Needs a call now', value: '6', tone: 'urgent', Icon: LuPhoneMissed },
      { label: 'New today', value: '2', tone: 'new', Icon: LuUserPlus },
      { label: "Today's visits", value: '3', tone: 'today', Icon: LuCalendarCheck },
      { label: 'Leads to work', value: '9', tone: 'pipeline', Icon: LuListChecks },
    ]);
    // Each of the four tones contributes its own surface class. A card that
    // fell back to `bg-card` would be the regression this guards against.
    // `pipeline` is the NEUTRAL tone (`bg-secondary-soft`), not a fourth hue -
    // see the DARK MODE note in dashboard-shared.tsx for why primary-soft is
    // unusable here.
    for (const cls of [
      'bg-destructive-soft',
      'bg-info-soft',
      'bg-warning-soft',
      'bg-secondary-soft',
    ]) {
      expect(html, `missing tone surface ${cls}`).toContain(cls);
    }
    // No card may keep the plain white card surface any more.
    expect(html).not.toContain('bg-card');
    // And the broken token must not creep back.
    expect(html).not.toContain('bg-primary-soft');
    // Four icons, one per card.
    expect(html.match(/<svg/g)?.length).toBe(4);
  });

  it('uses a hard-coded HEX nowhere - the tints stay inside the token palette', () => {
    const html = markup([
      { label: 'Needs a call now', value: '6', tone: 'urgent', Icon: LuPhoneMissed },
    ]);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it('marks every icon decorative so a screen reader does not read the card twice', () => {
    // The icon repeats what the label already says ("phone" + "Needs a call
    // now"), so announcing it is noise. Pinned because react-icons does NOT set
    // aria-hidden itself, and the Kpi type takes an icon TYPE so a caller cannot
    // slip in a raw element that skips it.
    const html = markup([
      { label: 'Needs a call now', value: '6', tone: 'urgent', Icon: LuPhoneMissed },
    ]);
    expect(html).toContain('aria-hidden="true"');
    // Exactly one svg, and it is the aria-hidden one.
    expect(html.match(/<svg/g)?.length).toBe(1);
  });
});

describe('KpiStrip selected state', () => {
  it('does not tint a selected card differently - the tone owns the surface', () => {
    // A selected card must keep the SAME tone surface as its siblings, so
    // selection never reads as a change of category. The old selected-only
    // `bg-link/*` tint is gone (see the header comment).
    const selected = markup([
      {
        label: 'Needs a call now',
        value: '6',
        onClick: noop,
        active: true,
        tone: 'urgent',
        Icon: LuPhoneMissed,
      },
    ]);
    const plain = markup([
      {
        label: 'Needs a call now',
        value: '6',
        onClick: noop,
        active: false,
        tone: 'urgent',
        Icon: LuPhoneMissed,
      },
    ]);
    expect(selected).not.toContain('bg-link');
    expect(plain).not.toContain('bg-link');
    expect(selected).toContain('bg-destructive-soft');
    expect(plain).toContain('bg-destructive-soft');
    // No border or ring in the link colour either (owner feedback: "border is
    // not needed for selected" - the card keeps its tone's own border).
    expect(selected).not.toContain('border-link');
    expect(selected).not.toContain('ring-link');
  });

  it('still has a non-colour cue for the selected state (WCAG 1.4.1)', () => {
    // With both the blue tint AND the ring gone, the non-colour cue is the
    // card's own TEXT plus aria-pressed. This is what selection now rests on,
    // so it is load-bearing rather than belt-and-braces.
    const selected = markup([
      {
        label: 'Today\u2019s visits',
        value: '3',
        onClick: noop,
        active: true,
        tone: 'today',
        Icon: LuCalendarCheck,
      },
    ]);
    expect(selected).toContain('Showing only this');
    expect(selected).toContain('aria-pressed="true"');
    // The focus ring is untouched - it is a keyboard affordance, not a state cue.
    expect(selected).toContain('focus-visible:ring-2');
  });

  it('never uses the muted token on a tinted card (measured AA on all four tones)', () => {
    // MEASURED, not assumed. --muted-foreground (#64748b) is 4.75:1 on the white
    // card but 4.09-4.35:1 on the soft tints and 3.20:1 on primary-soft - under
    // the 4.5 AA floor for normal text. Now that EVERY card is tinted, the muted
    // token is unusable on every card, so label + sub + placeholder must all be
    // `text-foreground` (13.5:1 worst case, on primary-soft).
    //
    // Asserted on the exact rendered spans rather than a count of occurrences:
    // the clickable branch also carries a `text-foreground` reset on the
    // <button> itself (a UA-stylesheet colour reset), so a count would be
    // pinned to a number that has nothing to do with the AA question.
    const base = {
      label: 'Needs a call now',
      value: '6',
      sub: 'overdue first touch',
      tone: 'urgent',
      Icon: LuPhoneMissed,
    } as const;
    const LABEL_SPAN = 'text-foreground block text-xs tracking-wide uppercase">Needs a call now';
    const SUB_SPAN = 'text-foreground mt-0.5 block text-xs">overdue first touch';

    for (const active of [true, false]) {
      const html = markup([{ ...base, onClick: noop, active }]);
      expect(html, `muted token leaked onto a tint (active=${active})`).not.toContain(
        'text-muted-foreground',
      );
      expect(html, `label not foreground (active=${active})`).toContain(LABEL_SPAN);
      expect(html, `sub not foreground (active=${active})`).toContain(SUB_SPAN);
    }

    // A placeholder value ("-") is muted on a plain card, so it has to step up
    // too. Its class order puts the tone text last, after the type scale.
    const placeholder = markup([{ ...base, value: '-', onClick: noop, active: false }]);
    expect(placeholder).not.toContain('text-muted-foreground');
    expect(placeholder).toContain('sm:text-3xl text-foreground');
    expect(placeholder).toContain(LABEL_SPAN);
    expect(placeholder).toContain(SUB_SPAN);
  });

  it('marks the selected card for styling hooks and leaves siblings unselected', () => {
    const html = markup([
      {
        label: 'Needs a call now',
        value: '6',
        onClick: noop,
        active: true,
        tone: 'urgent',
        Icon: LuPhoneMissed,
      },
      {
        label: 'Today\u2019s visits',
        value: '3',
        onClick: noop,
        active: false,
        tone: 'today',
        Icon: LuCalendarCheck,
      },
      { label: 'New today', value: '2', tone: 'new', Icon: LuUserPlus },
    ]);
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('data-selected="false"');
    // Exactly ONE card is pressed.
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    // A static card is never a button.
    expect(html).toContain('data-qa="kpi-card-static"');
  });

  it('says what it is doing, not just that it is on', () => {
    const selected = markup([
      {
        label: 'Needs a call now',
        value: '6',
        onClick: noop,
        active: true,
        tone: 'urgent',
        Icon: LuPhoneMissed,
      },
    ]);
    const unselected = markup([
      {
        label: 'Needs a call now',
        value: '6',
        onClick: noop,
        active: false,
        tone: 'urgent',
        Icon: LuPhoneMissed,
      },
    ]);
    expect(selected).toContain('Showing only this');
    expect(unselected).toContain('Tap to filter');
  });

  it('gives a clicked-but-unselected card the same tone surface as its siblings', () => {
    // Guard: clicking must not be confused with selecting. An earlier version had
    // the clickable affordance and the selected state share a class branch.
    const html = markup([
      {
        label: 'Needs a call now',
        value: '6',
        onClick: vi.fn(),
        active: false,
        tone: 'urgent',
        Icon: LuPhoneMissed,
      },
    ]);
    expect(html).toContain('bg-destructive-soft');
    expect(html).not.toContain('bg-link');
    // The card still reads as interactive at rest.
    expect(html).toContain('cursor-pointer');
    expect(html).toContain('Tap to filter');
  });
});
