'use client';

// AppShell - the Sidebar content (logo, nav groups, UserMenu, sign-out).
//
// Plan §3.1 / §11 T6. Lives inside the (app)/layout.tsx `SidebarProvider`
// from PR1/T7. The same JSX is reused on mobile (the library's internal
// Sheet swap) and on desktop (the persistent rail), so there is NO
// conditional rendering for breakpoint here - the provider handles it.
//
// The role-gated admin group uses the canonical helpers from
// `lib/session.ts` (`canManageUsers`, `canViewAudit`). Do NOT hand-roll
// role string checks here; the helpers encode the Model C RBAC matrix
// (DESIGN.md §4) and the inheritance rules that admin inherits manager
// actions across teams, but not staff-specific responsibilities.
//
// ASCII tree (matches §3.1 / §3.2):
//
//   <Sidebar collapsible="icon" variant="inset">
//   ├── <SidebarHeader>
//   │   ├── <Image src="/brand/logo.png" /> + "Shadhil CRM" wordmark
//   │   └── <SidebarTrigger />          (mobile only - hidden md+)
//   ├── <SidebarContent>
//   │   ├── Group "Work"
//   │   │   ├── Dashboard   (active-state via isNavItemActive)
//   │   │   ├── Leads       (+ badge count if badgeKey present)
//   │   │   ├── Visits
//   │   │   ├── Inventory
//   │   │   └── Notifications (+ badge count)
//   │   ├── <SidebarSeparator />     [admin-class only]
//   │   └── Group "Admin"            [role-gated]
//   │       ├── Users                [canManageUsers]
//   │       └── Audit                [canViewAudit]
//   └── <SidebarFooter>
//       ├── <UserMenu /> popover
//       └── Sign out button (uses useSignOut)
//
// T37 (PR3) wires `useNavSync()` from `lib/nav` to close the mobile
// Sheet on route change. Imported here so the hook mounts once at the
// shell root.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Button,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@paalstack/react-ui';
import { LuPanelLeft } from '@paalstack/react-icons/lu';

import { NavUser } from '@/components/sidebar/nav-user';
import { ProjectSwitcher } from '@/components/sidebar/project-switcher';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { useSignOut } from '@/lib/auth-actions';
import {
  activeProjectIdFromPathname,
  getVisibleNav,
  isNavItemActive,
  isProjectScopedNavPath,
  navItemHref,
  stripProjectSegment as stripProjectSegmentForNav,
  NAV_ITEMS,
  useNavBadge,
  useNavSync,
  type NavItem,
} from '@/lib/nav';
import { Skeleton } from '@/components/shared/Skeleton';
import {
  canManageUsers,
  canViewAudit,
  useSessionUser,
} from '@/lib/session';

