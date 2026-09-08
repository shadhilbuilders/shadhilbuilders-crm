// Dashboard split (2026-09-08) - /overview command center guard decision.
//
// Tests the pure decision helper in lib/dashboard-redirect.ts (the page
// renders the command center when the helper returns null, else redirects).
import { describe, expect, it } from 'vitest';

import { commandCenterRedirectTarget } from '@/lib/dashboard-redirect';

const PROJ = [
  { id: 'proj-1', slug: 'shadhil-metro-heights', name: 'Metro', address: '', reraNumber: null, cmdaNumber: null, createdAt: '' },
];

describe('commandCenterRedirectTarget - /overview guard', () => {
  it('ADMIN: null (render the command center)', () => {
    expect(commandCenterRedirectTarget('ADMIN', PROJ)).toBeNull();
  });

  it('OWNER: null (render the command center)', () => {
    expect(commandCenterRedirectTarget('OWNER', PROJ)).toBeNull();
  });

  it('MANAGER: /{projectId}/dashboard (not a dead-end)', () => {
    expect(commandCenterRedirectTarget('MANAGER', PROJ)).toBe('/proj-1/dashboard');
  });

  it('TELECALLER: /{projectId}/dashboard (not a dead-end)', () => {
    expect(commandCenterRedirectTarget('TELECALLER', PROJ)).toBe('/proj-1/dashboard');
  });

  it('non-admin + empty registry: /projects (no loop)', () => {
    expect(commandCenterRedirectTarget('TELECALLER', [])).toBe('/projects');
  });
});
