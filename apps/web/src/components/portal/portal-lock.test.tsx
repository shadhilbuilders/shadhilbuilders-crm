// PortalLock (issue #8 slice 2): the two dead-end states.
// protects= unlinked shows "not linked yet" + a tappable office number, and
//           the no-units state is calm, not an error; fails_when= the phone is
//           missing from the not-linked state when we have one, or a null
//           phone renders a broken tel: link; no_claim= no data fetching.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PortalLock } from './portal-lock';

describe('PortalLock', () => {
  it('not-linked: says so and offers the office phone as a tel: link', () => {
    const html = renderToStaticMarkup(<PortalLock reason="not-linked" officePhone="+91 98765 43210" />);
    expect(html).toContain('not linked yet');
    expect(html).toContain('href="tel:+919876543210"');
    expect(html).toContain('+91 98765 43210');
    expect(html).toContain('min-h-11');
  });

  it('not-linked without a phone: copy-only, never an empty tel: link', () => {
    const html = renderToStaticMarkup(<PortalLock reason="not-linked" officePhone={null} />);
    expect(html).toContain('contact the project office');
    expect(html).not.toContain('tel:');
  });

  it('no-units: reassuring set-up copy, not an error', () => {
    const html = renderToStaticMarkup(<PortalLock reason="no-units" />);
    expect(html).toContain('setting this up');
    expect(html).not.toContain('role="alert"');
  });
});
