// Dashboard split (2026-09-08) - role-aware root redirect decision.
//
// Tests the pure decision helper in lib/dashboard-redirect.ts (the page
// itself just calls router.replace with the helper's output, so the decision
// logic is what matters and is unit-testable without rendering).
//
// ENGINEER (site engineer, issue #7 slice 1) has exactly one Work surface -
// Inventory - so the root redirect must NOT send them to /dashboard.
import { describe, expect, it } from 'vitest';

import { rootRedirectTarget, workLandingHref, workSurfaceForRole } from '@/lib/dashboard-redirect';

const ORG_SLUG = 'shadhil-builders';
const PROJ = [
  { id: 'proj-1', slug: 'shadhil-metro-heights', name: 'Metro', address: '', reraNumber: null, cmdaNumber: null, createdAt: '' },
];

const ORG_USER = { role: 'MANAGER', organizationId: 'org-1' } as const;

describe('workSurfaceForRole', () => {
  it('ENGINEER lands on /inventory (their only Work surface)', () => {
    expect(workSurfaceForRole('ENGINEER')).toBe('/inventory');
  });

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER'])(
    '%s lands on /dashboard',
    (role) => {
      expect(workSurfaceForRole(role as never)).toBe('/dashboard');
    },
  );

  it('undefined role (SSR default) lands on /dashboard', () => {
    expect(workSurfaceForRole(undefined)).toBe('/dashboard');
  });
});

describe('workLandingHref', () => {
  it('ENGINEER: default project inventory', () => {
    expect(workLandingHref(ORG_SLUG, PROJ, 'ENGINEER')).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/inventory',
    );
  });

  it('MANAGER: default project dashboard', () => {
    expect(workLandingHref(ORG_SLUG, PROJ, 'MANAGER')).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    );
  });

  it('omitted role keeps the dashboard default', () => {
    expect(workLandingHref(ORG_SLUG, PROJ)).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    );
  });

  it('empty registry: /{orgSlug}/work regardless of role', () => {
    expect(workLandingHref(ORG_SLUG, [], 'ENGINEER')).toBe(
      '/shadhil-builders/work',
    );
  });
});

describe('rootRedirectTarget - role-aware root redirect', () => {
  it('expired session (user null): /login', () => {
    expect(rootRedirectTarget(null, PROJ, ORG_SLUG)).toEqual({ kind: 'login' });
  });

  it('ADMIN: command center', () => {
    expect(rootRedirectTarget({ role: 'ADMIN' }, PROJ, ORG_SLUG)).toEqual({
      kind: 'command-center',
    });
  });

  it('OWNER: command center', () => {
    expect(rootRedirectTarget({ role: 'OWNER' }, PROJ, ORG_SLUG)).toEqual({
      kind: 'command-center',
    });
  });

  it('MANAGER: /[orgSlug]/projects/[projectSlug]/dashboard (default project)', () => {
    expect(rootRedirectTarget(ORG_USER, PROJ, ORG_SLUG)).toEqual({
      kind: 'project-work',
      href: '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    });
  });

  it('TELECALLER: /[orgSlug]/projects/[projectSlug]/dashboard (default project)', () => {
    expect(rootRedirectTarget(ORG_USER, PROJ, ORG_SLUG)).toEqual({
      kind: 'project-work',
      href: '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    });
  });

  it('ENGINEER: /[orgSlug]/projects/[projectSlug]/inventory (not dashboard)', () => {
    expect(rootRedirectTarget({ role: 'ENGINEER' }, PROJ, ORG_SLUG)).toEqual({
      kind: 'project-work',
      href: '/shadhil-builders/projects/shadhil-metro-heights/inventory',
    });
  });

  it('ENGINEER + empty registry: /{orgSlug}/work', () => {
    expect(rootRedirectTarget({ role: 'ENGINEER' }, [], ORG_SLUG)).toEqual({
      kind: 'work',
      href: '/shadhil-builders/work',
    });
  });

  it('non-admin with no org slug falls back to /work', () => {
    expect(rootRedirectTarget({ role: 'MANAGER' } as never, PROJ, null)).toEqual({
      kind: 'work',
      href: '/work',
    });
  });

  it('non-admin + empty registry: /{orgSlug}/work (no loop into admin)', () => {
    expect(rootRedirectTarget(ORG_USER, [], ORG_SLUG)).toEqual({
      kind: 'work',
      href: '/shadhil-builders/work',
    });
  });
});
