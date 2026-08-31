'use client';

// Authenticated app shell + top navigation.
//
// Replaces the Phase-1 SiteHeader on app pages. Left = brand + module nav,
// right = notification bell (badge) + user menu with role + sign-out.
// Nav is role-aware: Users shows for admin-class+managers, Audit for
// admin-class only (DESIGN.md §4 permission matrix).
import {
  Button,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Separator,
} from '@paalstack/react-ui';
import { LuLogOut, LuUserRound } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { authClient } from '@/lib/auth-client';
import {
  canManageUsers,
  canViewAudit,
  useSessionUser,
} from '@/lib/session';

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/leads', label: 'Leads' },
  { href: '/visits', label: 'Visits' },
  { href: '/inventory', label: 'Inventory' },
  { href: '/notifications', label: 'Notifications' },
];

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isPending } = useSessionUser();

  const signOut = useCallback(async () => {
    await authClient.signOut();
    router.replace('/login');
    router.refresh();
  }, [router]);

  const manageUsersVisible = canManageUsers(user?.role);
  const auditVisible = canViewAudit(user?.role);

  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-40 border-b backdrop-blur">
      <div className="container mx-auto flex h-14 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <Link
            href="/"
            className="text-primary -ml-2 inline-flex min-h-11 shrink-0 items-center px-2 font-semibold"
          >
            Shadhil CRM
          </Link>
          <Separator orientation="vertical" className="hidden h-5 sm:block" />
          <nav className="flex min-w-0 items-center overflow-x-auto">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center whitespace-nowrap px-3 text-sm ${
                    active
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {manageUsersVisible ? (
              <Link
                href="/users"
                aria-current={pathname.startsWith('/users') ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center whitespace-nowrap px-3 text-sm ${
                  pathname.startsWith('/users')
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Users
              </Link>
            ) : null}
            {auditVisible ? (
              <Link
                href="/audit"
                aria-current={pathname.startsWith('/audit') ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center whitespace-nowrap px-3 text-sm ${
                  pathname.startsWith('/audit')
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Audit
              </Link>
            ) : null}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!isPending && user !== null ? (
            <UserMenu
              name={user.name || user.email}
              role={user.role}
              onSignOut={() => void signOut()}
            />
          ) : null}
        </div>
      </div>
    </header>
  );
}

function UserMenu({
  name,
  role,
  onSignOut,
}: {
  name: string;
  role: string;
  onSignOut: () => void;
}) {
  return (
    <PopoverRoot>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="min-h-11 gap-2 px-3">
            <LuUserRound className="h-4 w-4" />
            <span className="hidden max-w-[10rem] truncate sm:inline">
              {name}
            </span>
          </Button>
        }
      />
      <PopoverContent className="w-56" align="end">
        <div className="mb-2 px-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-muted-foreground text-xs">{role.replace('_', ' ')}</p>
        </div>
        <Separator />
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start"
          onClick={onSignOut}
        >
          <LuLogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </PopoverContent>
    </PopoverRoot>
  );
}