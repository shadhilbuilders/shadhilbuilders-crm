// PendingTokenCard - HOLD bookings awaiting their token payment (T-HOLD-VISIBLE).
//
// renderToStaticMarkup only, per the repo's standing rule (apps/web has no
// @testing-library/react, verified: `require.resolve` throws). The button's
// onClick payload is therefore covered end-to-end by the e2e audit spec, which
// clicks the real button against a live API; this file's job is the markup.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PendingTokenCard } from './PendingTokenCard';

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'bkg_1',
  leadName: 'Demo Rahul',
  amount: '₹59,50,000.00',
  unitNumber: 'D-102',
  ...over,
});

const render = (bookings: unknown[], busyBookingId?: string | null) =>
  renderToStaticMarkup(
    <PendingTokenCard
      bookings={bookings}
      isLoading={false}
      busyBookingId={busyBookingId}
      onRecord={vi.fn()}
    />
  );

describe('PendingTokenCard', () => {
  it('names the card for the ACTION, not the booking state', () => {
    // "Needs token payment" tells the user what to DO; "HOLD" is the state the
    // database happens to be in, which means nothing to a telecaller.
    const html = render([booking()]);
    expect(html).toContain('Needs token payment');
    expect(html).not.toContain('HOLD');
  });

  it('shows the unit alongside the customer name, unit first', () => {
    const html = render([booking()]);
    expect(html).toContain('Unit D-102');
    expect(html).toContain('Demo Rahul');
    expect(html.indexOf('Unit D-102')).toBeLessThan(html.indexOf('Demo Rahul'));
  });

  it('labels the button with the unit so rows are distinguishable', () => {
    const html = render([
      booking({ id: 'b1', unitNumber: 'D-102', leadName: 'Demo Rahul' }),
      booking({ id: 'b2', unitNumber: 'A-104', leadName: 'Arjun Reddy' }),
    ]);
    // Two identical "Record token" buttons in a list would be ambiguous to a
    // screen-reader user; the accessible name carries the unit.
    expect(html).toMatch(/aria-label="Record token for Unit D-102 · Demo Rahul"/);
    expect(html).toMatch(/aria-label="Record token for Unit A-104 · Arjun Reddy"/);
  });

  it('falls back to the name alone when a row carries no unit', () => {
    const html = render([booking({ unitNumber: undefined })]);
    expect(html).not.toContain('Unit undefined');
    expect(html).not.toContain('Unit null');
    expect(html).toMatch(/aria-label="Record token for Demo Rahul"/);
  });

  it('does not claim a unit for a blank unit number', () => {
    const html = render([booking({ unitNumber: '' })]);
    expect(html).not.toContain('Unit ');
    expect(html).toContain('Demo Rahul');
  });

  it('shows the booking amount, so the outstanding money is visible', () => {
    const html = render([booking()]);
    expect(html).toContain('₹59,50,000.00');
  });

  it('shows its own empty state rather than an empty list', () => {
    const html = render([]);
    expect(html).toContain('None waiting on a token');
    expect(html).not.toContain('Record token');
  });

  it('shows a loading state instead of a misleading empty one', () => {
    const html = renderToStaticMarkup(
      <PendingTokenCard bookings={[]} isLoading busyBookingId={null} onRecord={vi.fn()} />
    );
    expect(html).toContain('Loading');
    // An in-flight load must NOT read as "nothing to do" - that is how a user
    // concludes there is no work and leaves the page.
    expect(html).not.toContain('None waiting on a token');
  });
});
