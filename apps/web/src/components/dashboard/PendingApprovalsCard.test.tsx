// PendingApprovalsCard - the dashboard's "Awaiting approval" list.
//
// T-APPROVE-UNIT-NAME (2026-09-16, owner report): each row showed only the
// customer name, so a manager looking at three pending bookings had no way to
// tell WHICH villa was being taken. The booking's primary identifier is its
// unit/villa number - that is how the business refers to a booking - so the unit
// now leads and the customer name is secondary.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PendingApprovalsCard } from './PendingApprovalsCard';

// `amount` is what the API actually returns: a decimal STRING, not a formatted
// value. Pre-formatting the fixture would hide a formatting bug entirely.
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'bkg_1',
  leadName: 'Priya Sharma',
  amount: '4200000.00',
  unitNumber: 'D-201',
  ...over,
});

// renderToStaticMarkup only, per the repo's standing rule (apps/web has no
// @testing-library/react, verified: `require.resolve` throws). That means the
// Review button's onClick PAYLOAD cannot be exercised here - asserting it would
// only test the `vi.fn()` I passed in. The payload is covered end-to-end by the
// e2e dashboard spec, which clicks the real button and asserts the dialog opens
// naming the unit. This file's job is the rendered markup.
const render = (bookings: unknown[]) =>
  renderToStaticMarkup(
    <PendingApprovalsCard bookings={bookings} isLoading={false} onReview={vi.fn()} />
  );

describe('PendingApprovalsCard', () => {
  it('shows the unit number alongside the customer name', () => {
    const html = render([booking()]);
    expect(html).toContain('Unit D-201');
    expect(html).toContain('Priya Sharma');
    // The unit must LEAD: it is the booking's primary identifier.
    expect(html.indexOf('Unit D-201')).toBeLessThan(html.indexOf('Priya Sharma'));
  });

  it('names the unit in the Review button, so a screen reader user can tell rows apart', () => {
    const html = render([booking({ id: 'b1', unitNumber: 'A-104', leadName: 'Arjun Reddy' })]);
    expect(html).toMatch(/aria-label="Review booking for Unit A-104 · Arjun Reddy"/);
  });

  it('falls back to the name alone when a row carries no unit', () => {
    const html = render([booking({ unitNumber: undefined })]);
    expect(html).toContain('Priya Sharma');
    expect(html).not.toContain('Unit undefined');
    expect(html).not.toContain('Unit null');
    // The accessible name stays meaningful without a unit.
    expect(html).toMatch(/aria-label="Review booking for Priya Sharma"/);
  });

  it('does not label a blank unit as a unit', () => {
    const html = render([booking({ unitNumber: '' })]);
    expect(html).not.toContain('Unit ');
    expect(html).toContain('Priya Sharma');
  });

  it('formats the raw API amount as Indian-grouped currency', () => {
    const html = render([booking({ amount: '4200000.00' })]);
    // Not the raw string: "4200000.00" is unreadable and looks like a bug to a
    // manager scanning money.
    expect(html).not.toContain('4200000.00');
    expect(html).toContain('₹42,00,000.00');
  });

  it('groups a large amount in the Indian system, not thousands', () => {
    // 1,23,45,678 - lakh grouping, so 12,345,678 would be wrong.
    const html = render([booking({ amount: '12345678.00' })]);
    expect(html).toContain('₹1,23,45,678.00');
  });

  it('passes a non-numeric amount through instead of rendering NaN', () => {
    const html = render([booking({ amount: 'not-a-number' })]);
    expect(html).toContain('not-a-number');
    expect(html).not.toContain('NaN');
  });

  it('falls back to "-" only when there is genuinely no amount', () => {
    const html = render([booking({ amount: undefined })]);
    expect(html).not.toContain('NaN');
    expect(html).toContain('-');
  });

  it('shows the token payment that was actually received', () => {
    const html = render([booking({ amount: '4200000.00', tokenAmount: '250000.00' })]);
    // Formatted, and LABELLED: an unlabelled second figure beside the total
    // reads as money owed rather than money received.
    expect(html).toContain('Token received: ₹2,50,000.00');
    expect(html).toMatch(/data-qa="booking-approval-token-amount"/);
  });

  it('omits the token line when no token was recorded', () => {
    // The column is nullable; "₹0.00" would claim a payment that never happened.
    const withNull = render([booking({ tokenAmount: null })]);
    expect(withNull).not.toContain('Token received');
    expect(withNull).not.toMatch(/data-qa="booking-approval-token-amount"/);

    const withUndefined = render([booking({ tokenAmount: undefined })]);
    expect(withUndefined).not.toContain('Token received');
  });

  it('treats a zero token as no token at all', () => {
    const html = render([booking({ tokenAmount: '0' })]);
    expect(html).not.toContain('Token received');
    expect(html).not.toContain('₹0.00');
  });

  it('still shows the total when only the token is missing', () => {
    const html = render([booking({ amount: '4200000.00', tokenAmount: null })]);
    expect(html).toContain('₹42,00,000.00');
    expect(html).not.toContain('Token received');
  });

  it('renders the Review action with the library link variant (hover underline)', () => {
    const html = render([booking()]);
    // The underline comes from the variant, so `hover:underline` must be on the
    // element and there must be no bare static `underline` class.
    expect(html).toContain('hover:underline');
    expect(html).toMatch(/underline-offset-4/);
    // The link colour token, not the variant's default text-primary.
    expect(html).toContain('text-link');
  });

  it('shows the empty state when nothing is awaiting approval', () => {
    const html = render([]);
    expect(html).toContain('No bookings on hold.');
    expect(html).not.toContain('Unit ');
  });
});
