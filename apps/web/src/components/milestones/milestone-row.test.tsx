// MilestoneRow (2026-11-10): the alignment guard for the milestone editor.
//
// protects= every field in the row starts on ONE left rail (the numeral owns its
//           own gutter column, it does not indent the name field), and the
//           44px height reaches the <input> element rather than its wrapper;
// fails_when= the name field is indented 28px from the dates below it, or
//           `min-h-11` is passed through `className` and lands on the wrapper;
// no_claim= static markup, not a visual diff.
//
// WHY THESE ASSERTIONS ARE THE TEST. Both defects are CSS-in-className, so no
// unit test can "see" the result without a browser. What a test CAN pin is the
// structure that caused them, measured on the shipped dialog:
//   - name input left x=47.2 vs date inputs x=19.2 (28px = w-5 + gap-2),
//   - input centre ~6px above the 44px icon buttons' centre.
// Pin the structure, and neither bug can come back silently.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MilestoneDraft } from './milestone-draft';
import { MilestoneRow } from './milestone-row';

const draft: MilestoneDraft = { key: 'k1', name: 'Slab cast', targetDay: '', completedDay: '' };

const noop = () => undefined;

function render(tokens?: Partial<Parameters<typeof MilestoneRow>[0]>) {
  return renderToStaticMarkup(
    <MilestoneRow
      draft={draft}
      index={0}
      isFirst
      isLast
      onChange={noop}
      onMoveUp={noop}
      onMoveDown={noop}
      onRemove={noop}
      {...tokens}
    />,
  );
}

describe('MilestoneRow', () => {
  it('puts the numeral in its own gutter so every field shares one left rail', () => {
    const html = render();
    // The gutter column is declared on the grid that holds BOTH the numeral and
    // the whole field stack - the fix for the 28px indent.
    expect(html).toContain('grid-cols-[1.25rem_minmax(0,1fr)]');
    // The numeral is a sibling of the field stack, never inside the name row.
    const numeral = html.indexOf('tabular-nums');
    const fields = html.indexOf('data-qa="milestone-fields"');
    expect(numeral).toBeGreaterThan(-1);
    expect(numeral).toBeLessThan(fields);
  });

  it('sizes the field itself, not its wrapper', () => {
    const html = render();
    // `inputClassName` reaches the <input>; `className` would hit the wrapper.
    expect(html).not.toContain('className="min-h-11"');
    // Every field in the row is 44px: name + both dates.
    expect(html.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('numbers the row from one and labels its controls for a screen reader', () => {
    const html = render({ index: 2, isFirst: false, isLast: false });
    expect(html).toContain('aria-label="Milestone 3 name"');
    expect(html).toContain('aria-label="Move milestone 3 up"');
    expect(html).toContain('aria-label="Move milestone 3 down"');
    expect(html).toContain('aria-label="Remove milestone 3"');
  });

  it('disables the move controls at the ends of the list', () => {
    // NOTE: the class list carries `disabled:pointer-events-none`, so asserting
    // on the WORD "disabled" matches every button. Assert the attribute itself.
    const button = (html: string, label: string) => {
      const match = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
      expect(match, `no button labelled "${label}"`).not.toBeNull();
      return match?.[0].includes(' disabled=""') === true;
    };

    const first = render({ isFirst: true, isLast: false });
    expect(button(first, 'Move milestone 1 up')).toBe(true);
    expect(button(first, 'Move milestone 1 down')).toBe(false);
    // Remove is always available - a row can be deleted from either end.
    expect(button(first, 'Remove milestone 1')).toBe(false);

    const last = render({ index: 1, isFirst: false, isLast: true });
    expect(button(last, 'Move milestone 2 down')).toBe(true);
    expect(button(last, 'Move milestone 2 up')).toBe(false);
  });

  it('labels both date fields and ties them to their inputs', () => {
    const html = render();
    expect(html).toContain('Target date');
    expect(html).toContain('Reached on (blank = not yet)');
    // htmlFor/for must resolve to a real id, or the label is decorative.
    const targetFor = html.match(/for="([^"]+)-target"/)?.[1];
    expect(targetFor).toBeDefined();
    expect(html).toContain(`id="${targetFor}-target"`);
  });

  // Regression (2026-11-11): measured at 320px, three inline 44px icon buttons
  // squeezed the name field to 76px - about five characters, on the device where
  // typing a milestone name is hardest.
  //
  // The fix is deliberately FLUID rather than a `sm:` flip, because this app
  // overrides Tailwind's breakpoint scale (xs=481, sm=768, md=992, lg=1200).
  // A `sm:` switch would leave 640-767px with a ~700px-wide dialog but wrapped
  // controls, so the row wraps on real available space instead:
  //   - the name field asks for 16rem of basis but may shrink (`grow` +
  //     `min-w-0`, NOT `min-w-16rem` which would overflow at 320px),
  //   - the actions are `shrink-0`, so they are never squeezed below 44px.
  it('keeps the name field usable on phones without squeezing the controls', () => {
    const html = render();
    const nameTag = html.match(/<input[^>]*aria-label="Milestone 1 name"[^>]*>/)?.[0] ?? '';
    expect(nameTag).toContain('min-h-11');

    // Wrap is allowed, and the actions refuse to shrink.
    expect(html).toContain('flex flex-wrap items-center gap-2');
    const actionsTag = html.match(/<div[^>]*data-qa="milestone-actions"[^>]*>/)?.[0] ?? '';
    expect(actionsTag).toContain('shrink-0');

    // The name wrapper is flexible: grow + a basis floor, and min-w-0 so it can
    // shrink instead of overflowing a 320px screen.
    expect(html).toContain('min-w-0 grow basis-[16rem]');
    // A hard min-width would overflow on the narrowest phone; it must not be
    // reintroduced through the wrapper's className.
    expect(html).not.toContain('min-w-[16rem]');
  });

  it('keeps every control at the 44px touch target on the wrapping line', () => {
    const html = render();
    // Three icon buttons, all size-11, none squeezed by the wrap.
    expect(html.match(/size-11/g)?.length).toBeGreaterThanOrEqual(3);
  });

  // The date pair must also be fluid, not `sm:grid-cols-2` (which would only
  // flip at this app's 768px and waste a 700px-wide dialog at 640-767px).
  it('lays the two dates out by available room, not by a breakpoint', () => {
    const html = render();
    expect(html).toContain('grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]');
    expect(html).not.toContain('sm:grid-cols-2');
  });

  // Regression (2026-11-10): with no id, the library Input falls back to
  // id="input", so every row in the dialog shared ONE DOM id and `for=` /
  // document.getElementById resolved to the first row only.
  it('gives every field a unique id', () => {
    const html = render();
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('input');
  });
});
