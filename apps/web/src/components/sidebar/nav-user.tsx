'use client';

// NavUser - sidebar-07 pattern, adapted for shadhil-crm (T-Sidebar07).
//
// Sidebar footer: an avatar + name/email trigger that opens a menu
// with ONLY real actions (Settings, Sign out). Deliberately no fake
// items (no "Upgrade to Pro" / "Billing" / "Notifications" placeholders
// from the stock shadcn block) - the honest-state contract forbids
// menu rows that go nowhere.
//
// The user menu in the topbar (app-header.tsx UserMenu) remains as a
// secondary shortcut; this footer menu is the always-visible primary.
//
// Identity: SessionUser has { id, name, email, role } - there
// is no avatar image field on the session wire yet, so we render the
// initials fallback. When better-auth image propagation lands, add
// <AvatarImage> here.

import {
  AvatarRoot,
  AvatarFallback,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@paalstack/react-ui';
import { LuLogOut, LuSettings } from '@paalstack/react-icons/lu';
import Link from 'next/link';

import { ADMIN_LAUNCHER, EMPLOYEE_LAUNCHER } from '@/lib/nav';

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

export function NavUser({
  name,
  email,
  role,
  settingsHref,
  adminHref,
  employeeHref = null,
  onSignOut,
}: {
  name: string;
  email: string;
  role: string;
  /**
   * Resolved Settings URL for this page (org-prefixed). Null only when the org
   * slug has not resolved yet - while null the item renders disabled rather
   * than as a link that would 404 at the app root.
   */
  settingsHref: string | null;
  /**
   * Resolved org-prefixed "Switch Admin" URL, or null to hide the row: null
   * for non-admin roles, while the slug is unresolved, and on /admin/* (where
   * "Switch Employee" is the matching switch).
   */
  adminHref: string | null;
  /** "Switch Employee" URL (work landing), only resolved inside /admin/*; null hides it. */
  employeeHref?: string | null;
  onSignOut: () => void;
}) {
  const AdminIcon = ADMIN_LAUNCHER.icon;
  const EmployeeIcon = EMPLOYEE_LAUNCHER.icon;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenuRoot>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                // `data-popup-open` is the attribute Base UI's Menu.Trigger
                // actually emits while the menu is open (verified on the
                // rendered node; Radix's `data-state="open"` does not exist
                // here, so the old `data-[state=open]:` variants never fired
                // and the trigger gave no "this menu is open" feedback).
                className="data-popup-open:bg-sidebar-accent-normal data-popup-open:text-sidebar-accent-normal-foreground min-w-0 cursor-pointer"
                data-qa="sidebar-user-trigger"
                // Names the person, like the topbar's equivalent. A bare
                // "Account menu" dropped the only identity context a screen
                // reader user gets from this control.
                aria-label={`Account menu for ${name}`}
                title={name}
              >
                <AvatarRoot className="h-8 w-8 shrink-0 rounded-lg">
                  <AvatarFallback className="rounded-lg text-xs">{initials(name)}</AvatarFallback>
                </AvatarRoot>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="text-muted-foreground truncate text-xs">{email}</span>
                </div>
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent className="w-56 rounded-lg" align="start" side="top" sideOffset={4}>
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <AvatarRoot className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg text-xs">{initials(name)}</AvatarFallback>
                </AvatarRoot>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="text-muted-foreground truncate text-xs">{email}</span>
                  <span className="text-muted-foreground truncate text-[10px] tracking-wide uppercase">
                    {role.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Admin mode switch - ABOVE Settings (owner order, 2026-11-09).
                Same row shape as Settings; only rendered when the caller
                resolved an admin href (OWNER/ADMIN, off /admin/*, slug
                known). */}
            {adminHref !== null ? (
              <DropdownMenuItem
                data-qa="sidebar-user-admin"
                className="cursor-pointer gap-2"
                render={
                  <Link href={adminHref}>
                    <AdminIcon className="size-4 shrink-0" />
                    {ADMIN_LAUNCHER.label}
                  </Link>
                }
              />
            ) : null}
            {employeeHref !== null ? (
              <DropdownMenuItem
                data-qa="sidebar-user-employee"
                className="cursor-pointer gap-2"
                render={
                  <Link href={employeeHref}>
                    <EmployeeIcon className="size-4 shrink-0" />
                    {EMPLOYEE_LAUNCHER.label}
                  </Link>
                }
              />
            ) : null}
            {settingsHref !== null ? (
              // Use `render={<Link />}` so the menu item IS the link (same
              // pattern as project-team-list). Nesting <Link> as a child of
              // DropdownMenuItem swallows the navigation click.
              <DropdownMenuItem
                data-qa="sidebar-user-settings"
                className="cursor-pointer gap-2"
                render={
                  <Link href={settingsHref}>
                    <LuSettings className="size-4 shrink-0" />
                    Settings
                  </Link>
                }
              />
            ) : (
              // Org slug not resolved yet: render the row without a target
              // rather than linking to a bare `/settings` (which 404s).
              <DropdownMenuItem data-qa="sidebar-user-settings" disabled className="gap-2">
                <LuSettings className="size-4 shrink-0" />
                Settings
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-qa="sidebar-user-signout"
              onClick={() => {
                onSignOut();
              }}
              className="cursor-pointer gap-2"
            >
              <LuLogOut className="size-4 shrink-0" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
