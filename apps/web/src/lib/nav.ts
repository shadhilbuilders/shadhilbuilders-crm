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
// Locked decisions (DESIGN.md §4 + plan §3 / §11 / §14 + Decision #38):
//   - Detailed Admin nav is OWNER/ADMIN only under `/admin/*`.
//   - Work nav shows an `Admin` launcher for OWNER/ADMIN; Admin nav shows
//     a `Work` launcher back to the default project dashboard.
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
//   │   │       ├── Staff Permission [admin-like]
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
  LuKeyRound,
  LuUsersRound,
  LuHandshake,
  LuMessageCircleQuestion,
  LuFolderKanban,
  LuMessageSquareText,
  LuSatellite,
  LuSend,
  LuMessagesSquare,
} from '@paalstack/react-icons/lu';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { useSidebar } from '@paalstack/react-ui';

import { canUseWhatsappInbox, isAdminLike } from '@/lib/session';
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
  /**
   * Optional collapsed-submenu children. When present, the item renders as
   * a `Collapsible` trigger and its children (`children.map`) render as
   * `SidebarMenuSub` items (e.g. the WhatsApp submenu: WA Unknown / Webhooks
   * / WA Delivery). Visibility of the parent follows `getVisibleNav`.
   */
  children?: readonly NavItem[];
};

/** Badge source identifiers. The actual count fetch lives in
 *  `useNavBadge` so the data layer can be swapped without touching this file. */
export type NavBadgeKey = 'leadCount' | 'unreadNotifications' | 'unreadChats';

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
  { href: '/visits', label: 'Visits', icon: LuCalendarDays, group: 'work' },
  {
    href: '/my-team',
    label: 'My Team',
    icon: LuUsersRound,
    group: 'work',
  },
  {
    href: '/staff',
    label: 'Staff',
    icon: LuUsersRound,
    group: 'work',
  },
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
  // T-WA-INBOX (2026-09-25): the WhatsApp chat system. MANAGER/ADMIN/OWNER
  // only - a WORK item (staff surface) rather than an Admin one, because a
  // manager works out of it day to day. Per-item visibility is enforced in
  // isNavItemVisible below; the badge counts the current user's unread chats.
  // Project-scoped: the inbox shows conversations for the active project only.
  {
    href: '/whatsapp-chat',
    label: 'WhatsApp Chats',
    icon: LuMessagesSquare,
    group: 'work',
    // Project-scoped (the inbox lists conversations in the active project).
    // `scoped: true` is the default; the route resolves through `projectHref`
    // to `/{orgSlug}/projects/{projectSlug}/whatsapp-chat`.
    badgeKey: 'unreadChats',
  },
  {
    href: '/notifications',
    label: 'Notifications',
    icon: LuBell,
    group: 'work',
    badgeKey: 'unreadNotifications',
  },
  // OWNER/ADMIN launcher into /admin/* (hidden for every other role).
  {
    href: '/admin',
    label: 'Admin',
    icon: LuShieldCheck,
    group: 'work',
    scoped: false,
  },
  // ── admin group (OWNER/ADMIN only; shown on /admin/* paths) ─
  // NOTE: the "Go to Work" exit is a standalone link above the group
  // label (see `app-shell.tsx`'s `AdminNavGroup`), not a NAV_ITEMS entry -
  // it isn't a page inside the admin namespace, so it doesn't belong in
  // the role-gated item list that `getVisibleNav` walks.
  {
    href: '/admin/overview',
    label: 'Overview',
    icon: LuLayoutDashboard,
    group: 'admin',
    scoped: false,
  },
  {
    href: '/admin/users',
    label: 'Users',
    icon: LuUserCog,
    group: 'admin',
    scoped: false,
  },
  {
    href: '/admin/staff-permission',
    label: 'Staff Permission',
    icon: LuKeyRound,
    group: 'admin',
    scoped: false,
  },
  {
    href: '/admin/projects',
    label: 'Projects',
    icon: LuFolderKanban,
    group: 'admin',
    scoped: false,
  },
  {
    href: '/admin/teams',
    label: 'Teams',
    icon: LuUsersRound,
    group: 'admin',
    scoped: false,
  },
  {
    href: '/admin/audit',
    label: 'Audit',
    icon: LuShieldCheck,
    group: 'admin',
    scoped: false,
  },
  {
    href: '/admin/webhooks',
    label: 'WhatsApp',
    icon: LuMessageCircleQuestion,
    group: 'admin',
    scoped: false,
    children: [
      {
        href: '/admin/whatsapp-unknown-contacts',
        label: 'WA Unknown',
        icon: LuMessageCircleQuestion,
        group: 'admin',
        scoped: false,
      },
      {
        href: '/admin/whatsapp-delivery',
        label: 'WA Delivery',
        icon: LuSend,
        group: 'admin',
        scoped: false,
      },
      {
        href: '/admin/webhooks',
        label: 'Webhooks',
        icon: LuSatellite,
        group: 'admin',
        scoped: false,
      },
    ],
  },
  {
    href: '/admin/feedback',
    label: 'Feedback',
    icon: LuMessageSquareText,
    group: 'admin',
    scoped: false,
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
      // Per-project Staff is viewable by every authenticated role.
      // The Admin launcher is OWNER/ADMIN only.
      if (!isNavItemVisible(item, role)) continue;
      items.push(item);
      continue;
    }
    // group === 'admin' - OWNER/ADMIN only

    if (item.children !== undefined) {
      const visibleChildren = item.children.filter((c) => isNavItemVisible(c, role));
      if (visibleChildren.length > 0) {
        items.push({ ...item, children: visibleChildren });
      }
      continue;
    }

    if (isNavItemVisible(item, role)) items.push(item);
  }
  return items;
}

