// @vitest-environment node
// T15: pure-function tests for `lib/nav.ts`.
//
// These tests assert the visibility + active-state rules without
// rendering, so the nav source-of-truth changes can be unit-tested.
// The plan locks (DESIGN.md §4 + plan §11 T1 + T15):
//   - "Admin" group renders only when at least one admin item is
//     visible; specifically: `/users` for `canManageUsers(role)` and
//     `/audit` for `canViewAudit(role)`.
//   - Active-state: `/` is exact-only; everything else is a prefix
//     match so `/leads/abc` still highlights the `Leads` menu item.
//   - `NAV_ITEMS` is the single source of truth - both shells read it,
//     so an addition must not silently re-introduce admin items in
//     the topbar.
import { describe, expect, it } from 'vitest';

import {
  getVisibleNav,
  isNavItemActive,
  navItemHref,
  NAV_ITEMS,
  type NavItem,
} from '@/lib/nav';

/**
 * Flatten a getVisibleNav() result into all hrefs, descending into any
 * submenu `children`. Lets tests assert a route is visible regardless of
 * whether it's top-level or nested (e.g. WA Unknown inside the WhatsApp
 * submenu).
 */
function flattenNavHrefs(items: readonly NavItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    out.push(item.href);
    if (item.children !== undefined) out.push(...flattenNavHrefs(item.children));
  }
  return out;
}

