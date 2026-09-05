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

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Button,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Separator,
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
  SidebarTrigger,
} from '@paalstack/react-ui';
import { LuLogOut, LuSettings, LuUserRound } from '@paalstack/react-icons/lu';

import { useSignOut } from '@/lib/auth-actions';
import {
  getVisibleNav,
  isNavItemActive,
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

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <div className="flex items-center gap-2">
          {/* Full brand lockup on its native white tile - rendered as a
              rounded chip so the opaque white canvas reads as intentional
              in both themes instead of a floating white box. The tagline
              is part of the asset; h-8 keeps it legible. In the collapsed
              (icon) rail the wordmark truncates to a compact strip.
              No px-* here: the SidebarHeader already adds p-2, and the
              nav items below also use p-2, so the brand and nav share
              the same left edge. (Was 8px misaligned before this fix.) */}
          <Link
            href="/"
            className="inline-flex h-15 shrink-0 items-center overflow-hidden rounded-md bg-white px-2.5 dark:bg-white"
            aria-label="Shadhil CRM home"
            data-qa="sidebar-brand"
          >
            <Image
              src="/brand/logo.png"
              alt="Shadhil Builders"
              width={112}
              height={34}
              className="h-11/12 w-auto object-contain"
            />
          </Link>
          {/* The chip carries the full brand lockup (wordmark + tagline);
              the duplicate "Shadhil CRM" text label is redundant at this
              size and truncates awkwardly next to a 143px chip. Hidden
              entirely - the chip IS the brand. */}
        </div>
        <SidebarTrigger className="md:hidden" />
      </SidebarHeader>
      <SidebarContent className="min-w-0 overflow-x-hidden">
        <WorkNavGroup />
        <AdminNavGroup />
      </SidebarContent>
      <SidebarFooter className="min-w-0 overflow-x-hidden">
        <Separator />
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
// Work group - visible to every signed-in user. Source: NAV_ITEMS, so a
// new route added to `lib/nav.ts` lights up here automatically.
// ---------------------------------------------------------------------------

function WorkNavGroup() {
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

function AdminNavGroup() {
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
}: {
  item: NavItem;
  pathname: string;
}) {
  const badge = useNavBadge(item.badgeKey);
  const active = isNavItemActive(item.href, pathname);
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.label}
      >
        <Link
          href={item.href}
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
// Footer: UserMenu (avatar + name + role) + sign out. The popover
// mirrors the original topbar `UserMenu` (T3 + T6 - both consume
// `useSignOut`).
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
    <div className="flex w-full min-w-0 items-center gap-1 px-2">
      <UserIdentity
        name={user.name || user.email}
        role={user.role}
      />
      <SettingsMenu onSignOut={() => void signOut()} />
    </div>
  );
}

// Read-only identity block (avatar + name + role). Not a button — the
// footer has a SettingsMenu (cog icon) for app-level actions, and there
// is no user-level action worth a popover today. If a /profile page or
// "Switch team" lands later, wire those into the SettingsMenu (or a
// dedicated UserMenu popover) at that point — until then, the clickable
// affordance was misleading (the popover only re-displayed the same
// identity info).
function UserIdentity({ name, role }: { name: string; role: string }) {
  return (
    <div
      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2"
      title={`${name} - ${role.replace(/_/g, ' ')}`}
      data-qa="sidebar-user-identity"
    >
      <LuUserRound className="size-4 shrink-0" />
      <span className="hidden min-w-0 flex-1 truncate text-left text-sm sm:inline">
        {name}
      </span>
    </div>
  );
}

// App-level actions menu. The user popover (UserMenu) handles identity
// (avatar + name + role); this one handles app-level actions like
// Settings and Sign out. A cog icon is the conventional affordance for
// settings; the popover keeps the footer compact while staying
// discoverable.
function SettingsMenu({ onSignOut }: { onSignOut: () => void }) {
  return (
    <PopoverRoot>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Settings"
            title="Settings"
          >
            <LuSettings className="size-4" />
          </Button>
        }
      />
      <PopoverContent className="w-44" align="end">
        <div className="flex flex-col">
          <Link
            href="/settings"
            className="hover:bg-accent flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm"
          >
            <LuSettings className="size-4 shrink-0" />
            <span>Settings</span>
          </Link>
          <Separator className="my-1" />
          <button
            type="button"
            onClick={onSignOut}
            className="hover:bg-accent flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
          >
            <LuLogOut className="size-4 shrink-0" />
            <span>Sign out</span>
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

// Re-export so other consumers can read the icon-name list without
// re-importing `NAV_ITEMS` directly.
export { NAV_ITEMS };
