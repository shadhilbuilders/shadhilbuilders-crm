// Portal role routing (issue #8 slice 2, D6/D7).
//
// protects= a buyer never lands in the staff shell and staff never land in the
//           portal (no staff preview); an anonymous visitor is sent to login.
// fails_when= CUSTOMER is allowed into the staff area, a staff role is allowed
//           into the portal, or an unknown/anonymous session gets through.
// no_claim= courtesy routing only; RLS and the API 403s are the real wall, and
//           this does not exercise the layout components that call it.
import { describe, expect, it } from 'vitest';

import type { Role } from '@/apis/client';

import { PORTAL_HOME, isPortalRole, redirectForArea } from './portal-routing';

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
