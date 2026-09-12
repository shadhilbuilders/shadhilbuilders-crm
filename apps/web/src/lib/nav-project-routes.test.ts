// Org + project-scoped route helpers - SLUG-based URL scheme (2026-09-11).
// URL shape: /[orgSlug]/overview ... ; /[orgSlug]/projects/[projectSlug]/leads
import { describe, expect, it } from 'vitest';

import {
  activeOrgSlugFromPathname,
  activeProjectSlugFromPathname,
  isAdminPathname,
  isNavItemActive,
  isProjectScopedNavPath,
  navItemHref,
  orgHref,
  projectHref,
  stripProjectSegment,
} from './nav';

const ORG = 'shadhil-builders';
const PROJ = 'shadhil-metro-heights';

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

  it('keeps org-level pages unscoped', () => {
    for (const href of [
      '/',
      '/admin/users',
      '/admin/audit',
      '/admin/overview',
      '/admin/projects',
      '/admin/whatsapp-unknown-contacts',
      '/work',
    ]) {
      expect(isProjectScopedNavPath(href)).toBe(false);
    }
  });
});

describe('projectHref', () => {
  it('resolves scoped paths under org + project slug', () => {
    expect(projectHref(ORG, PROJ, '/leads')).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/leads',
    );
    expect(projectHref(ORG, PROJ, '/visits')).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/visits',
    );
    expect(projectHref(ORG, PROJ, '/dashboard')).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    );
    expect(projectHref(ORG, PROJ, '/leads/abc')).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/leads/abc',
    );
  });

  it('keeps the template when org or project is missing', () => {
    expect(projectHref(null, PROJ, '/leads')).toBe('/leads');
    expect(projectHref(ORG, null, '/leads')).toBe('/leads');
    expect(projectHref(null, null, '/leads')).toBe('/leads');
  });
});

describe('orgHref', () => {
  it('prefixes the org slug for org-level pages', () => {
    expect(orgHref(ORG, '/admin/overview')).toBe('/shadhil-builders/admin/overview');
    expect(orgHref(ORG, '/admin/users')).toBe('/shadhil-builders/admin/users');
    expect(orgHref(ORG, '/admin/teams/abc')).toBe('/shadhil-builders/admin/teams/abc');
  });

  it('keeps the template when org is missing', () => {
    expect(orgHref(null, '/admin/overview')).toBe('/admin/overview');
  });
});

describe('navItemHref', () => {
  it('resolves scoped items under org + project slug', () => {
    expect(navItemHref({ href: '/leads' }, ORG, PROJ)).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/leads',
    );
    expect(navItemHref({ href: '/dashboard' }, ORG, PROJ)).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/dashboard',
    );
  });

  it('resolves unscoped items (scoped:false) under just the org slug', () => {
    expect(navItemHref({ href: '/admin/overview', scoped: false }, ORG, PROJ)).toBe(
      '/shadhil-builders/admin/overview',
    );
    expect(navItemHref({ href: '/admin/overview', scoped: false }, ORG, null)).toBe(
      '/shadhil-builders/admin/overview',
    );
    expect(navItemHref({ href: '/admin/overview', scoped: false }, null, null)).toBe(
      '/admin/overview',
    );
  });
});

describe('activeOrgSlugFromPathname', () => {
  it('extracts the org slug from /<orgSlug> paths', () => {
    expect(activeOrgSlugFromPathname('/shadhil-builders/admin/overview')).toBe(ORG);
    expect(
      activeOrgSlugFromPathname('/shadhil-builders/projects/shadhil-metro-heights/leads'),
    ).toBe(ORG);
  });

  it('returns null on bare / and auth routes', () => {
    expect(activeOrgSlugFromPathname('/')).toBeNull();
    expect(activeOrgSlugFromPathname('/login')).toBe('login');
  });
});

describe('activeProjectSlugFromPathname', () => {
  it('extracts the project slug at /<orgSlug>/projects/<projectSlug>', () => {
    expect(
      activeProjectSlugFromPathname('/shadhil-builders/projects/shadhil-metro-heights/leads'),
    ).toBe(PROJ);
    expect(
      activeProjectSlugFromPathname('/shadhil-builders/projects/shadhil-metro-heights/leads/abc123'),
    ).toBe(PROJ);
    expect(
      activeProjectSlugFromPathname('/shadhil-builders/projects/shadhil-metro-heights/dashboard'),
    ).toBe(PROJ);
  });

  it('returns null on org-level and top-level routes', () => {
    expect(activeProjectSlugFromPathname('/')).toBeNull();
    expect(activeProjectSlugFromPathname('/shadhil-builders/admin/overview')).toBeNull();
    expect(activeProjectSlugFromPathname('/shadhil-builders/admin/users')).toBeNull();
    expect(activeProjectSlugFromPathname('/login')).toBeNull();
  });
});

describe('stripProjectSegment', () => {
  it('strips the org + project prefix from work surfaces', () => {
    expect(
      stripProjectSegment('/shadhil-builders/projects/shadhil-metro-heights/leads'),
    ).toBe('/leads');
    expect(
      stripProjectSegment('/shadhil-builders/projects/shadhil-metro-heights/leads/abc'),
    ).toBe('/leads/abc');
  });

  it('strips the org prefix from org-level pages', () => {
    expect(stripProjectSegment('/shadhil-builders/admin/overview')).toBe('/admin/overview');
    expect(stripProjectSegment('/shadhil-builders/admin/users')).toBe('/admin/users');
    expect(stripProjectSegment('/shadhil-builders')).toBe('/');
  });

  it('returns / for bare paths', () => {
    expect(stripProjectSegment('/')).toBe('/');
  });
});

describe('isNavItemActive with org+project segments (integration)', () => {
  it('highlights Leads on /[orgSlug]/projects/[projectSlug]/leads and .../leads/abc', () => {
    expect(
      isNavItemActive(
        '/leads',
        stripProjectSegment('/shadhil-builders/projects/shadhil-metro-heights/leads/abc'),
      ),
    ).toBe(true);
    expect(
      isNavItemActive(
        '/leads',
        stripProjectSegment('/shadhil-builders/projects/shadhil-metro-heights/leads'),
      ),
    ).toBe(true);
  });

  it('does not highlight Dashboard on other project work surfaces', () => {
    expect(
      isNavItemActive(
        '/dashboard',
        stripProjectSegment('/shadhil-builders/projects/shadhil-metro-heights/leads'),
      ),
    ).toBe(false);
  });

  it('highlights Dashboard on /[orgSlug]/projects/[projectSlug]/dashboard', () => {
    expect(
      isNavItemActive(
        '/dashboard',
        stripProjectSegment('/shadhil-builders/projects/shadhil-metro-heights/dashboard'),
      ),
    ).toBe(true);
  });
});

describe('isAdminPathname', () => {
  it('detects the admin namespace under the org slug', () => {
    expect(isAdminPathname('/shadhil-builders/admin')).toBe(true);
    expect(isAdminPathname('/shadhil-builders/admin/users')).toBe(true);
    expect(isAdminPathname('/shadhil-builders/admin/teams/t-1')).toBe(true);
  });

  it('is false for work surfaces and org home', () => {
    expect(isAdminPathname('/shadhil-builders')).toBe(false);
    expect(isAdminPathname('/shadhil-builders/work')).toBe(false);
    expect(
      isAdminPathname('/shadhil-builders/projects/shadhil-metro-heights/leads'),
    ).toBe(false);
  });
});
