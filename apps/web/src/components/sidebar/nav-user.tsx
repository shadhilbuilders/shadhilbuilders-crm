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

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function NavUser({
  name,
  email,
  role,
  settingsHref,
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
  onSignOut: () => void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenuRoot>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground min-w-0"
                data-qa="sidebar-user-trigger"
                aria-label="Account menu"
                title={name}
              >
                <AvatarRoot className="h-8 w-8 shrink-0 rounded-lg">
                  <AvatarFallback className="rounded-lg text-xs">
                    {initials(name)}
                  </AvatarFallback>
                </AvatarRoot>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {email}
                  </span>
                </div>
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent className="w-56 rounded-lg" align="start" side="top" sideOffset={4}>
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <AvatarRoot className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg text-xs">
                    {initials(name)}
                  </AvatarFallback>
                </AvatarRoot>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {email}
                  </span>
                  <span className="text-muted-foreground truncate text-[10px] uppercase tracking-wide">
                    {role.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-qa="sidebar-user-settings"
              disabled={settingsHref === null}
              className="cursor-pointer"
            >
              {settingsHref !== null ? (
                <Link
                  href={settingsHref}
                  className="flex items-center gap-2 text-sm outline-none"
                >
                  <LuSettings className="size-4 shrink-0" />
                  Settings
                </Link>
              ) : (
                // Org slug not resolved yet: render the row without a target
                // rather than linking to a bare `/settings` (which 404s).
                <span className="text-muted-foreground flex items-center gap-2 text-sm">
                  <LuSettings className="size-4 shrink-0" />
                  Settings
                </span>
              )}
            </DropdownMenuItem>
           
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-qa="sidebar-user-signout"
              onClick={() => {
                onSignOut();
              }}
              className="gap-2 cursor-pointer"
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