describe('lib/nav', () => {
  describe('NAV_ITEMS - the single source of truth', () => {
    it('contains exactly one work dashboard entry at /dashboard and one admin Overview at /admin/overview', () => {
      const workDashboards = NAV_ITEMS.filter(
        (item) => item.href === '/dashboard' && item.group === 'work',
      );
      const adminDashboards = NAV_ITEMS.filter(
        (item) => item.href === '/admin/overview' && item.group === 'admin',
      );
      expect(workDashboards).toHaveLength(1);
      expect(adminDashboards).toHaveLength(1);
      expect(adminDashboards[0]!.scoped).toBe(false);
    });

    it('every work-group item has a valid shape', () => {
      for (const item of NAV_ITEMS) {
        expect(item.href).toMatch(/^\//);
        expect(item.label.length).toBeGreaterThan(0);
        expect(typeof item.icon).toBe('function');
        expect(['work', 'admin']).toContain(item.group);
      }
    });

    it('no duplicate hrefs within a group', () => {
      const seen = new Set<string>();
      for (const item of NAV_ITEMS) {
        const key = `${item.group}:${item.href}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });
  });

  describe('getVisibleNav - role gating', () => {
    const workHrefs = [
      '/dashboard',
      '/leads',
      '/visits',
      '/staff',
      '/inventory',
      '/bookings',
      '/notifications',
    ];
    // T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER additionally sees
    // My Teams (design doc UI1) - every other staff role does not.
    // T-WA-INBOX (2026-09-25): the WhatsApp Chats inbox is
    // MANAGER/ADMIN/OWNER only, so it is NOT in workHrefs (which every staff
    // role sees) - it joins the manager set instead.
    // Received order is the NAV_ITEMS declaration order: /whatsapp-chat sits
    // in the work group before /notifications, and /my-teams comes last.
    const managerHrefs = [
      '/dashboard',
      '/leads',
      '/visits',
      '/staff',
      '/inventory',
      '/bookings',
      '/whatsapp-chat',
      '/notifications',
      '/my-teams',
    ];

    it('TELECALLER sees only the work group (no Admin launcher, no admin items)', () => {
      const items = getVisibleNav('TELECALLER');
      expect(items.map((i) => i.href)).toEqual(workHrefs);
      expect(flattenNavHrefs(items)).not.toContain('/admin');
      expect(flattenNavHrefs(items)).not.toContain('/admin/users');
    });

    it('SALES_EXEC sees only the work group (no admin items)', () => {
      expect(getVisibleNav('SALES_EXEC').map((i) => i.href)).toEqual(workHrefs);
    });

    it('MANAGER sees only the work group + My Teams (Users / Projects / WA Unknown are admin-only)', () => {
      const hrefs = flattenNavHrefs(getVisibleNav('MANAGER'));
      expect(hrefs).toEqual(managerHrefs);
      expect(hrefs).not.toContain('/admin');
      expect(hrefs).not.toContain('/admin/users');
      expect(hrefs).not.toContain('/admin/projects');
      expect(hrefs).not.toContain('/admin/whatsapp-unknown-contacts');
      expect(hrefs).not.toContain('/admin/teams');
      expect(hrefs).not.toContain('/admin/feedback');
    });

    it('ADMIN sees the Admin launcher on the work group plus the admin namespace', () => {
      const items = getVisibleNav('ADMIN');
      const hrefs = flattenNavHrefs(items);
      expect(hrefs).toContain('/admin');
      expect(hrefs).toContain('/admin/overview');
      expect(hrefs).toContain('/admin/users');
      expect(hrefs).toContain('/admin/projects');
      expect(hrefs).toContain('/admin/teams');
      expect(hrefs).toContain('/admin/audit');
      expect(hrefs).toContain('/admin/feedback');
      expect(hrefs).toContain('/admin/whatsapp-unknown-contacts');
      const overview = items.find(
        (i) => i.href === '/admin/overview' && i.group === 'admin',
      );
      expect(overview?.scoped).toBe(false);
    });

    it('OWNER sees the Admin launcher and admin namespace (admin-class)', () => {
      const hrefs = flattenNavHrefs(getVisibleNav('OWNER'));
      expect(hrefs).toContain('/admin');
      expect(hrefs).toContain('/admin/overview');
      expect(hrefs).toContain('/admin/users');
      expect(hrefs).toContain('/admin/audit');
    });

    it('TELECALLER does NOT see the Overview command center', () => {
      const items = getVisibleNav('TELECALLER');
      expect(
        items.find((i) => i.href === '/admin/overview' && i.group === 'admin'),
      ).toBeUndefined();
    });

    it('undefined role sees only the work group without Admin (safe default)', () => {
      const items = getVisibleNav(undefined);
      expect(items.filter((i) => i.group === 'admin')).toEqual([]);
      expect(items.map((i) => i.href)).not.toContain('/admin');
    });
  });

  describe('isNavItemActive - active-state rules', () => {
    it('Dashboard (`/dashboard`) is active on `/dashboard` and `/dashboard/*`', () => {
      expect(isNavItemActive('/dashboard', '/dashboard')).toBe(true);
      expect(isNavItemActive('/dashboard', '/dashboard/extra')).toBe(true);
      expect(isNavItemActive('/dashboard', '/leads')).toBe(false);
    });

    it('Leads (`/leads`) is active on `/leads` and `/leads/*`', () => {
      expect(isNavItemActive('/leads', '/leads')).toBe(true);
      expect(isNavItemActive('/leads', '/leads/abc')).toBe(true);
      expect(isNavItemActive('/leads', '/leadssomething')).toBe(false);
    });

    it('Visits (`/visits`) is active on `/visits` and `/visits/*`', () => {
      expect(isNavItemActive('/visits', '/visits')).toBe(true);
      expect(isNavItemActive('/visits', '/visits/2024-01-15')).toBe(true);
      expect(isNavItemActive('/visits', '/visit')).toBe(false);
    });

    it('Users (`/admin/users`) is active on `/admin/users` and nested paths', () => {
      expect(isNavItemActive('/admin/users', '/admin/users')).toBe(true);
      expect(isNavItemActive('/admin/users', '/admin/users/123')).toBe(true);
      expect(isNavItemActive('/admin/users', '/admin/audit')).toBe(false);
    });

    it('Admin launcher (`/admin`) is exact-only so `/admin/users` does not highlight it', () => {
      expect(isNavItemActive('/admin', '/admin')).toBe(true);
      expect(isNavItemActive('/admin', '/admin/users')).toBe(false);
    });

    it('WhatsApp Chats (`/whatsapp-chat`) is active on the page and nested paths', () => {
      expect(isNavItemActive('/whatsapp-chat', '/whatsapp-chat')).toBe(true);
      expect(isNavItemActive('/whatsapp-chat', '/whatsapp-chat/abc')).toBe(true);
      expect(isNavItemActive('/whatsapp-chat', '/whatsapp-chats')).toBe(false);
    });
  });

  // T-WA-INBOX: the chat inbox is a managers-and-above page. The nav item is
  // the FIRST of three gates (nav hidden -> page re-checks -> backend 403), so
  // this rule is worth pinning: a role regression here would expose a page
  // whose whole purpose is customer conversations.
  describe('WhatsApp Chats visibility (MANAGER/ADMIN/OWNER only)', () => {
    const href = '/whatsapp-chat';

    it('is visible to MANAGER, ADMIN and OWNER', () => {
      for (const role of ['MANAGER', 'ADMIN', 'OWNER'] as const) {
        expect(flattenNavHrefs(getVisibleNav(role))).toContain(href);
      }
    });

    it('is hidden from TELECALLER and SALES_EXEC', () => {
      for (const role of ['TELECALLER', 'SALES_EXEC'] as const) {
        expect(flattenNavHrefs(getVisibleNav(role))).not.toContain(href);
      }
    });

    it('is hidden from an undefined role (no session yet)', () => {
      expect(flattenNavHrefs(getVisibleNav(undefined))).not.toContain(href);
    });

    // The href attribute is what the sidebar actually navigates to, and it is
    // NOT the same as `item.href`: every page lives under /[orgSlug]/, so an
    // item that resolves to the bare template path matches no route and 404s.
    // This is how the inbox shipped broken - the nav item lacked
    // `scoped: false`, so navItemHref returned '/whatsapp-chat' unchanged.
    it('resolves to an org-scoped href (a bare /whatsapp-chat 404s)', () => {
      const item = getVisibleNav('OWNER').find((i) => i.href === href)!;
      expect(navItemHref(item, 'shadhil-builders', 'any-project')).toBe(
        '/shadhil-builders/whatsapp-chat',
      );
      // ...and it must NOT be project-nested, which is what the default
      // scoping would do if the path were ever added to PROJECT_SCOPED_PATHS.
      expect(navItemHref(item, 'shadhil-builders', 'any-project')).not.toContain('/projects/');
    });

    it('stays org-level even with no active project (inbox is org-wide)', () => {
      const item = getVisibleNav('MANAGER').find((i) => i.href === href)!;
      expect(navItemHref(item, 'shadhil-builders', null)).toBe(
        '/shadhil-builders/whatsapp-chat',
      );
    });
  });
});
