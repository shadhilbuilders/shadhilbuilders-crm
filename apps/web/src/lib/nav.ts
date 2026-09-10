// Single source of truth for the authenticated app navigation.
//
// History: Phase-1 (Aug 2026) declared `NAV_ITEMS` directly in
// `app-header.tsx:29-35` as `{href, label}[]` because the top-nav only needed
// text links. The redesigned sidebar needs icons + group + per-item
// visibility + (later) live counts from `useLeads` / `useNotifications`.
// Keeping two parallel arrays in two files guarantees a DRY regression the
// next time a route is added - so the source of truth moves here, and both
// the sidebar (`app-shell.tsx`) and the slim topbar (`app-header.tsx`) read
// from the same shape.
//
// Locked decisions (DESIGN.md §4 + plan §3 / §11 / §14):
//   - "Admin" group renders only for roles that pass `canManageUsers`
//     (admin-class + manager) and `canViewAudit` (admin-class only).
//   - Friendly labels (D2) are handled separately in `lib/labels.ts`; this
//     file only owns the nav structure, not display copy for enums.
//   - Role helpers in `lib/session.ts` are the canonical permission source -
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
//   │   │   ├── Dashboard        (no badge)
//   │   │   ├── Leads            (badge: lead count)
//   │   │   ├── Teams            (per-project staff, admin+manager)
//   │   │   ├── Visits           (no badge)
//   │   │   ├── Inventory        (no badge)
//   │   │   ├── Bookings         (no badge - T-F5, T-BOOK backend)
//   │   │   └── Notifications    (badge: unread count)
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
  LuUsersRound,
  LuHandshake,
  LuMessageCircleQuestion,
  LuFolderKanban,
} from '@paalstack/react-icons/lu';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { useSidebar } from '@paalstack/react-ui';

