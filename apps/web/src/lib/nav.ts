// Single source of truth for the authenticated app navigation.
//
// History: Phase-1 (Aug 2026) declared `NAV_ITEMS` directly in
// `app-header.tsx:29-35` as `{href, label}[]` because the top-nav only needed
// text links. The redesigned sidebar needs icons + group + per-item
// visibility + (later) live counts from `useLeads` / `useNotifications`.
// Keeping two parallel arrays in two files guarantees a DRY regression the
// next time a route is added — so the source of truth moves here, and both
// the sidebar (`app-shell.tsx`) and the slim topbar (`app-header.tsx`) read
// from the same shape.
//
// Locked decisions (DESIGN.md §4 + plan §3 / §11 / §14):
//   - "Admin" group renders only for roles that pass `canManageUsers`
//     (admin-class + manager) and `canViewAudit` (admin-class only).
//   - Friendly labels (D2) are handled separately in `lib/labels.ts`; this
//     file only owns the nav structure, not display copy for enums.
//   - Role helpers in `lib/session.ts` are the canonical permission source —
//     do not hand-roll role checks here. Drift would re-open the RBAC holes
//     the helpers were extracted to close.
//   - The mobile `<Sheet>` sidebar should close on route change so users
//     never see a Sheet that opens over a fresh route; `useNavSync()` is the
//     library-drift-resistant bridge (plan T37).
//
// ASCII tree (matches §3.1 + §3.2 of the plan):
//
//   SidebarProvider
//   ├── Sidebar (desktop)   ─┐ same content
//   │   / Sheet (≤768px)    ─┘
//   │   ├── Header: logo + brand
//   │   ├── Content
//   │   │   ├── Group "Work"
//   │   │   │   ├── Dashboard        (no badge)
//   │   │   │   ├── Leads            (badge: lead count)
//   │   │   │   ├── Visits           (no badge)
//   │   │   │   ├── Inventory        (no badge)
//   │   │   │   └── Notifications    (badge: unread count)
//   │   │   ├── SidebarSeparator  [admin-class only]
//   │   │   └── Group "Admin"     [role-gated]
//   │   │       ├── Users          [canManageUsers]
//   │   │       └── Audit          [canViewAudit]
//   │   └── Footer: UserMenu + Sign out
//   └── SidebarInset
//       ├── Topbar (SidebarTrigger + page title + bell + UserMenu)
//       └── Page content
'use client';

// Icons are re-exported by @paalstack/react-icons (lucide subpath).
// We import the components (not string identifiers) so that sidebars/
// topbars get a real React node to drop into `SidebarMenuButton asChild`.
import {
  LuLayoutDashboard,
  LuUsers,
  LuCalendarDays,
  LuPackage,
  LuBell,
  LuShieldCheck,
  LuUserCog,
} from '@paalstack/react-icons/lu';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { canManageUsers, canViewAudit } from '@/lib/session';
import type { Role } from '@/apis/client';

// ---------------------------------------------------------------------------
// Nav item shape
// ---------------------------------------------------------------------------

/** Discriminator that lets `getVisibleNav` filter without re-walking icon
 *  components. A new nav item must pick exactly one. */
export type NavGroup = 'work' | 'admin';

/** Loosened to match react-icons' `IconType` return signature
 *  (`ReactNode`, not the narrower `JSX.Element`). */
export type IconComponent = (props: {
  className?: string;
}) => React.ReactNode;

export type NavItem = {
  /** Route path. `'/dashboard'` is a special case for the root active state. */
  href: string;
  /** Short label used by both the sidebar menu button and the topbar. */
  label: string;
  /** Lucide icon component (already a React component, not a string). */
  icon: IconComponent;
  /** Which group the item belongs to (drives SidebarGroup + role gating). */
  group: NavGroup;
  /**
   * Stable key used by `useNavBadge` to look up a live count from the
   * query layer. Undefined = static item, no badge slot rendered.
   */
  badgeKey?: NavBadgeKey;
};

/** Badge source identifiers. The actual count fetch lives in
 *  `useNavBadge` so the data layer can be swapped without touching this file. */
export type NavBadgeKey = 'leadCount' | 'unreadNotifications';

// ---------------------------------------------------------------------------
// Authoritative nav tree (T1 — single source of truth)
// ---------------------------------------------------------------------------

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LuLayoutDashboard, group: 'work' },
  {
    href: '/leads',
    label: 'Leads',
    icon: LuUsers,
    group: 'work',
    badgeKey: 'leadCount',
  },
  { href: '/visits', label: 'Visits', icon: LuCalendarDays, group: 'work' },
  {
    href: '/inventory',
    label: 'Inventory',
    icon: LuPackage,
    group: 'work',
  },
  {
    href: '/notifications',
    label: 'Notifications',
    icon: LuBell,
    group: 'work',
    badgeKey: 'unreadNotifications',
  },
  // ── admin group (role-gated by canManageUsers / canViewAudit) ─────────
  { href: '/users', label: 'Users', icon: LuUserCog, group: 'admin' },
  {
    href: '/audit',
    label: 'Audit',
    icon: LuShieldCheck,
    group: 'admin',
  },
] as const;