export function AppShell() {
  // T37: close the mobile Sheet whenever the route changes.
  useNavSync();
  // T-ProjectSwitch: the active project is the URL's first segment on
  // work surfaces (/proj-1/leads). Computed here once and passed down
  // to the switcher slot + nav groups so every link resolves against it.
  const pathname = usePathname();
  const pathProjectId = activeProjectIdFromPathname(pathname);
  const { data: projects } = useProjects();
  // Work-surface hrefs always need a project id (pages live under
  // /{projectId}/dashboard, /{projectId}/leads, …). On unscoped routes
  // (/users, /audit) fall back to the default registry project.
  const activeProjectId =
    pathProjectId ?? pickDefaultProject(projects ?? [])?.id ?? null;
  // T-Sidebar07: collapsed state drives the logo swap (wide lockup ↔
  // square brand icon). Read from the sidebar context.
  const { state: sidebarState } = useSidebar();
  const isCollapsed = sidebarState === 'collapsed';

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <div className="flex items-center justify-center gap-2">
          {/* Brand chip: the wide logo lockup when the sidebar is expanded,
              the square brand icon when collapsed (the 64px icon rail is
              too narrow for the wordmark). Same white tile in both states
              so the shape doesn't shift, only the image inside swaps.
              No px-* here: the SidebarHeader already adds p-2, and the
              nav items below also use p-2, so the brand and nav share
              the same left edge. (Was 8px misaligned before this fix.) */}
          <Link
            href={navItemHref(
              { href: '/overview', scoped: false },
              activeProjectId,
            )}
            className="inline-flex h-10 shrink-0 items-center overflow-hidden text-primary"
            aria-label="Shadhil CRM home"
            data-qa="sidebar-brand"
          >
            {isCollapsed ? (
              <span className="text-3xl font-bold">SB</span>
            ) : (
              <span className="text-4xl md:text-3xl font-bold">Shadhil CRM</span>
            )}
          </Link>
          {/* The chip carries the full brand lockup (wordmark + tagline);
              the duplicate "Shadhil CRM" text label is redundant at this
              size and truncates awkwardly next to a 143px chip. Hidden
              entirely - the chip IS the brand. */}
        </div>
        {/* Separator between the brand chip and the project switcher so
            the two header sections read as distinct groups. */}
        <SidebarSeparator />
        {/* sidebar-07 pattern: below the brand, the project switcher
            dropdown (display-only for now - see project-switcher.tsx).
            Hidden until the session resolves so the collapsed rail
            doesn't flash an empty switcher. */}
        <SidebarSwitcherSlot activeProjectId={activeProjectId} />
      </SidebarHeader>
      <SidebarContent className="min-w-0 overflow-x-hidden">
        <WorkNavGroup activeProjectId={activeProjectId} />
        <AdminNavGroup activeProjectId={activeProjectId} />
      </SidebarContent>
      {/* Separator between the work/admin nav groups and the footer
          (UserMenu + sign out). */}
      <SidebarSeparator />
      <SidebarFooter className="min-w-0 overflow-x-hidden">
        <UserMenuFooter />
      </SidebarFooter>
      {/* Right-edge rail: desktop toggle for expand/collapse. Renders a
          thin clickable strip with the chevron icon, sits on the right
          edge of the sidebar, hidden on mobile (the SidebarTrigger above
          handles the mobile Sheet open/close). The library renders the
          chevron automatically and rotates it on state. */}
      <SidebarRail data-qa="sidebar-rail" />
    </Sidebar>
  );
}

// ---------------------------------------------------------------------------
// Project switcher slot (sidebar-07 pattern): sits directly below the
// brand chip in the header. T-ProjectSwitch: reads the REAL project
// registry (useProjects) and the active project from the URL's first
// segment. While the session is pending or unauthenticated it renders
// nothing (no skeleton - the header already shows the brand chip, which
// keeps the shape stable).
// ---------------------------------------------------------------------------

function SidebarSwitcherSlot({
  activeProjectId,
}: {
  activeProjectId: string | null;
}) {
  const { user } = useSessionUser();
  const { data: projects, isPending: projectsPending } = useProjects();
  // M2 (eng-corrected): on the cross-project /overview command center, the
  // switcher must NOT imply a project scope. Scope the null to the switcher
  // ONLY — the shared activeProjectId (passed to the nav groups) stays intact
  // so work nav hrefs keep resolving correctly.
  const pathname = usePathname();
  const isCommandCenter = pathname === '/overview';

  // Show skeleton while projects are loading
    if (projectsPending) {
      return (
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="w-full">
              <Skeleton variant="projectSwitcher" className="w-full" />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      );
    }

  // No session yet - render nothing (the nav groups below do the same).
  if (user === null) return null;

  const canManageProjects = user.role === 'ADMIN' || user.role === 'OWNER';

  return (
    <ProjectSwitcher
      projects={projects ?? []}
      activeProjectId={isCommandCenter ? null : activeProjectId}
      canManageProjects={canManageProjects}
    />
  );
}

// ---------------------------------------------------------------------------
// SidebarToggleButton - THE expand/collapse affordance, visible on mobile
// AND desktop. The library's SidebarTrigger is md:hidden and SidebarRail
// renders no icon, so we own the button: LuPanelLeft + toggleSidebar.
// Rendered in the TOPBAR beside the welcome message (canonical sidebar-07
// position) and exported for that use; the sidebar header does NOT render
// a second one (one toggle, one place).
// ---------------------------------------------------------------------------