import {
  canConvertWhatsappUnknownContact,
  canManageUsers,
  canViewAudit,
  isAdminLike,
} from '@/lib/session';
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
  /** Template route path (e.g. `'/leads'`). Project-scoped items are
   *  resolved with `projectHref(activeProjectId, href)`. */
  href: string;
  /** Short label used by both the sidebar menu button and the topbar. */
  label: string;
  /** Lucide icon component (already a React component, not a string). */
  icon: IconComponent;
  /** Which group the item belongs to (drives SidebarGroup + role gating). */
  group: NavGroup;
  /** When false, `navItemHref` returns the href unchanged (top-level route
   *  like the admin `/overview` command center). Defaults to true. */
  scoped?: boolean;
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
// Authoritative nav tree (T1 - single source of truth)
// ---------------------------------------------------------------------------

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LuLayoutDashboard, group: 'work' },
  {
    href: '/leads',
    label: 'Leads',
    icon: LuUsers,
    group: 'work',
    badgeKey: 'leadCount',
  },
  {
    href: '/teams',
    label: 'Teams',
    icon: LuUsersRound,
    group: 'work',
  },
  { href: '/visits', label: 'Visits', icon: LuCalendarDays, group: 'work' },
  {
    href: '/inventory',
    label: 'Inventory',
    icon: LuPackage,
    group: 'work',
  },
  // T-F5 (T-BOOK backend). Bookings are visible to every authenticated
  // user (the bookings controller has no role guard for the list path;
  // transition is MANAGER+ via PATCH /bookings/:id - a per-row gate
  // handled on the page, not by hiding the route).
  {
    href: '/bookings',
    label: 'Bookings',
    icon: LuHandshake,
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
  // Admin/owner command center (dashboard split, 2026-09-08). Cross-project
  // overview at the top-level /overview - NOT project-scoped, so it resolves
  // unscoped via `navItemHref` (scoped:false). Distinct from the work
  // "Dashboard" item above, which stays /{projectId}/dashboard.
  {
    href: '/overview',
    label: 'Overview',
    icon: LuLayoutDashboard,
    group: 'admin',
    scoped: false,
  },
  { href: '/users', label: 'Users', icon: LuUserCog, group: 'admin' },
  {
    href: '/projects',
    label: 'Projects',
    icon: LuFolderKanban,
    group: 'admin',
  },
  {
    href: '/audit',
    label: 'Audit',
    icon: LuShieldCheck,
    group: 'admin',
  },
  // T-E2b follow-up queue - admin + manager only (DESIGN.md §4 + plan
  // §11 T-E2b). Telecaller / SalesExec never triage raw inbound from
  // unknown numbers - they only see the result (a converted Lead)
  // in the regular Lead Inbox.
  {
    href: '/whatsapp-unknown-contacts',
    label: 'WA Unknown',
    icon: LuMessageCircleQuestion,
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
      // Per-project Teams manages staff - admin + manager only (backend
      // member writes are ADMIN/OWNER; MANAGER can read). Staff roles don't
      // see it as a work surface.
      if (item.href === '/teams' && !canManageUsers(role)) continue;
      items.push(item);
      continue;
    }
    // group === 'admin'
    if (item.href === '/users' && canManageUsers(role)) items.push(item);
    else if (item.href === '/projects' && canManageUsers(role)) items.push(item);
    else if (item.href === '/audit' && canViewAudit(role)) items.push(item);
    else if (
      item.href === '/whatsapp-unknown-contacts' &&
      canConvertWhatsappUnknownContact(role)
    )
      items.push(item);
    // Admin/owner command center (dashboard split). Admin-only: the
    // cross-project overview is an executive surface, unlike Users which is
    // admin+manager (operational). MANAGER sees a Users-only admin group.
    else if (item.href === '/overview' && isAdminLike(role)) items.push(item);
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
export function useNavBadge(
  key: NavBadgeKey | undefined,
  projectId: string | null = null,
): number {
  // Lazy-require to avoid a circular import in the test harness (T15 builds
  // a pure-function test that never mounts the app, so the queries module's
  // session/BFF dependencies must not be loaded at import time).
  const { useNewLeadsBadge, useNotifications } = require('@/hooks/queries/crm') as {
    useNewLeadsBadge: (projectId: string | null) => { data: { newLeads: number } | undefined };
    useNotifications: (params: { unreadOnly?: boolean }) => {
      data: { rows: unknown[]; total: number; unread: number };
    };
  };

  const newLeads = useNewLeadsBadge(projectId);
  const notifications = useNotifications({ unreadOnly: true });

  if (key === undefined) return FALLBACK_BADGE;
  if (key === 'leadCount') {
    // Project-scoped count of NEW leads (the sidebar badge). A lead leaves
    // NEW the moment anyone works it, so the badge clears as leads get
    // attention. `useNewLeadsBadge` returns `{ newLeads }`; the badge shows
    // that number (0 when the query hasn't resolved yet).
    const n = newLeads.data?.newLeads;
    return typeof n === 'number' ? n : FALLBACK_BADGE;
  }
  if (key === 'unreadNotifications') {
    // `useNotifications` returns `{ rows, total, unread }`. The badge should
    // show the server-computed `unread` count, not the rows array length.
    const unread = notifications.data?.unread;
    return typeof unread === 'number' ? unread : FALLBACK_BADGE;
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
// Project-scoped route helpers (T-ProjectSwitch, 2026-09-05)
// ---------------------------------------------------------------------------
// Work surfaces live under the active project: /{projectId}/leads,
// /{projectId}/visits, ... The first URL path segment is the project id.
// NAV_ITEMS hrefs stay TEMPLATE paths ('/leads'); consumers call
// `projectHref(activeProjectId, item.href)` to resolve the real URL.

/** Nav hrefs whose pages are scoped to the active project (URL segment 1). */
export const PROJECT_SCOPED_PATHS = new Set([
  '/leads',
  '/visits',
  '/inventory',
  '/bookings',
  '/notifications',
  '/dashboard',
  '/teams',
]);

export function isProjectScopedNavPath(href: string): boolean {
  const segments = href.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return PROJECT_SCOPED_PATHS.has(`/${segments[0]}`);
}

/**
 * Resolve a nav template path against the active project.
 * `/leads` + `proj-1` → `/proj-1/leads`; nested templates
 * (`/leads/abc`) prefix the same way. Unscoped paths (`/`, `/users`)
 * pass through unchanged. `activeProjectId === null` keeps the template
 * (caller decides whether to render a disabled state).
 */
export function projectHref(
  activeProjectId: string | null,
  templateHref: string,
): string {
  if (activeProjectId === null || !isProjectScopedNavPath(templateHref)) {
    return templateHref;
  }
  return `/${activeProjectId}${templateHref}`;
}

/**
 * Resolve a nav item against the active project, honoring its `scoped`
 * flag. Scoped items (work surfaces) prefix the project id; unscoped
 * items (admin `/overview` command center) pass through unchanged.
 */
export function navItemHref(
  item: Pick<NavItem, 'href' | 'scoped'>,
  activeProjectId: string | null,
): string {
  if (item.scoped === false) return item.href;
  return projectHref(activeProjectId, item.href);
}

/**
 * Extract the active project id from a work-surface pathname (first
 * segment when it is NOT a top-level template path). Returns null on
 * `/`, `/users`, `/audit`, `/login`, etc.
 */
export function activeProjectIdFromPathname(
  pathname: string,
  navTemplates: readonly string[] = [...PROJECT_SCOPED_PATHS],
): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const first = `/${segments[0]}`;
  // Known top-level app routes never carry a project segment. Anything
  // else that is not a work-surface template IS treated as a project id
  // (the [projectId] dynamic segment is the fallback matcher).
  const TOP_LEVEL_ROUTES = [
    ...navTemplates,
    '/',
    '/login',
    '/change-password',
    '/users',
    '/audit',
    '/projects',
    '/overview',
    '/whatsapp-unknown-contacts',
  ];
  if (TOP_LEVEL_ROUTES.includes(first)) return null;
  return segments[0] ?? null;
}

/** Strip the project segment: /proj-1/leads/abc → /leads/abc. */
export function stripProjectSegment(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(1).join('/')}`;
}

// ---------------------------------------------------------------------------
// Mobile nav sync (T37 - closes the sidebar Sheet on route change)
// ---------------------------------------------------------------------------

/**
 * The mobile `<Sheet>` lives inside `SidebarProvider`, which does NOT
 * auto-close it on `usePathname()` change (T37 finding). Closing the
 * sheet manually via `useSidebar().setOpenMobile(false)` is a one-liner,
 * but extracting it into a hook:
 *   1. Encapsulates the library-drift risk - if the library later adds its
 *      own path-change listener, the hook is the one place to remove ours.
 *   2. Lets the same hook power future nav surfaces (e.g. command-palette
 *      results) without re-implementing the close-on-route-change dance.
 *
 * Mount this hook exactly once in the app shell root.
 */
export function useNavSync(): void {
  const pathname = usePathname();
  //
  // Rules of Hooks: `useSidebar()` MUST run in the hook body (during
  // render), never inside the `useEffect` callback - calling it inside
  // the effect threw "Invalid hook call" in dev and crashed the (app)
  // layout after login.
  //
  // Module identity: imported statically (top of file), NOT via lazy
  // `require()`. A CJS require() resolves this dual-format package's
  // `dist/index.cjs`, while client components resolve `dist/index.js` -
  // two module instances = two `SidebarContext` objects, so a hook from
  // the CJS copy would never see the ESM `SidebarProvider` and would
  // throw "useSidebar must be used within a SidebarProvider" at runtime.
  // The file is `'use client'`, so a static import is always safe here.
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    // Only close on mobile: on desktop the sidebar is a persistent rail
    // and `setOpenMobile` is a no-op.
    setOpenMobile(false);
    // `setOpenMobile` is a stable useState setter from SidebarProvider;
    // listing it keeps the deps array honest without re-running the effect.
  }, [pathname, setOpenMobile]);
}
