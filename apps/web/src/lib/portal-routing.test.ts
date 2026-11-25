// Portal role routing (issue #8 slice 2, D6/D7) + the first-login password
// gate (D3).
//
// protects= a buyer never lands in the staff shell and staff never land in the
//           portal (no staff preview); an anonymous visitor is sent to login;
//           a buyer holding a temporary password is pinned to the rotation
//           screen and a rotated buyer is sent back out of it.
// fails_when= CUSTOMER is allowed into the staff area, a staff role is allowed
//           into the portal, an unknown/anonymous session gets through, a gated
//           buyer is allowed to render the portal, or a rotated buyer is left
//           parked on the rotation screen (a dead end).
// no_claim= courtesy routing only; RLS and the API 403s are the real wall, and
//           this does not exercise the layout components that call it.
import { describe, expect, it } from 'vitest';

import type { Role } from '@/apis/client';

import {
  PORTAL_CHANGE_PASSWORD,
  PORTAL_HOME,
  isPortalRole,
  portalGateFor,
  redirectForArea,
} from './portal-routing';

const STAFF: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER', 'ENGINEER'];

describe('portal layout guard', () => {
  it('no session -> /login?next=/portal', () => {
    expect(redirectForArea('portal', undefined)).toBe('/login?next=/portal');
  });

  it.each(STAFF)('%s is sent out of the portal to /', (role) => {
    expect(redirectForArea('portal', role)).toBe('/');
  });

  it('CUSTOMER stays in the portal', () => {
    expect(redirectForArea('portal', 'CUSTOMER')).toBeNull();
  });
});

// redirectForArea is the STAFF shell's guard (area only). The portal answers
// area AND password in one call - see portalGateFor.
describe('portalGateFor - area', () => {
  it('no session is sent to login, remembering the portal', () => {
    expect(portalGateFor({ role: undefined, mustChangePassword: false, pathname: '/portal' })).toBe(
      '/login?next=/portal',
    );
  });

  // protects= the WhatsApp site-update button, which deep-links to
  //   /portal?unit=<id>&photo=<rowId> and relies on the portal opening that photo
  //   full-bleed. A signed-out buyer used to be sent to a hardcoded /portal, so
  //   signing in landed them on the feed and the photo they were notified about
  //   never opened;
  // fails_when= the query is dropped from `next`, left unencoded (so `&photo=`
  //   becomes a parameter of /login rather than of the portal), or a path outside
  //   the portal is remembered as the destination;
  // no_claim= the login form's own validation of `next`, which is the second check.
  it('remembers the deep link, query and all, when there is no session', () => {
    const query = '?unit=unit-1&photo=photo-9';
    const next = encodeURIComponent(`/portal${query}`);
    expect(
      portalGateFor({
        role: undefined,
        mustChangePassword: false,
        pathname: '/portal',
        search: query,
      }),
    ).toBe(`/login?next=${next}`);
  });

  it('remembers a portal sub-page', () => {
    // No query, so the destination stays the readable form.
    expect(
      portalGateFor({
        role: undefined,
        mustChangePassword: true,
        pathname: '/portal/change-password',
        search: '',
      }),
    ).toBe('/login?next=/portal/change-password');
  });

  it('never remembers a destination outside the portal', () => {
    expect(
      portalGateFor({
        role: undefined,
        mustChangePassword: false,
        pathname: '/admin/secrets',
        search: '?x=1',
      }),
    ).toBe(`/login?next=${encodeURIComponent('/portal?x=1')}`);
    expect(
      portalGateFor({ role: undefined, mustChangePassword: false, pathname: '/admin', search: '' }),
    ).toBe('/login?next=/portal');
  });

  it('ignores a search that does not start with a question mark', () => {
    expect(
      portalGateFor({
        role: undefined,
        mustChangePassword: false,
        pathname: '/portal',
        search: 'photo=9',
      }),
    ).toBe('/login?next=/portal');
  });

  it.each(STAFF)('%s is sent out of the portal regardless of the flag', (role) => {
    // Precedence: the area bounce runs BEFORE the password gate, so an armed
    // staff account is never dropped into a customer rotation screen.
    expect(
      portalGateFor({ role, mustChangePassword: true, pathname: PORTAL_CHANGE_PASSWORD }),
    ).toBe('/');
  });

  it('a rotated CUSTOMER on the portal page stays put', () => {
    expect(
      portalGateFor({ role: 'CUSTOMER', mustChangePassword: false, pathname: PORTAL_HOME }),
    ).toBeNull();
  });
});

describe('portalGateFor - first-login rotation (D3)', () => {
  it('a gated buyer is pinned to the rotation screen from the portal home', () => {
    expect(
      portalGateFor({ role: 'CUSTOMER', mustChangePassword: true, pathname: PORTAL_HOME }),
    ).toBe(PORTAL_CHANGE_PASSWORD);
  });

  it('a gated buyer is not bounced off the rotation screen itself', () => {
    // The loop guard: without this the gate would redirect to the page the
    // buyer is already on, forever.
    expect(
      portalGateFor({
        role: 'CUSTOMER',
        mustChangePassword: true,
        pathname: PORTAL_CHANGE_PASSWORD,
      }),
    ).toBeNull();
  });

  it('a gated buyer is pulled back from any other portal route', () => {
    expect(
      portalGateFor({ role: 'CUSTOMER', mustChangePassword: true, pathname: '/portal/anything' }),
    ).toBe(PORTAL_CHANGE_PASSWORD);
  });

  it('a rotated buyer is sent home rather than left on the rotation screen', () => {
    // Dead end otherwise: the page has no Cancel, so a stale tab or a back
    // button would strand them on a form they can no longer submit.
    expect(
      portalGateFor({
        role: 'CUSTOMER',
        mustChangePassword: false,
        pathname: PORTAL_CHANGE_PASSWORD,
      }),
    ).toBe(PORTAL_HOME);
  });
});

describe('staff shell guard', () => {
  it('CUSTOMER is bounced to the portal', () => {
    expect(redirectForArea('staff', 'CUSTOMER')).toBe(PORTAL_HOME);
  });

  it.each(STAFF)('%s stays in the staff shell', (role) => {
    expect(redirectForArea('staff', role)).toBeNull();
  });

  it('root redirect treats only CUSTOMER as a portal role', () => {
    expect(isPortalRole('CUSTOMER')).toBe(true);
    expect(STAFF.some((r) => isPortalRole(r))).toBe(false);
    expect(isPortalRole(undefined)).toBe(false);
  });
});
