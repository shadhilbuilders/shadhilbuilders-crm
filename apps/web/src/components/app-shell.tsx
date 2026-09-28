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
import { useEffect, useState } from 'react';

import {
  Button,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@paalstack/react-ui';
import { LuArrowLeft, LuChevronRight, LuPanelLeft } from '@paalstack/react-icons/lu';

import { NavUser } from '@/components/sidebar/nav-user';
import { ProjectSwitcher } from '@/components/sidebar/project-switcher';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { useSignOut } from '@/lib/auth-actions';
import { useOrgSlug } from '@/lib/tenant-context';
import { workLandingHref } from '@/lib/dashboard-redirect';
import {
  activeOrgSlugFromPathname,
  activeProjectSlugFromPathname,
  getVisibleNav,
  isAdminPathname,
  isNavItemActive,
  navItemHref,
  orgHref,
  stripProjectSegment as stripProjectSegmentForNav,
  NAV_ITEMS,
  useNavBadge,
  useNavSync,
  type NavItem,
} from '@/lib/nav';
import { Skeleton } from '@/components/shared/Skeleton';
import { isAdminLike, useSessionUser } from '@/lib/session';
import Image from 'next/image';

export function AppShell() {
  // T37: close the mobile Sheet whenever the route changes.
  useNavSync();
  // T-ProjectSwitch: the active project is the URL's [projectSlug] on work
  // surfaces (/[orgSlug]/projects/metro-heights/leads). The tenant provider
  // from the server layout supplies the resolved org; fall back to parsing
  // the pathname when not under a provider.
  const pathname = usePathname();
  const ctxOrgSlug = useOrgSlug();
  const pathOrgSlug = activeOrgSlugFromPathname(pathname);
  const pathProjectSlug = activeProjectSlugFromPathname(pathname);
  const { data: projects } = useProjects();
  const activeOrgSlug = ctxOrgSlug ?? pathOrgSlug ?? null;
  const inAdmin = isAdminPathname(pathname);
  const activeProjectSlug = pathProjectSlug ?? pickDefaultProject(projects ?? [])?.slug ?? null;
  // useNavBadge needs the project ID (badge counts are id-keyed API calls).
  // Resolve it from the slug against the registry so the badge hook gets a
  // real id (fall back to the default project's id).
  const activeProjectId =
    projects?.find((p) => p.slug === activeProjectSlug)?.id ??
    pickDefaultProject(projects ?? [])?.id ??
    null;
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
            href={activeOrgSlug ? `/${activeOrgSlug}` : '/'}
            // T-DASH-MOBILE: h-10 is 40px - just under the 44px tap-target
            // minimum. 44px on a coarse pointer, unchanged on a mouse.
            className="text-primary inline-flex h-10 min-h-11 shrink-0 items-center overflow-hidden pointer-fine:min-h-10"
            aria-label="Shadhil CRM home"
            data-qa="sidebar-brand"
          >
            {isCollapsed ? (
               <Image
               src="/icons/brand-icon.png"
               alt="Shadhil Builders"
               width={28}
               height={28}
               className="size-10 object-contain"
               data-qa="sidebar-brand-icon-collapsed"
             />
            ) : (
              <Image
              src="/brand/logo.png"
              alt="Shadhil Builders"
              width={130}
              height={34}
              className="w-38 h-auto object-contain"
              data-qa="sidebar-brand-logo-expanded"
              />
            )}
          </Link>
        </div>
        {/* Separator between the brand chip and whatever follows it -
            the project switcher on work routes, or the "Go to Work" link
            (top of AdminNavGroup) on /admin/* - so the two header
            sections always read as distinct groups. */}
        <SidebarSeparator />
        {!inAdmin ? (
          <SidebarSwitcherSlot
            activeProjectSlug={activeProjectSlug}
            activeOrgSlug={activeOrgSlug}
          />
        ) : null}
      </SidebarHeader>
      <SidebarContent className="min-w-0 overflow-x-hidden">
        {inAdmin ? (
          <AdminNavGroup
            activeProjectId={activeProjectId}
            activeProjectSlug={activeProjectSlug}
            activeOrgSlug={activeOrgSlug}
            workHref={workLandingHref(activeOrgSlug, projects ?? [])}
          />
        ) : (
          <WorkNavGroup
            activeProjectId={activeProjectId}
            activeProjectSlug={activeProjectSlug}
            activeOrgSlug={activeOrgSlug}
          />
        )}
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
      {/*
        T-DASH-MOBILE note: the library's SidebarRail is a 16px-wide edge strip
        with `tabIndex={-1}` and an aria-label of "Toggle Sidebar" - it exists as
        a mouse-drag affordance and is deliberately NOT reachable by keyboard.
        Flagging an intentional mouse-only affordance as a tap-target failure
        would push a fix that cannot help: a 16px-wide strip of the viewport
        edge is not something a finger should own, and the real toggle is 44x44
        on a coarse pointer (see SidebarToggleButton). Left as-is on purpose.
      */}
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
  activeProjectSlug,
  activeOrgSlug,
}: {
  activeProjectSlug: string | null;
  activeOrgSlug: string | null;
}) {
  const { user } = useSessionUser();
  const { data: projects, isPending: projectsPending } = useProjects();

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

  const canManageProjects = isAdminLike(user.role);

  return (
    <ProjectSwitcher
      projects={projects ?? []}
      activeProjectSlug={activeProjectSlug}
      activeOrgSlug={activeOrgSlug}
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
      // T-DASH-MOBILE: `size-8` is 32px - under the 44px tap-target minimum,
      // and it is the ONLY way to reach the nav on a phone (the sidebar is
      // hidden behind it). 44px on a coarse pointer; unchanged on a mouse.
      // `size-8` is kept rather than replaced so the icon size does not shift.
      className={`size-8 min-h-11 min-w-11 shrink-0 cursor-pointer pointer-fine:min-h-8 pointer-fine:min-w-8 ${className ?? ''}`}
      onClick={() => toggleSidebar()}
    >
      <LuPanelLeft className="size-4-5" />
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Work group - visible to every signed-in user. Source: NAV_ITEMS, so a
// new route added to `lib/nav.ts` lights up here automatically.
// ---------------------------------------------------------------------------

function WorkNavGroup({
  activeProjectId,
  activeProjectSlug,
  activeOrgSlug,
}: {
  activeProjectId: string | null;
  activeProjectSlug: string | null;
  activeOrgSlug: string | null;
}) {
  const pathname = usePathname();
  const { user, isPending } = useSessionUser();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Session/role still resolving (e.g. alongside a full-page PageLoading
  // on first load or a redirect) → skeleton rows instead of an empty gap
  // next to the collapsed nav.
  if (!mounted || isPending) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Work</SidebarGroupLabel>
        <Skeleton variant="navItems" />
      </SidebarGroup>
    );
  }

  const items = getVisibleNav(user?.role).filter((item) => item.group === 'work');

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
            activeProjectSlug={activeProjectSlug}
            activeOrgSlug={activeOrgSlug}
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
  activeProjectSlug,
  activeOrgSlug,
  workHref,
}: {
  activeProjectId: string | null;
  activeProjectSlug: string | null;
  activeOrgSlug: string | null;
  workHref: string;
}) {
  const pathname = usePathname();
  const { user, isPending } = useSessionUser();
  const role = user?.role;
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. During SSR `role` is
  // undefined, so `getVisibleNav` returns no admin items and this group
  // renders `null`; on the client the session resolves and the Admin group
  // (with its SidebarSeparator) appears → "Hydration failed because the
  // server rendered HTML didn't match the client." Render nothing for the
  // first client paint too, then swap after mount (same pattern as
  // app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  // Session still resolving → skeleton rows instead of null. This component
  // only mounts when the pathname is already under /admin, so we know a
  // real Admin group will land here once the role resolves - a full-page
  // PageLoading in `children` shouldn't leave the sidebar's Admin section
  // blank in the meantime.
  if (!mounted || isPending) {
    return (
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Go to Work">
              <Link
                href={workHref}
                data-qa="sidebar-go-to-work"
                className="min-h-11 pointer-fine:min-h-8"
              >
                <LuArrowLeft className="size-4 shrink-0" />
                <span className="min-w-0 truncate">Go to Work</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarGroupLabel>Admin</SidebarGroupLabel>
        <Skeleton variant="navItems" count={6} />
      </SidebarGroup>
    );
  }

  const items = getVisibleNav(role).filter((item) => item.group === 'admin');

  // Don't render an empty "Admin" group with just a label once the session
  // has resolved and the user genuinely has no admin items.
  if (items.length === 0) return null;

  return (
    <SidebarGroup>
      {/* Exit-admin affordance: a standalone link, NOT a NAV_ITEMS entry
          (it isn't a page inside /admin/*, so getVisibleNav shouldn't walk
          it). Sits above the "Admin" label so it reads as leaving the
          section, not as one more admin page. */}
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Go to Work">
            <Link href={workHref} data-qa="sidebar-go-to-work">
              <LuArrowLeft className="size-4 shrink-0" />
              <span className="min-w-0 truncate">Go to Work</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarGroupLabel>Admin</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <NavMenuItem
            key={item.href}
            item={item}
            pathname={pathname}
            activeProjectId={activeProjectId}
            activeProjectSlug={activeProjectSlug}
            activeOrgSlug={activeOrgSlug}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
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
  activeProjectSlug,
  activeOrgSlug,
}: {
  item: NavItem;
  pathname: string;
  activeProjectId: string | null;
  activeProjectSlug: string | null;
  activeOrgSlug: string | null;
}) {
  // Submenu parent (children present): render a Collapsible whose children
  // are nested SidebarMenuSub items.
  if (item.children !== undefined && item.children.length > 0) {
    return (
      <NavMenuSubmenu
        item={item}
        children={item.children}
        pathname={pathname}
        activeOOrgSlug={activeOrgSlug}
        activeProjectSlug={activeProjectSlug}
      />
    );
  }

  const badge = useNavBadge(item.badgeKey, activeProjectId);
  // T-ProjectSwitch: work-surface hrefs resolve under the active project
  // slug (/shadhil-builders/projects/metro-heights/leads). Active-state
  // strips the org+project prefix back to the template so .../leads/abc
  // still highlights Leads. Unscoped items (/users, /audit, /overview via
  // scoped:false) resolve under just the org slug.
  const href = navItemHref(item, activeOrgSlug, activeProjectSlug);
  const active = isNavItemActive(item.href, stripProjectSegmentForNav(pathname));
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
          // T-DASH-MOBILE: the library's nav row is 32px tall, under the 44px
          // tap-target minimum - and this is the whole navigation on a phone.
          // 44px on a coarse pointer, library default on a mouse.
          className="min-h-11 pointer-fine:min-h-8"
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

/**
 * A collapsible submenu under a sidebar item. `defaultOpen` is captured ONCE
 * via a useState lazy initializer (any child active on first mount), so we
 * never pass a changing `defaultOpen` to the uncontrolled Base UI
 * Collapsible - that triggers its "changing default open state of
 * uncontrolled Collapsible" warning.
 */
function NavMenuSubmenu({
  item,
  children,
  pathname,
  activeOOrgSlug,
  activeProjectSlug,
}: {
  item: NavItem;
  children: readonly NavItem[];
  pathname: string;
  activeOOrgSlug: string | null;
  activeProjectSlug: string | null;
}) {
  const [defaultOpen] = useState(() =>
    children.some((c) => isNavItemActive(c.href, stripProjectSegmentForNav(pathname)))
  );
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <CollapsibleRoot defaultOpen={defaultOpen} className="group/collapsible w-full">
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              tooltip={item.label}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <LuChevronRight className="ml-auto size-4 shrink-0 transition-transform duration-200 group-data-open/collapsible:rotate-90" />
            </SidebarMenuButton>
          }
        />
        <CollapsibleContent>
          <SidebarMenuSub>
            {children.map((child) => (
              <SidebarMenuSubItem key={child.href}>
                <NavMenuSubLink
                  child={child}
                  pathname={pathname}
                  activeOOrgSlug={activeOOrgSlug}
                  activeProjectSlug={activeProjectSlug}
                />
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </CollapsibleRoot>
    </SidebarMenuItem>
  );
}

/** A link inside a submenu (rendered by NavMenuItem for `children`). */
function NavMenuSubLink({
  child,
  pathname,
  activeOOrgSlug,
  activeProjectSlug,
}: {
  child: NavItem;
  pathname: string;
  activeOOrgSlug: string | null;
  activeProjectSlug: string | null;
}) {
  const href = navItemHref(child, activeOOrgSlug, activeProjectSlug);
  const active = isNavItemActive(child.href, stripProjectSegmentForNav(pathname));
  const Icon = child.icon;
  return (
    <SidebarMenuSubButton asChild isActive={active}>
      <Link href={href} aria-current={active ? 'page' : undefined}>
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{child.label}</span>
      </Link>
    </SidebarMenuSubButton>
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
  const orgSlug = useOrgSlug();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // NavUser (a <ul>) → "Hydration failed because the server rendered HTML
  // didn't match the client." Render the skeleton for the first client
  // paint too, then swap after mount (same pattern as app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isPending || user === null) {
    // T23 (PR3): render a UserSkeleton placeholder while the session
    // resolves - no "Loading..." text, the avatar+lines shape matches
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
      // Settings is an ORGANIZATION-scoped page (`/[orgSlug]/settings`), so the
      // href needs the resolved slug. useOrgSlug() falls back to the URL's first
      // segment when the context isn't mounted, and returns null off-app - in
      // which case NavUser renders the row inert instead of linking to a 404.
      settingsHref={orgSlug !== null ? orgHref(orgSlug, '/settings') : null}
      onSignOut={() => void signOut()}
    />
  );
}

// Re-export so other consumers can read the icon-name list without
// re-importing `NAV_ITEMS` directly.
export { NAV_ITEMS };
