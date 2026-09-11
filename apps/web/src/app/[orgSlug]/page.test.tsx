// Dashboard split (2026-09-08) - role-aware root redirect decision.
//
// Tests the pure decision helper in lib/dashboard-redirect.ts (the page
// itself just calls router.replace with the helper's output, so the decision
// logic is what matters and is unit-testable without rendering).
import { describe, expect, it } from 'vitest';

import { rootRedirectTarget } from '@/lib/dashboard-redirect';

const ORG_SLUG = 'shadhil-builders';
const PROJ = [
  { id: 'proj-1', slug: 'shadhil-metro-heights', name: 'Metro', address: '', reraNumber: null, cmdaNumber: null, createdAt: '' },
];

const ORG_USER = { role: 'MANAGER', organizationId: 'org-1' } as const;

describe('rootRedirectTarget - role-aware root redirect', () => {
  it('expired session (user null): /login', () => {
    expect(rootRedirectTarget(null, PROJ, ORG_SLUG)).toEqual({ kind: 'login' });
  });

  it('ADMIN: /overview (command center)', () => {
    expect(rootRedirectTarget({ role: 'ADMIN' }, PROJ, ORG_SLUG)).toEqual({
      kind: 'command-center',
    });
  });

  it('OWNER: /overview (command center)', () => {
    expect(rootRedirectTarget({ role: 'OWNER' }, PROJ, ORG_SLUG)).toEqual({
      kind: 'command-center',
    });
  });

  it('MANAGER: /[orgSlug]/projects/[projectSlug]/dashboard (default project)', () => {
    expect(rootRedirectTarget(ORG_USER, PROJ, ORG_SLUG)).toEqual({
      kind: 'project-dashboard',
      href: '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    });
  });

  it('TELECALLER: /[orgSlug]/projects/[projectSlug]/dashboard (default project)', () => {
    expect(rootRedirectTarget(ORG_USER, PROJ, ORG_SLUG)).toEqual({
      kind: 'project-dashboard',
      href: '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    });
  });

  it('non-admin with no org slug falls back to /projects (no dead-end URL)', () => {
    expect(rootRedirectTarget({ role: 'MANAGER' } as never, PROJ, null)).toEqual({
      kind: 'projects',
    });
  });

  it('non-admin + empty registry: /projects (no loop)', () => {
    expect(rootRedirectTarget(ORG_USER, [], ORG_SLUG)).toEqual({
      kind: 'projects',
    });
  });
});
