// isSiteRole (2026-11-08): which roles own the site capture surface.
//
// The rule is small and load-bearing - it gates two routes, the nav entry swap,
// and the inventory money columns - so it is pinned here rather than trusted.
import { describe, expect, it } from 'vitest';

import { isSiteOnlyRole, isSiteRole } from './session';

describe('isSiteRole', () => {
  it('is true for the two site roles', () => {
    expect(isSiteRole('ENGINEER')).toBe(true);
    expect(isSiteRole('TELECALLER')).toBe(true);
  });

  it('is false for every other role, including undefined', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'CUSTOMER'] as const) {
      expect(isSiteRole(role)).toBe(false);
    }
    // The SSR default: no session yet is not a site role, so the site routes
    // redirect a not-yet-hydrated visitor rather than rendering for them.
    expect(isSiteRole(undefined)).toBe(false);
  });
});

// `isSiteOnlyRole` is the narrower question behind the `/inventory` route gate:
// which role may not open the SALES grid at all. It is separate from
// `isSiteRole` because a telecaller READS inventory as part of the lead job, and
// conflating the two would bounce them out of a grid they need.
describe('isSiteOnlyRole', () => {
  it('is true for ENGINEER only', () => {
    expect(isSiteOnlyRole('ENGINEER')).toBe(true);
  });

  it('is false for TELECALLER despite them being a site role', () => {
    // The distinction this helper exists for: TELECALLER gains /site but keeps
    // the lead inbox, the dashboard queue and read access to inventory.
    expect(isSiteRole('TELECALLER')).toBe(true);
    expect(isSiteOnlyRole('TELECALLER')).toBe(false);
  });

  it('is false for every other role, including undefined', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'CUSTOMER'] as const) {
      expect(isSiteOnlyRole(role)).toBe(false);
    }
    expect(isSiteOnlyRole(undefined)).toBe(false);
  });
});