/**
 * Filter the nav tree by the current role. Pure function so it can be
 * exhaustively unit-tested in `nav.test.ts` without rendering.
 *
 * Rule (DESIGN.md §4 + plan §3.1):
 *   - The "admin" group is shown only when at least one of its items is
 *     visible; we don't render an empty group with just a label.
 */
export function getVisibleNav(role: Role | undefined): NavItem[] {
  const items: NavItem[] = [];
  for (const item of NAV_ITEMS) {
    if (item.group === 'work') {
      items.push(item);
      continue;
    }
    // group === 'admin'
    if (item.href === '/users' && canManageUsers(role)) items.push(item);
    else if (item.href === '/audit' && canViewAudit(role)) items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Live nav badges
// ---------------------------------------------------------------------------

/** Default count for any item with a badge when the query is loading or
 *  not yet resolved. Matches the plan: never invent a number; show `0`
 *  until the module ships. */
const FALLBACK_BADGE = 0;

/**
 * Look up a live count for a `NavItem.badgeKey`. Imported here (not
 * exported as a component) so it can be reused by both the sidebar
 * `SidebarMenuBadge` slot and the topbar's `NotificationBell` without
 * double-fetching.
 *
 * The hook delegates to the existing query layer (`hooks/queries/crm.ts`),
 * which already enforces the honest-state contract: until the backend
 * module lands, the response is 404 → `ModulePending`, so `data` stays
 * `undefined` and we render 0 (not a fake number).
 */
export function useNavBadge(key: NavBadgeKey | undefined): number {
  // Lazy-require to avoid a circular import in the test harness (T15 builds
  // a pure-function test that never mounts the app, so the queries module's
  // session/BFF dependencies must not be loaded at import time).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { useLeads, useNotifications } = require('@/hooks/queries/crm') as {
    useLeads: () => { data: unknown };
    useNotifications: (params: { unreadOnly?: boolean }) => { data: unknown };
  };

  const leads = useLeads();
  const notifications = useNotifications({ unreadOnly: true });

  if (key === undefined) return FALLBACK_BADGE;
  if (key === 'leadCount') {
    return Array.isArray(leads.data) ? leads.data.length : FALLBACK_BADGE;
  }
  if (key === 'unreadNotifications') {
    return Array.isArray(notifications.data)
      ? notifications.data.length
      : FALLBACK_BADGE;
  }
  return FALLBACK_BADGE;
}

// ---------------------------------------------------------------------------
// Active-route helper
// ---------------------------------------------------------------------------

/**
 * Match `pathname` against an item's `href`. `/` is exact-only (otherwise
 * the Dashboard item lights up for every route), and everything else is a
 * prefix match so `/leads/abc` still highlights the `Leads` menu item.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ---------------------------------------------------------------------------
// Mobile nav sync (T37 — closes the sidebar Sheet on route change)
// ---------------------------------------------------------------------------

/**
 * The mobile `<Sheet>` lives inside `SidebarProvider`, which does NOT
 * auto-close it on `usePathname()` change (T37 finding). Closing the
 * sheet manually via `useSidebar().setOpenMobile(false)` is a one-liner,
 * but extracting it into a hook:
 *   1. Encapsulates the library-drift risk — if the library later adds its
 *      own path-change listener, the hook is the one place to remove ours.
 *   2. Lets the same hook power future nav surfaces (e.g. command-palette
 *      results) without re-implementing the close-on-route-change dance.
 *
 * Mount this hook exactly once in the app shell root.
 */
export function useNavSync(): void {
  const pathname = usePathname();
  // Lazy-require so this module is importable from server components
  // (e.g. the eventual `<head>` consumers) without pulling the entire
  // Sidebar context into a server bundle. The hook is a no-op on the
  // server because `useEffect` never fires there.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { useSidebar } = require('@paalstack/react-ui') as {
    useSidebar: () => { setOpenMobile: (open: boolean) => void };
  };

  useEffect(() => {
    // Only close on mobile: on desktop the sidebar is a persistent rail
    // and `setOpenMobile` is a no-op.
    useSidebar().setOpenMobile(false);
    // We intentionally exclude `useSidebar` from deps — its identity is
    // stable across renders (it's a context value, not a hook result).
  }, [pathname]);
}
