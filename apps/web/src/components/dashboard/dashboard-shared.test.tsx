// KpiStrip selected-state styling (T-DASH-QUEUE-SELECTED, 2026-09-16).
//
// The count strip doubles as the dashboard's filter control, so its SELECTED
// state has to be unmistakable at rest. The owner originally asked for "light
// blue" because the previous state was a neutral grey (`bg-muted` + grey ring)
// that did not read as selected.
//
// These tests pin the three things that make the state legible and accessible:
//   1. the tint uses the brand LINK token (bg-link), not a hard-coded hex -
//      so it stays in the palette and follows the token into dark mode;
//   2. a SECOND cue exists (border + ring) so the state is never carried by
//      colour alone (WCAG 1.4.1) and survives greyscale / colour-blindness;
//   3. the secondary text steps from `text-muted-foreground` to
//      `text-foreground` while selected - measured: --muted-foreground
//      (#64748b) is 4.76 on the white card but only ~4.2/3.9/3.7 at
//      bg-link/8/12/15, i.e. BELOW the 4.5 AA floor once the card is tinted.
//
// The real-browser axe audit (src/test/e2e/dashboard-audit.spec.ts) proves the
// computed colours pass; these tests pin the class-level contract cheaply.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { KpiStrip } from './dashboard-shared';

const noop = () => undefined;

function markup(items: Parameters<typeof KpiStrip>[0]['items']): string {
  return renderToStaticMarkup(<KpiStrip items={items} />);
}

describe('KpiStrip selected state', () => {
  it('tints a selected card with the brand link token, not a raw colour', () => {
    const html = markup([
      { label: 'Needs a call now', value: '6', onClick: noop, active: true },
      { label: 'New today', value: '2' },
    ]);
    expect(html).toContain('bg-link/15');
    // No hard-coded blue anywhere.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it('does NOT give a selected card its own border or ring (owner feedback)', () => {
    // "border is not needed for selected": the tint is the whole visual change, so
    // a selected card keeps the SAME `border-border` as its siblings and stays one
    // visual family. The blue border+ring were removed on request - pinned here so
    // they cannot creep back.
    const selected = markup([
      { label: 'Needs a call now', value: '6', onClick: noop, active: true },
    ]);
    expect(selected).not.toContain('border-link');
    expect(selected).not.toContain('ring-link');
    expect(selected).toContain('border-border');
  });

  it('still has a non-colour cue for the selected state (WCAG 1.4.1)', () => {
    // The tint alone does not survive greyscale / colour-blindness. With the ring
    // gone, the non-colour cue is the card's own TEXT plus aria-pressed.
    const selected = markup([
      { label: 'Today\u2019s visits', value: '3', onClick: noop, active: true },
    ]);
    expect(selected).toContain('Showing only this');
    expect(selected).toContain('aria-pressed="true"');
    // The focus ring is untouched - it is a keyboard affordance, not a state cue.
    expect(selected).toContain('focus-visible:ring-2');
  });

  it('steps secondary text to foreground while selected (AA on the tint)', () => {
    const base = {
      label: 'Needs a call now',
      value: '6',
      sub: 'overdue first touch',
      onClick: noop,
    } as const;
    const selected = markup([{ ...base, active: true }]);
    const plain = markup([{ ...base, active: false }]);

    // Every span that is MUTED on the plain card must be FOREGROUND on the tint.
    // Label + sub are the two muted spans for a real (non-placeholder) value.
    expect(plain.match(/text-muted-foreground/g)?.length).toBe(2);
    expect(selected).not.toContain('text-muted-foreground');
    expect(selected.match(/text-foreground/g)?.length).toBe(2);

    // A placeholder value ("-") is muted too, so it also has to step up.
    const placeholder = markup([
      {
        label: 'Needs a call now',
        value: '-',
        sub: 'overdue first touch',
        onClick: noop,
        active: true,
      },
    ]);
    expect(placeholder).not.toContain('text-muted-foreground');
    expect(placeholder.match(/text-foreground/g)?.length).toBe(3);
  });

  it('marks the selected card for styling hooks and leaves siblings unselected', () => {
    const html = markup([
      { label: 'Needs a call now', value: '6', onClick: noop, active: true },
      { label: 'Today\u2019s visits', value: '3', onClick: noop, active: false },
      { label: 'New today', value: '2' },
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
      { label: 'Needs a call now', value: '6', onClick: noop, active: true },
    ]);
    const unselected = markup([
      { label: 'Needs a call now', value: '6', onClick: noop, active: false },
    ]);
    expect(selected).toContain('Showing only this');
    expect(unselected).toContain('Tap to filter');
  });

  it('does not tint a card that merely has a handler', () => {
    // Guard: clicking must not be confused with selecting. An earlier version had
    // the clickable affordance and the selected state share a class branch.
    const html = markup([
      { label: 'Needs a call now', value: '6', onClick: vi.fn(), active: false },
    ]);
    expect(html).not.toContain('bg-link');
    expect(html).toContain('hover:bg-muted/60');
  });
});