/** Per-item visibility. Admin namespace + Admin launcher: OWNER/ADMIN only.
 *  My Team: MANAGER only (design doc UI1 - "Managers receive a Work ->
 *  My Team route"; other staff don't manage/belong-to teams in a way
 *  this surface is useful for, and Admin/Owner already use Admin -> Teams). */
function isNavItemVisible(item: Pick<NavItem, 'href' | 'group'>, role: Role | undefined): boolean {
  if (item.href === '/admin' || item.href === '/work' || item.href.startsWith('/admin/')) {
    return isAdminLike(role);
  }
  if (item.href === '/my-team') {
    return role === 'MANAGER';
  }
  // T-WA-INBOX: the chat system is manager-and-above. This must come BEFORE
  // the catch-all `group === 'work' => true` at the end of this function,
  // which would otherwise show it to every authenticated role.
  if (item.href === '/whatsapp-chat') {
    return canUseWhatsappInbox(role);
  }
  // Remaining work items are visible to every authenticated role (and the
  // undefined-role SSR default, which matches the previous work-group
  // always-visible contract).
  if (item.group === 'work') return true;
  return false;
}

/** True when the authenticated pathname is under /{orgSlug}/admin. */
export function isAdminPathname(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return segments[1] === 'admin';
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
  const { useNewLeadsBadge, useNotifications, useChatConversations } = require(
    '@/hooks/queries/crm',
  ) as {
    useNewLeadsBadge: (projectId: string | null) => { data: { newLeads: number } | undefined };
    useNotifications: (params: { unreadOnly?: boolean }) => {
      data: { rows: unknown[]; total: number; unread: number };
    };
    useChatConversations: (params: { limit?: number }) => {
      data: { totalUnread: number } | undefined;
    };
  };

  const newLeads = useNewLeadsBadge(projectId);
  const notifications = useNotifications({ unreadOnly: true });
  // Hook order must be stable across renders, so this is called
  // unconditionally and only its VALUE is used for the chat badge.
  const chats = useChatConversations({ limit: 1 });

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
  if (key === 'unreadChats') {
    // The inbox's per-user unread count. `totalUnread` is computed across ALL
    // the actor's threads server-side, so the badge is right regardless of the
    // page size - ask for a single row. Without this branch the key fell
    // through to FALLBACK_BADGE (0) and the badge never rendered, even though
    // the backend was returning the count.
    const unread = chats.data?.totalUnread;
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
  if (href === '/' || href === '/admin' || href === '/work') {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ---------------------------------------------------------------------------
// Org + project-scoped route helpers (slug-based URL scheme, 2026-09-11)
// ---------------------------------------------------------------------------
// The public URL uses SLUGS for identity:
//   `/[orgSlug]/admin/<page>`              (admin namespace)
//   `/[orgSlug]/work`                      (leave-admin landing)
//   `/[orgSlug]/projects/[projectSlug]/<surface>` (project work surfaces)
// NAV_ITEMS hrefs stay TEMPLATE paths ('/leads', '/admin/overview', ...); the
// consumers call the helpers below with the active org slug (+ project slug
// for work surfaces) to resolve the real URL. The RESOLVED tenant ids travel
// separately (lib/tenant-context) for id-keyed API hooks.

/** Nav hrefs whose pages are scoped to the active project (project work). */
export const PROJECT_SCOPED_PATHS = new Set([
  '/leads',
  '/visits',
  '/my-team',
  '/inventory',
  '/bookings',
  '/notifications',
  '/dashboard',
  '/staff',
  '/whatsapp-chat',
]);

export function isProjectScopedNavPath(href: string): boolean {
  const segments = href.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return PROJECT_SCOPED_PATHS.has(`/${segments[0]}`);
}

/**
 * Resolve a project work-surface template path against the active org +
 * project slug. `/leads` + (`shadhil-builders`, `metro-heights`) →
 * `/shadhil-builders/projects/metro-heights/leads`; nested templates
 * (`/leads/abc`) prefix the same way. When either slug is null the template
 * is returned unchanged (caller decides whether to render a disabled state).
 */
export function projectHref(
  orgSlug: string | null,
  projectSlug: string | null,
  templateHref: string,
): string {
  if (
    orgSlug === null ||
    projectSlug === null ||
    !isProjectScopedNavPath(templateHref)
  ) {
    return templateHref;
  }
  return `/${orgSlug}/projects/${projectSlug}${templateHref}`;
}

/**
 * Resolve an org-level page template path against the active org slug.
 * `/admin/overview` + `shadhil-builders` → `/shadhil-builders/admin/overview`.
 * `orgSlug === null` keeps the template (caller decides).
 */
export function orgHref(orgSlug: string | null, templateHref: string): string {
  if (orgSlug === null) return templateHref;
  return `/${orgSlug}${templateHref}`;
}

/**
 * Resolve a nav item against the active org (+project for work surfaces),
 * honoring its `scoped` flag. Scoped items (work surfaces) prefix the
 * project slug under `/projects`; unscoped items (admin `/admin/*`, `/work`)
 * prefix just the org slug.
 */
export function navItemHref(
  item: Pick<NavItem, 'href' | 'scoped'>,
  orgSlug: string | null,
  projectSlug: string | null,
): string {
  if (item.scoped === false) return orgHref(orgSlug, item.href);
  return projectHref(orgSlug, projectSlug, item.href);
}

/**
 * Extract the active org slug from an authenticated pathname (URL segment 1
 * after `/`). Returns null on `/`, `/login`, `/change-password`, etc.
 */
export function activeOrgSlugFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0] ?? null;
}

/**
 * Extract the active project slug from a project work-surface pathname
 * (`/shadhil-builders/projects/metro-heights/leads` → `metro-heights`).
 * Returns null when the path is NOT under `/projects/<slug>` (org-level
 * pages, `/`, `/login`).
 */
export function activeProjectSlugFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  // Shape: [orgSlug, 'projects', projectSlug, ...surface]
  const projectSlug = segments[2];
  if (
    segments.length >= 3 &&
    segments[1] === 'projects' &&
    typeof projectSlug === 'string' &&
    projectSlug.length > 0
  ) {
    return projectSlug;
  }
  return null;
}

/**
 * Strip the org + project prefix from an authenticated work-surface path:
 * `/shadhil-builders/projects/metro-heights/leads/abc` → `/leads/abc`. Used
 * by active-route matching against NAV_ITEMS templates.
 */
export function stripProjectSegment(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  // [orgSlug, 'projects', projectSlug, ...surface] → drop first three, keep surface.
  if (segments.length >= 3 && segments[1] === 'projects') {
    return `/${segments.slice(3).join('/')}`;
  }
  // Org-level page under /[orgSlug]: [orgSlug, ...rest] → drop first.
  if (segments.length >= 1) {
    return `/${segments.slice(1).join('/')}`;
  }
  return '/';
}

// Backward-compat aliases (the previous id-based names). The URL is now
// slug-based, so these are deprecated; kept only until all call sites are
// migrated (see task plan). Prefer the activeOrgSlug/activeProjectSlug forms.
export const activeOrgIdFromPathname = activeOrgSlugFromPathname;
export const activeProjectIdFromPathname = activeProjectSlugFromPathname;

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
