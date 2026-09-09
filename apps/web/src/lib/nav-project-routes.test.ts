// Project-scoped route helpers - T-ProjectSwitch (2026-09-05).
import { describe, expect, it } from 'vitest';

import {
  activeProjectIdFromPathname,
  isNavItemActive,
  isProjectScopedNavPath,
  navItemHref,
  projectHref,
  stripProjectSegment,
} from './nav';

describe('isProjectScopedNavPath', () => {
  it('marks the work surfaces as project-scoped', () => {
    for (const href of [
      '/dashboard',
      '/leads',
      '/visits',
      '/inventory',
      '/bookings',
      '/notifications',
    ]) {
      expect(isProjectScopedNavPath(href)).toBe(true);
    }
  });

  it('treats nested work-surface paths as scoped', () => {
    expect(isProjectScopedNavPath('/leads/abc')).toBe(true);
    expect(isProjectScopedNavPath('/bookings/new')).toBe(true);
  });

  it('keeps users/audit/home unscoped', () => {
    for (const href of ['/', '/users', '/audit', '/whatsapp-unknown-contacts']) {
      expect(isProjectScopedNavPath(href)).toBe(false);
    }
  });
});

describe('projectHref', () => {
  it('resolves scoped paths under the active project', () => {
    expect(projectHref('proj-1', '/leads')).toBe('/proj-1/leads');
    expect(projectHref('proj-1', '/visits')).toBe('/proj-1/visits');
    expect(projectHref('proj-1', '/dashboard')).toBe('/proj-1/dashboard');
    expect(projectHref('proj-1', '/leads/abc')).toBe('/proj-1/leads/abc');
  });

  it('passes unscoped paths through unchanged', () => {
    expect(projectHref('proj-1', '/')).toBe('/');
    expect(projectHref('proj-1', '/users')).toBe('/users');
  });

  it('keeps the template when no project is active', () => {
    expect(projectHref(null, '/leads')).toBe('/leads');
  });
});

describe('navItemHref', () => {
  it('resolves scoped items under the active project', () => {
    expect(navItemHref({ href: '/leads' }, 'proj-1')).toBe('/proj-1/leads');
    expect(navItemHref({ href: '/dashboard' }, 'proj-1')).toBe('/proj-1/dashboard');
  });

  it('passes unscoped items (scoped:false) through unchanged', () => {
    expect(navItemHref({ href: '/overview', scoped: false }, 'proj-1')).toBe(
      '/overview',
    );
    expect(navItemHref({ href: '/overview', scoped: false }, null)).toBe(
      '/overview',
    );
  });

  it('keeps the template for scoped items when no project is active', () => {
    expect(navItemHref({ href: '/leads' }, null)).toBe('/leads');
  });
});

describe('activeProjectIdFromPathname', () => {
  it('extracts the first segment on work surfaces', () => {
    expect(activeProjectIdFromPathname('/proj-1/leads')).toBe('proj-1');
    expect(
      activeProjectIdFromPathname('/proj-1/leads/abc123'),
    ).toBe('proj-1');
  });

  it('returns null on top-level routes', () => {
    expect(activeProjectIdFromPathname('/')).toBeNull();
    expect(activeProjectIdFromPathname('/users')).toBeNull();
    expect(activeProjectIdFromPathname('/leads')).toBeNull();
    expect(activeProjectIdFromPathname('/login')).toBeNull();
  });
});

describe('stripProjectSegment', () => {
  it('strips the project segment', () => {
    expect(stripProjectSegment('/proj-1/leads')).toBe('/leads');
    expect(stripProjectSegment('/proj-1/leads/abc')).toBe('/leads/abc');
  });

  it('returns / for single-segment paths', () => {
    expect(stripProjectSegment('/proj-1')).toBe('/');
    expect(stripProjectSegment('/')).toBe('/');
  });
});

describe('isNavItemActive with project segments (integration)', () => {
  it('highlights Leads on /proj-1/leads and /proj-1/leads/abc', () => {
    const stripped = stripProjectSegment('/proj-1/leads/abc');
    expect(isNavItemActive('/leads', stripped)).toBe(true);
    const inbox = stripProjectSegment('/proj-1/leads');
    expect(isNavItemActive('/leads', inbox)).toBe(true);
  });

  it('does not highlight Dashboard on other project work surfaces', () => {
    expect(
      isNavItemActive('/dashboard', stripProjectSegment('/proj-1/leads')),
    ).toBe(false);
  });

  it('highlights Dashboard on /proj-1/dashboard', () => {
    expect(
      isNavItemActive('/dashboard', stripProjectSegment('/proj-1/dashboard')),
    ).toBe(true);
  });
});