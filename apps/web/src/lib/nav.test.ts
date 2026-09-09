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
  NAV_ITEMS,
} from '@/lib/nav';

describe('lib/nav', () => {
  describe('NAV_ITEMS - the single source of truth', () => {
    it('contains exactly one work dashboard entry at /dashboard and one admin Overview at /overview', () => {
      const workDashboards = NAV_ITEMS.filter(
        (item) => item.href === '/dashboard' && item.group === 'work',
      );
      const adminDashboards = NAV_ITEMS.filter(
        (item) => item.href === '/overview' && item.group === 'admin',
      );
      expect(workDashboards).toHaveLength(1);
      expect(adminDashboards).toHaveLength(1);
      // The admin Overview is unscoped (top-level /overview command center).
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
    it('TELECALLER sees only the work group (no admin items)', () => {
      const items = getVisibleNav('TELECALLER');
      expect(items.map((i) => i.href)).toEqual([
        '/dashboard',
        '/leads',
        '/visits',
        '/inventory',
        '/bookings',
        '/notifications',
      ]);
    });

    it('SALES_EXEC sees only the work group (no admin items)', () => {
      const items = getVisibleNav('SALES_EXEC');
      expect(items.map((i) => i.href)).toEqual([
        '/dashboard',
        '/leads',
        '/visits',
        '/inventory',
        '/bookings',
        '/notifications',
      ]);
    });

    it('MANAGER sees work + Users (canManageUsers), no Audit (canViewAudit denied)', () => {
      const items = getVisibleNav('MANAGER');
      const hrefs = items.map((i) => i.href);
      expect(hrefs).toContain('/users');
      expect(hrefs).not.toContain('/audit');
    });

    it('MANAGER also sees WA Unknown (canConvertWhatsappUnknownContact)', () => {
      const items = getVisibleNav('MANAGER');
      const hrefs = items.map((i) => i.href);
      expect(hrefs).toContain('/whatsapp-unknown-contacts');
    });

    it('ADMIN sees work + Users + Audit', () => {
      const items = getVisibleNav('ADMIN');
      const hrefs = items.map((i) => i.href);
      expect(hrefs).toContain('/users');
      expect(hrefs).toContain('/audit');
    });

    it('ADMIN sees the Overview command center (admin-only)', () => {
      const items = getVisibleNav('ADMIN');
      const overview = items.find((i) => i.href === '/overview' && i.group === 'admin');
      expect(overview).toBeDefined();
      expect(overview!.scoped).toBe(false);
    });

    it('MANAGER sees Users but NOT the Overview command center (Users is admin+manager, Overview is admin-only)', () => {
      const items = getVisibleNav('MANAGER');
      const hrefs = items.map((i) => i.href);
      expect(hrefs).toContain('/users');
      const adminOverview = items.find(
        (i) => i.href === '/overview' && i.group === 'admin',
      );
      expect(adminOverview).toBeUndefined();
    });

    it('ADMIN also sees WA Unknown (admin-class)', () => {
      const items = getVisibleNav('ADMIN');
      expect(items.map((i) => i.href)).toContain('/whatsapp-unknown-contacts');
    });

    it('OWNER sees work + Users + Audit (admin-class)', () => {
      const items = getVisibleNav('OWNER');
      const hrefs = items.map((i) => i.href);
      expect(hrefs).toContain('/users');
      expect(hrefs).toContain('/audit');
    });

    it('OWNER also sees WA Unknown (admin-class)', () => {
      const items = getVisibleNav('OWNER');
      expect(items.map((i) => i.href)).toContain('/whatsapp-unknown-contacts');
    });

    it('OWNER sees the Overview command center (admin-class)', () => {
      const items = getVisibleNav('OWNER');
      const overview = items.find((i) => i.href === '/overview' && i.group === 'admin');
      expect(overview).toBeDefined();
      expect(overview!.scoped).toBe(false);
    });

    it('TELECALLER does NOT see the Overview command center (admin group)', () => {
      const items = getVisibleNav('TELECALLER');
      const adminOverview = items.find(
        (i) => i.href === '/overview' && i.group === 'admin',
      );
      expect(adminOverview).toBeUndefined();
    });

    it('TELECALLER does NOT see WA Unknown (raw inbound triage is admin-only)', () => {
      const items = getVisibleNav('TELECALLER');
      expect(items.map((i) => i.href)).not.toContain(
        '/whatsapp-unknown-contacts',
      );
    });

    it('SALES_EXEC does NOT see WA Unknown (raw inbound triage is admin-only)', () => {
      const items = getVisibleNav('SALES_EXEC');
      expect(items.map((i) => i.href)).not.toContain(
        '/whatsapp-unknown-contacts',
      );
    });

    it('undefined role sees only the work group (safe default)', () => {
      const items = getVisibleNav(undefined);
      const adminItems = items.filter((i) => i.group === 'admin');
      expect(adminItems).toEqual([]);
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

    it('Users (`/users`) is active on `/users` and `/users/*`', () => {
      expect(isNavItemActive('/users', '/users')).toBe(true);
      expect(isNavItemActive('/users', '/users/123')).toBe(true);
      expect(isNavItemActive('/users', '/audit')).toBe(false);
    });
  });
});
