// PortalNav (issue #8 slice 2, revised 2026-11-09 pass 3).
//
// protects= the labelled landmark, the safe-area bottom inset, a single 44px
//           primary ACTION in this slice (Refresh), the items ARRAY still
//           driving links when slice 3 appends them, and the action slot
//           override;
// fails_when= the landmark label changes, the bar loses the iOS inset, the
//           refresh control disappears, or the items array stops rendering;
// no_claim= static markup only: no query client, no actual refetch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PORTAL_NAV_ITEMS, PortalNav } from './portal-nav';

/** PortalNav renders PortalRefreshButton, which needs a query client. */
const render = (ui: React.ReactElement): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

describe('PortalNav', () => {
  it('is <nav aria-label="Portal"> with the iOS safe-area inset', () => {
    const html = render(<PortalNav />);
    expect(html).toContain('<nav aria-label="Portal"');
    expect(html).toContain('env(safe-area-inset-bottom)');
  });

  // Regression (2026-11-09): the bar used to hold a "Progress" link to the page
  // the buyer is already on - a nav item that navigates nowhere. The slot is
  // now the one real action: refresh the progress feed.
  it('carries the primary Refresh action instead of a self-referential link', () => {
    const html = render(<PortalNav />);
    expect(html).toContain('data-qa="portal-nav-refresh"');
    expect(html).toContain('Refresh');
    expect(html).not.toContain('data-qa="portal-nav-item"');
    expect(PORTAL_NAV_ITEMS).toHaveLength(0);
  });

  it('styles the action as a filled primary button with a 44px target', () => {
    const html = render(<PortalNav />);
    expect(html).toContain('min-h-11');
    // `variant` is the STYLE (solid/surface/outline/…) and `color` is the hue.
    // variant="primary" silently yields no fill because that key does not exist
    // in BUTTON_COLOR_VARIANT_MAPPING; solid+primary is the filled primary.
    expect(html).toContain('bg-primary');
    expect(html).toContain('text-primary-foreground');
    expect(html).toContain('rounded-full');
  });

  // Regression: a solo max-w-xs button inside a wider bar left-aligns unless
  // the action slot itself is centered (mx-auto on the width-capped wrapper).
  it('centers the solo Refresh action in the bar', () => {
    const html = render(<PortalNav />);
    expect(html).toContain('mx-auto w-full max-w-xs');
  });

  it('ships a polite live region for refresh feedback, not focus-stealing', () => {
    const html = render(<PortalNav />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // An interruption would use assertive; a refresh must not steal reading.
    expect(html).not.toContain('aria-live="assertive"');
    // Idle state: enabled, labelled for screen readers.
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('aria-label="Refresh your progress"');
  });

  it('renders extra links straight from the array (slice 3 needs no rewrite)', () => {
    const items = [...PORTAL_NAV_ITEMS, { href: '/portal/payments', label: 'Payments', icon: null }];
    const html = render(<PortalNav items={items} />);
    expect(html.match(/data-qa="portal-nav-item"/g)).toHaveLength(1);
    expect(html).toContain('Payments');
    // The action survives alongside the links.
    expect(html).toContain('data-qa="portal-nav-refresh"');
  });

  it('accepts an action override for a slice that needs a different primary', () => {
    const html = render(<PortalNav action={<button type="button">Pay now</button>} />);
    expect(html).toContain('Pay now');
    expect(html).not.toContain('data-qa="portal-nav-refresh"');
  });
});
