// Dashboard split (2026-09-08) - /overview command center guard decision.
//
// Tests the pure decision helper in lib/dashboard-redirect.ts (the page
// renders the command center when the helper returns null, else redirects).
// Slug-based scheme (2026-09-11): project work dashboards live at
// /[orgSlug]/projects/[projectSlug]/dashboard.
import { describe, expect, it } from 'vitest';

import { commandCenterRedirectTarget } from '@/lib/dashboard-redirect';

const ORG_SLUG = 'shadhil-builders';
const PROJ = [
  { id: 'proj-1', slug: 'shadhil-metro-heights', name: 'Metro', address: '', reraNumber: null, cmdaNumber: null, createdAt: '' },
];

describe('commandCenterRedirectTarget - /overview guard', () => {
  it('ADMIN: null (render the command center)', () => {
    expect(commandCenterRedirectTarget('ADMIN', PROJ, ORG_SLUG)).toBeNull();
  });

  it('OWNER: null (render the command center)', () => {
    expect(commandCenterRedirectTarget('OWNER', PROJ, ORG_SLUG)).toBeNull();
  });

  it('MANAGER: /[orgSlug]/projects/[projectSlug]/dashboard (not a dead-end)', () => {
    expect(commandCenterRedirectTarget('MANAGER', PROJ, ORG_SLUG)).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    );
  });

  it('TELECALLER: /[orgSlug]/projects/[projectSlug]/dashboard (not a dead-end)', () => {
    expect(commandCenterRedirectTarget('TELECALLER', PROJ, ORG_SLUG)).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    );
  });

  it('non-admin + empty registry: /[orgSlug]/work (no loop into admin)', () => {
    expect(commandCenterRedirectTarget('TELECALLER', [], ORG_SLUG)).toBe(
      '/shadhil-builders/work',
    );
  });

  it('falls back to unscoped /work when org slug is missing', () => {
    expect(commandCenterRedirectTarget('TELECALLER', PROJ, null)).toBe('/work');
    expect(commandCenterRedirectTarget('TELECALLER', [], null)).toBe('/work');
  });
});
