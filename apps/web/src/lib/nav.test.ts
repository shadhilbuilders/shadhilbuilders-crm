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
  ADMIN_LAUNCHER,
  adminLauncherHref,
  adminLauncherHrefFor,
  getVisibleNav,
  isNavItemActive,
  navItemHref,
  NAV_ITEMS,
  type NavItem,
} from '@/lib/nav';
import { isAdminLike } from '@/lib/session';

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
      '/plots',
      '/bookings',
      '/notifications',
    ];
    // T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER additionally sees
    // My Team (design doc UI1) - every other staff role does not.
    // T-WA-INBOX (2026-09-25): the WhatsApp Chats inbox is
    // MANAGER/ADMIN/OWNER only, so it is NOT in workHrefs (which every staff
    // role sees) - it joins the manager set instead.
    // Received order is the NAV_ITEMS declaration order: /whatsapp-chat sits
    // in the work group before /notifications, and /my-team comes after /visits.
    const managerHrefs = [
      '/dashboard',
      '/leads',
      '/visits',
      '/my-team',
      '/staff',
      '/inventory',
      '/site',
      '/plots',
      '/bookings',
      '/whatsapp-chat',
      '/notifications',
    ];

    it('TELECALLER sees their work group but NOT the site surface', () => {
      // 2026-11-10: /site is for ENGINEER (capture) and MANAGER/ADMIN/OWNER
      // (review). TELECALLER keeps the Lead Inbox (DESIGN.md §1) and sees no
      // Inventory (hidden for site roles) and no Site updates.
      const hrefs = flattenNavHrefs(getVisibleNav('TELECALLER'));
      expect(hrefs).toEqual([
        '/dashboard',
        '/leads',
        '/visits',
        '/staff',
        '/plots',
        '/bookings',
        '/notifications',
      ]);
      expect(hrefs).not.toContain('/inventory');
      expect(hrefs).not.toContain('/site');
    });

    it('ENGINEER sees Site updates + Notifications INSTEAD of Inventory', () => {
      const hrefs = flattenNavHrefs(getVisibleNav('ENGINEER'));
      expect(hrefs).toEqual(['/site', '/notifications']);
      expect(hrefs).not.toContain('/inventory');
    });

    it('SALES_EXEC sees only the work group (no admin items)', () => {
      expect(getVisibleNav('SALES_EXEC').map((i) => i.href)).toEqual(workHrefs);
    });

    it('MANAGER, ADMIN and OWNER are offered Site updates (read-only review)', () => {
      for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) {
        expect(flattenNavHrefs(getVisibleNav(role))).toContain('/site');
      }
    });

    it('SALES_EXEC and TELECALLER are not offered Site updates', () => {
      for (const role of ['SALES_EXEC', 'TELECALLER'] as const) {
        expect(flattenNavHrefs(getVisibleNav(role))).not.toContain('/site');
      }
    });

    it('MANAGER sees only the work group + My Team (Users / Projects / WA Unknown are admin-only)', () => {
      const hrefs = flattenNavHrefs(getVisibleNav('MANAGER'));
      expect(hrefs).toEqual(managerHrefs);
      expect(hrefs).not.toContain('/admin');
      expect(hrefs).not.toContain('/admin/users');
      expect(hrefs).not.toContain('/admin/projects');
      expect(hrefs).not.toContain('/admin/whatsapp-unknown-contacts');
      expect(hrefs).not.toContain('/admin/teams');
      expect(hrefs).not.toContain('/admin/feedback');
    });

    it('ADMIN sees the admin namespace, and the /admin launcher is NOT a nav item (it is the account-menu switch)', () => {
      const items = getVisibleNav('ADMIN');
      const hrefs = flattenNavHrefs(items);
      // 2026-11-09: entering admin moved to the account menu ("Switch Admin").
      // If `/admin` ever reappears here it also reappears in the sidebar.
      expect(hrefs).not.toContain('/admin');
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

    it('OWNER sees the admin namespace (admin-class) without an /admin nav item', () => {
      const hrefs = flattenNavHrefs(getVisibleNav('OWNER'));
      expect(hrefs).not.toContain('/admin');
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

    it('TELECALLER sees neither /inventory nor /site', () => {
      const hrefs = flattenNavHrefs(getVisibleNav('TELECALLER'));
      expect(hrefs).not.toContain('/site');
      expect(hrefs).not.toContain('/inventory');
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

    // 2026-11-09: the launcher is an exported constant consumed by the account
    // menus (topbar UserMenu + sidebar NavUser) instead of a NAV_ITEMS entry.
    describe('ADMIN_LAUNCHER - the account-menu "Switch Admin" row', () => {
      it('carries the label the owner asked for', () => {
        expect(ADMIN_LAUNCHER.label).toBe('Switch Admin');
      });

      it('is not in NAV_ITEMS (that array is sidebar pages only)', () => {
        expect(NAV_ITEMS.map((i) => i.href)).not.toContain(ADMIN_LAUNCHER.href);
      });

      it('resolves under the org slug, and stays a template path without one', () => {
        expect(adminLauncherHref('shadhil-builders')).toBe('/shadhil-builders/admin');
        // null: callers hide the row rather than linking to a route-less /admin.
        expect(adminLauncherHref(null)).toBe('/admin');
      });

      it('shows the row for OWNER/ADMIN on a work route with a resolved slug', () => {
        for (const role of ['OWNER', 'ADMIN'] as const) {
          expect(
            adminLauncherHrefFor(role, '/shadhil-builders/projects/metro-heights/leads', 'shadhil-builders'),
          ).toBe('/shadhil-builders/admin');
        }
      });

      it('hides the row for every non-admin role', () => {
        for (const role of ['MANAGER', 'TELECALLER', 'SALES_EXEC', 'ENGINEER', 'CUSTOMER'] as const) {
          expect(
            adminLauncherHrefFor(role, '/shadhil-builders/projects/metro-heights/leads', 'shadhil-builders'),
          ).toBeNull();
        }
        // No session yet: no row (same fail-closed default as the nav).
        expect(adminLauncherHrefFor(undefined, '/shadhil-builders', 'shadhil-builders')).toBeNull();
      });

      it('hides the row inside /admin/* - the sidebar carries "Go to Work" there', () => {
        expect(adminLauncherHrefFor('OWNER', '/shadhil-builders/admin', 'shadhil-builders')).toBeNull();
        expect(
          adminLauncherHrefFor('OWNER', '/shadhil-builders/admin/users', 'shadhil-builders'),
        ).toBeNull();
      });

      it('hides the row while the org slug is unresolved', () => {
        // A bare `/admin` matches no route - same reason Settings goes inert.
        expect(adminLauncherHrefFor('OWNER', '/', null)).toBeNull();
      });

      it('is OWNER/ADMIN only - the same gate the sidebar used', () => {
        for (const role of ['OWNER', 'ADMIN'] as const) {
          expect(isAdminLike(role)).toBe(true);
        }
        for (const role of [
          'MANAGER',
          'TELECALLER',
          'SALES_EXEC',
          'ENGINEER',
          'CUSTOMER',
        ] as const) {
          expect(isAdminLike(role)).toBe(false);
        }
        expect(isAdminLike(undefined)).toBe(false);
      });
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
    // The inbox is project-scoped and resolves through `projectHref` to
    // `/{orgSlug}/projects/{projectSlug}/whatsapp-chat`.
    it('resolves to a project-scoped href', () => {
      const item = getVisibleNav('OWNER').find((i) => i.href === href)!;
      expect(navItemHref(item, 'shadhil-builders', 'metro-heights')).toBe(
        '/shadhil-builders/projects/metro-heights/whatsapp-chat',
      );
      // ...and it MUST be project-nested under /projects/
      expect(navItemHref(item, 'shadhil-builders', 'metro-heights')).toContain('/projects/');
    });

    it('returns the template href when no project is active (disabled state)', () => {
      const item = getVisibleNav('MANAGER').find((i) => i.href === href)!;
      expect(navItemHref(item, 'shadhil-builders', null)).toBe('/whatsapp-chat');
    });
  });
});
