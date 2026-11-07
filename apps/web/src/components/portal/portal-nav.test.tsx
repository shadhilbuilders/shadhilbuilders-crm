// PortalNav (issue #8 slice 2).
// protects= the labelled landmark, current-page marking, 44px targets, safe-area
//           padding, and that the items ARRAY drives it (slice 3 appends);
// fails_when= the landmark label changes, a lone item stretches across the bar,
//           or a second item is not rendered from the array; no_claim= no routing.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PORTAL_NAV_ITEMS, PortalNav } from './portal-nav';

describe('PortalNav', () => {
  it('is <nav aria-label="Portal"> with a single current, 44px, centred item in this slice', () => {
    const html = renderToStaticMarkup(<PortalNav activeHref="/portal" />);
    expect(html).toContain('<nav aria-label="Portal"');
    expect(html.match(/data-qa="portal-nav-item"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('min-h-11');
    expect(html).toContain('justify-center');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(PORTAL_NAV_ITEMS).toHaveLength(1);
  });

  it('renders extra items straight from the array (slice 3 needs no rewrite)', () => {
    const items = [...PORTAL_NAV_ITEMS, { href: '/portal/payments', label: 'Payments', icon: null }];
    const html = renderToStaticMarkup(<PortalNav items={items} activeHref="/portal" />);
    expect(html.match(/data-qa="portal-nav-item"/g)).toHaveLength(2);
    expect(html).toContain('Payments');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
