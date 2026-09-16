// @vitest-environment node
// lib/bookings.ts - the post-create destination rule.
//
// Why a helper instead of inlining the redirect: the decision lived inside a
// mutation callback, which is only reachable by submitting a form. This repo
// has no @testing-library/react, so that path had NO coverage - which is how
// the wrong destination (the parent lead's page) survived. The rule is pure, so
// it is asserted here and the page just calls it.
import { describe, expect, it } from 'vitest';

import { afterBookingCreateHref } from './bookings';
import { projectHref } from './nav';

describe('afterBookingCreateHref', () => {
  it('sends the operator to the BOOKINGS LIST', () => {
    const href = afterBookingCreateHref('shadhil-builders', 'metro-heights');
    expect(href).toBe(projectHref('shadhil-builders', 'metro-heights', '/bookings'));
    expect(href).toContain('/bookings');
  });

  it('is NOT the parent lead page', () => {
    // The regression this pins: the form used to push `/leads/:id`, a page that
    // renders no booking panel, so creating a booking looked like a no-op.
    const href = afterBookingCreateHref('org-a', 'proj-a');
    expect(href).not.toContain('/leads');
  });

  it('is the list, not a booking detail deep link', () => {
    // The target must not depend on the created row's id.
    const href = afterBookingCreateHref('org-a', 'proj-a');
    expect(href.endsWith('/bookings')).toBe(true);
    expect(href).not.toMatch(/\/bookings\/.+/);
  });

  it('degrades safely when the slugs are not resolved yet', () => {
    // The tenant context can be null during the first client render; the helper
    // must still return a usable path rather than throwing or emitting
    // "undefined".
    const href = afterBookingCreateHref(null, null);
    expect(href).not.toContain('undefined');
    expect(href).not.toContain('null');
    expect(href).toContain('/bookings');
  });
});
