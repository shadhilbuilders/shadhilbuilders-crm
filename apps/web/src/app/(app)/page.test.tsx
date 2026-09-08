// Dashboard split (2026-09-08) - role-aware root redirect decision.
//
// Tests the pure decision helper in lib/dashboard-redirect.ts (the page
// itself just calls router.replace with the helper's output, so the decision
// logic is what matters and is unit-testable without rendering).
import { describe, expect, it } from 'vitest';

import { rootRedirectTarget } from '@/lib/dashboard-redirect';

const PROJ = [
  { id: 'proj-1', slug: 'shadhil-metro-heights', name: 'Metro', address: '', reraNumber: null, cmdaNumber: null, createdAt: '' },
];

describe('rootRedirectTarget - role-aware root redirect', () => {
  it('expired session (user null): /login', () => {
    expect(rootRedirectTarget(null, PROJ)).toEqual({ kind: 'login' });
  });

  it('ADMIN: /overview (command center)', () => {
    expect(rootRedirectTarget({ role: 'ADMIN' }, PROJ)).toEqual({
      kind: 'command-center',
    });
  });

  it('OWNER: /overview (command center)', () => {
    expect(rootRedirectTarget({ role: 'OWNER' }, PROJ)).toEqual({
      kind: 'command-center',
    });
  });

  it('MANAGER: /{projectId}/dashboard (default project)', () => {
    expect(rootRedirectTarget({ role: 'MANAGER' }, PROJ)).toEqual({
      kind: 'project-dashboard',
      href: '/proj-1/dashboard',
    });
  });

  it('TELECALLER: /{projectId}/dashboard (default project)', () => {
    expect(rootRedirectTarget({ role: 'TELECALLER' }, PROJ)).toEqual({
      kind: 'project-dashboard',
      href: '/proj-1/dashboard',
    });
  });

  it('SALES_EXEC: /{projectId}/dashboard (default project)', () => {
    expect(rootRedirectTarget({ role: 'SALES_EXEC' }, PROJ)).toEqual({
      kind: 'project-dashboard',
      href: '/proj-1/dashboard',
    });
  });

  it('non-admin + empty registry: /projects (no loop)', () => {
    expect(rootRedirectTarget({ role: 'TELECALLER' }, [])).toEqual({
      kind: 'projects',
    });
  });
});
