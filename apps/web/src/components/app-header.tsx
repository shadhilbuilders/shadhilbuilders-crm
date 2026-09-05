'use client';

// AppHeader - slim topbar inside the (app) layout's SidebarInset.
//
// History: Phase-1 had a full horizontal top-nav (logo + module nav +
// user menu) here. The Phase-2 shell (plan §3.1) moves module nav
// into the sidebar; this topbar becomes:
//   - SidebarTrigger (mobile-only hamburger that opens the Sheet)
//   - welcome greeting (large, colored - the visual focus of the topbar)
//   - OfflineQueueBadge (D6: revalidation signal sits next to the user
//     surface that queues work, not in a global <main>)
//   - UserMenu popover (avatar + sign out + Settings)
//
// Plan §3.2 / §11 T8. Note: the notification bell is rendered
// explicitly with `useNotifications({unreadOnly:true})` so the count
// is honest - it reads from the live query, never a hard-coded value.
// Until the notifications module ships, the count stays at 0 (which
// matches the badge contract in ModulePending: no fake numbers).
//
// T-D3 SSE pill: hidden by default; rendered when the URL has
// `?debug=1`. The pill is a dev/ops signal, not user-facing chrome.

import {
  Button,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Separator,
} from '@paalstack/react-ui';
import { LuBell, LuLogOut, LuSettings, LuUserRound } from '@paalstack/react-icons/lu';
import { SidebarTrigger } from '@paalstack/react-ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { Skeleton } from '@/components/shared/Skeleton';
import { SseStatusPill } from '@/components/shared/SseStatusPill';
import { ThemeToggle } from '@/components/theme-toggle';
import { useSignOut } from '@/lib/auth-actions';
import { useSessionUser } from '@/lib/session';
import { useNotifications } from '@/hooks/queries/crm';

import { OfflineQueueBadge } from '@/components/offline-queue-badge';

export function AppHeader() {
  const { user, isPending } = useSessionUser();
  const signOut = useSignOut();
  const searchParams = useSearchParams();
  // T-D3: SSE pill only renders when the URL has ?debug=1. Read on
  // every render so URL changes (e.g. devtools typing the query) take
  // effect immediately. searchParams is stable per render from
  // next/navigation.
  const showDebugPill = searchParams.get('debug') === '1';

  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1 md:hidden" />
        {isPending ? (
          <span
            aria-hidden
            className="text-muted-foreground hidden truncate text-base font-semibold sm:inline"
            data-qa="topbar-greeting"
          >
            {'\u00a0'}
          </span>
        ) : user !== null ? (
          <span
            className="text-foreground hidden min-w-0 truncate text-base font-semibold sm:inline"
            data-qa="topbar-greeting"
          >
            Welcome, {user.name || user.email}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <OfflineQueueBadge />
        {showDebugPill ? (
          <>
            <SseStatusPill />
            <span
              aria-hidden="true"
              data-qa="topbar-debug-separator"
              className="bg-border mx-1 block h-4 w-px shrink-0 self-center"
            />
          </>
        ) : null}
        <ThemeToggle />
        <NotificationBell />
        {/* T23 (PR3): render a UserSkeleton placeholder in the slot
            where the UserMenu will mount once the session resolves.
            Keeps the topbar height stable during the first paint
            and signals "loading" via shape, not text. */}
        {isPending ? (
          <div
            className="min-w-[120px] px-2"
            data-qa="user-skeleton-topbar"
          >
            <Skeleton variant="user" />
          </div>
        ) : user !== null ? (
          <UserMenu
            name={user.name || user.email}
            role={user.role}
            onSignOut={() => void signOut()}
          />
        ) : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Notification bell - honest count from useNotifications, not a stub.
// Until the backend module ships, useNotifications errors → count is 0.
// ---------------------------------------------------------------------------

function NotificationBell() {
  const query = useNotifications({ unreadOnly: true });
  const count = Array.isArray(query.data) ? query.data.length : 0;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="relative min-h-11 min-w-11 gap-1 px-2"
      aria-label={
        count === 0 ? 'Notifications' : `${count} unread notifications`
      }
    >
      <LuBell className="size-5" />
      {count > 0 ? (
        <span
          className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums"
          aria-hidden="true"
        >
          {count}
        </span>
      ) : null}
    </Button>
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
            <LuUserRound className="size-5" />
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
        <Link
          href="/settings"
          className="hover:bg-accent mt-1 flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm"
        >
          <LuSettings className="size-4 shrink-0" />
          Settings
        </Link>
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
