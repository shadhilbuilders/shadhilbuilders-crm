// Who may request the staff org list (2026-11-10).
//
// Regression guard for the 403 on the portal landing path: a CUSTOMER's
// `GET /organizations` is refused by the backend's mustChangePassword gate, so
// the root `/` page must not ask for it at all. Before `shouldResolveOrgSlug`
// existed, `useOrgSlugForId` fired the query on mount - before the role was
// even known - and every buyer visit to `/` logged a guaranteed 403.
import { describe, expect, it } from 'vitest';

import type { Role } from '@/apis/client';

import { shouldResolveOrgSlug } from './organizations';

const STAFF: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER', 'ENGINEER'];

describe('shouldResolveOrgSlug', () => {
  it.each(STAFF)('%s with an org id may resolve the slug', (role) => {
    expect(shouldResolveOrgSlug({ role, isPending: false, organizationId: 'org-1' })).toBe(true);
  });

  // The whole point: a buyer is refused by the API, so the request must not be
  // made. Note this is NOT "is the role a buyer" - the pending case below is
  // equally load-bearing.
  it('a CUSTOMER never asks, even with an org id', () => {
    expect(
      shouldResolveOrgSlug({ role: 'CUSTOMER', isPending: false, organizationId: 'org-1' }),
    ).toBe(false);
  });

  it('nobody asks while the session is still resolving', () => {
    // This is the case that produced the bug: on first paint the role is
    // undefined and the query fired anyway, so a buyer's page issued a 403
    // before it could know it was a buyer.
    for (const role of [undefined, ...STAFF, 'CUSTOMER'] as (Role | undefined)[]) {
      expect(shouldResolveOrgSlug({ role, isPending: true, organizationId: 'org-1' })).toBe(false);
    }
  });

  it('an anonymous session never asks', () => {
    expect(shouldResolveOrgSlug({ role: undefined, isPending: false, organizationId: 'org-1' })).toBe(
      false,
    );
  });

  it.each([null, undefined, ''])(
    'a staff role with no org id (%s) never asks',
    (organizationId) => {
      expect(shouldResolveOrgSlug({ role: 'MANAGER', isPending: false, organizationId })).toBe(false);
    },
  );
});