export function SidebarToggleButton({ className }: { className?: string }) {
  const { toggleSidebar, isMobile } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle sidebar"
      title={isMobile ? 'Open menu' : 'Expand / collapse sidebar'}
      data-qa="sidebar-toggle"
      className={`cursor-pointer size-8 shrink-0 ${className ?? ''}`}
      onClick={() => toggleSidebar()}
    >
      <LuPanelLeft className="size-4.5" />
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Work group - visible to every signed-in user. Source: NAV_ITEMS, so a
// new route added to `lib/nav.ts` lights up here automatically.
// ---------------------------------------------------------------------------

function WorkNavGroup({
  activeProjectId,
}: {
  activeProjectId: string | null;
}) {
  const pathname = usePathname();
  const { user } = useSessionUser();
  const items = getVisibleNav(user?.role).filter(
    (item) => item.group === 'work',
  );

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Work</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <NavMenuItem
            key={item.href}
            item={item}
            pathname={pathname}
            activeProjectId={activeProjectId}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

// ---------------------------------------------------------------------------
// Admin group - only rendered when at least one admin item is visible.
// We compute visibility from `getVisibleNav` so a future addition like
// `/teams` slots in without changing this file.
// ---------------------------------------------------------------------------

function AdminNavGroup({
  activeProjectId,
}: {
  activeProjectId: string | null;
}) {
  const pathname = usePathname();
  const { user } = useSessionUser();
  const role = user?.role;
  const items = getVisibleNav(role).filter(
    (item) => item.group === 'admin',
  );

  // Don't render an empty "Admin" group with just a label.
  if (items.length === 0) return null;
  // canManageUsers / canViewAudit are the canonical helpers; reference
  // them so tree-shakers + linters see they're part of the contract.
  void canManageUsers;
  void canViewAudit;

  return (
    <>
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupLabel>Admin</SidebarGroupLabel>
        <SidebarMenu>
          {items.map((item) => (
            <NavMenuItem
              key={item.href}
              item={item}
              pathname={pathname}
              activeProjectId={activeProjectId}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// NavMenuItem - one sidebar entry. Pulls the live badge count via
// `useNavBadge` when the item has a `badgeKey`.
// ---------------------------------------------------------------------------

function NavMenuItem({
  item,
  pathname,
  activeProjectId,
}: {
  item: NavItem;
  pathname: string;
  activeProjectId: string | null;
}) {
  const badge = useNavBadge(item.badgeKey);
  // T-ProjectSwitch: work-surface hrefs resolve under the active project
  // (/proj-1/leads). Active-state strips the project segment back to the
  // template so /proj-1/leads/abc still highlights Leads. Unscoped items
  // (/, /users, /audit, and the admin /overview command center via
  // scoped:false) keep template behavior.
  const href = navItemHref(item, activeProjectId);
  const scoped = item.scoped === false ? false : isProjectScopedNavPath(item.href);
  const active = scoped
    ? isNavItemActive(
        item.href,
        activeProjectId === null
          ? pathname
          : stripProjectSegmentForNav(pathname),
      )
    : isNavItemActive(item.href, pathname);
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.label}
      >
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
        >
          <Icon className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {item.badgeKey !== undefined && badge > 0 ? (
        <SidebarMenuBadge>{badge}</SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

// ---------------------------------------------------------------------------
// Footer: NavUser (sidebar-07 pattern) - avatar + name/email trigger with
// a menu holding only real actions (Settings, Sign out). Replaces the
// earlier read-only identity + cog-popover pair (both deleted with this
// change - the dropdown is the single discoverable surface now).
// ---------------------------------------------------------------------------

function UserMenuFooter() {
  const { user, isPending } = useSessionUser();
  const signOut = useSignOut();

  if (isPending || user === null) {
    // T23 (PR3): render a UserSkeleton placeholder while the session
    // resolves - no "Loading…" text, the avatar+lines shape matches
    // the resolved footer so the layout doesn't shift on hydration.
    return (
      <div className="px-2 py-1.5" data-qa="user-skeleton-footer">
        <Skeleton variant="user" />
      </div>
    );
  }

  return (
    <NavUser
      name={user.name || user.email}
      email={user.email}
      role={user.role}
      onSignOut={() => void signOut()}
    />
  );
}

// Re-export so other consumers can read the icon-name list without
// re-importing `NAV_ITEMS` directly.
export { NAV_ITEMS };
