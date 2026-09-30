// T-PAST-VISIT-SURFACE (2026-09-30) - the rendered surface of a history card.
//
// `past-event-style.test.ts` pins what the override CLAIMS to do. This file pins
// that it actually WINS on a real vendored card, which is the part that can
// silently fail: the cards set `bg-*`/`text-*` through a cva variant, and the
// override is only effective because `cn` is `twMerge(clsx(...))`. A plain concat
// would leave both classes present and Tailwind's emitted order - not source
// order - would decide the winner.
//
// THE REPORTED CASE: a COMPLETED visit (green under `visitStatusColor`) on a WON
// lead, viewed with "Show past visits" on. Rendered through the real agenda card,
// the class string must contain NO green background.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../dialogs/event-details-dialog', () => ({
  EventDetailsDialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AgendaEventCard } from './agenda-event-card';

import { CalendarProvider } from '../calendar-context';

import type { IEvent } from '../interfaces';

/**
 * The reported row: a visit that COMPLETED (so `color` is green) whose lead is
 * WON. Under the old presentation this rendered `bg-green-50`.
 */
const GREEN_COMPLETED_VISIT: IEvent = {
  id: 'visit-1',
  startDate: '2026-09-24T10:00:00.000Z',
  endDate: '2026-09-24T11:00:00.000Z',
  title: 'Arjun Reddy',
  color: 'green',
  description: '',
  user: { id: 'u-2', name: 'Lakshmi N.', picturePath: null },
  visit: {
    status: 'COMPLETED',
    outcome: 'COMPLETED',
    leadId: 'lead-1',
    leadState: 'WON',
  },
};

/** Render one agenda card inside a provider, in the requested mode. */
function renderCard(isPastView: boolean): string {
  return renderToStaticMarkup(
    <CalendarProvider users={[]} events={[GREEN_COMPLETED_VISIT]} isPastView={isPastView}>
      <AgendaEventCard event={GREEN_COMPLETED_VISIT} />
    </CalendarProvider>,
  );
}

/**
 * The card button's resolved class list.
 *
 * The card renders a PLAIN `<button role="button">` (it is vendored and does not
 * go through the design system's Button), so the class attribute is matched on
 * `<button` specifically rather than "the first class attribute in the document".
 * That distinction is not cosmetic: the first version of this helper fell back to
 * any class attribute, which matched a WRAPPER element and let the assertions
 * pass vacuously - caught only because the fallback was removed and the test
 * threw instead of quietly succeeding.
 */
function cardClasses(html: string): string {
  const match = /<button[^>]*\sclass="([^"]*)"/.exec(html);
  if (match === null) {
    throw new Error(`card button not found in markup: ${html.slice(0, 300)}`);
  }
  return match[1] ?? '';
}

describe('AgendaEventCard - past view surface', () => {
  it('renders the light fill with the strong left accent', () => {
    const html = renderCard(true);
    expect(html).toContain('Arjun Reddy');
    const classes = cardClasses(html);
    // The light outcome fill - the `-500` block was undone.
    expect(classes).toContain('bg-green-50');
    expect(classes).not.toContain('bg-green-500');
    // The 4px accent the owner asked to restore, in the strong shade: `-500` was
    // too heavy as a surface and is right as a stripe.
    expect(classes).toContain('border-l-4');
    expect(classes).toContain('border-l-green-500');
    // Dark text on a light fill.
    expect(classes).toContain('text-foreground');
    expect(classes).not.toContain('text-white');
  });

  it('leaves the outcome dot to the variant (no override on a light fill)', () => {
    // The `-500`-fill pass had to re-point the dot to `currentColor`; on a `-50`
    // fill the variant's own `fill-green-600` is clearly visible, so OUR override
    // is gone. The variant's selector is still present by design, so the assertion
    // is "no fill-current override", not "no event-dot class" - the latter was my
    // first attempt and it failed on the class that belongs there.
    const classes = cardClasses(renderCard(true));
    expect(classes).not.toMatch(/_.event-dot\]:fill-current/);
    expect(classes).toMatch(/_.event-dot\]:fill-green-600/);
  });

  it('is clearly different from a live card', () => {
    // Live is a tint with NO accent; history is a tint WITH a strong stripe. If a
    // future change collapsed them, the past view would lose its meaning.
    const past = cardClasses(renderCard(true));
    const live = cardClasses(renderCard(false));

    expect(live).toContain('bg-green-50');
    expect(live).not.toContain('border-l-4');
    expect(live).toMatch(/text-green-700/);

    expect(past).toContain('border-l-4');
    expect(past).toContain('text-foreground');
    expect(past).not.toBe(live);
  });

  it('STILL paints the live calendar without an accent', () => {
    // The live view is unchanged by every one of these passes: the `-50` tint and
    // the saturated text/frame, and no left accent - there the colour answers "did
    // this happen yet" and should read as a tint, not a flagged row.
    const classes = cardClasses(renderCard(false));
    expect(classes).toContain('bg-green-50');
    expect(classes).toMatch(/border-green-200/);
    expect(classes).not.toContain('border-l-4');
  });
});
