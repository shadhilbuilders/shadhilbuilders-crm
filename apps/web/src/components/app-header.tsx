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
  ScrollArea,
  Separator,
} from '@paalstack/react-ui';
import { LuBell, LuCheckCheck, LuLogOut, LuSettings, LuUserRound } from '@paalstack/react-icons/lu';
import Image from 'next/image';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { SidebarToggleButton } from '@/components/app-shell';
import { notificationBellLabel, renderedUnreadCount } from '@/components/app-header-helpers';
import { Skeleton } from '@/components/shared/Skeleton';
import { SseStatusPill } from '@/components/shared/SseStatusPill';
import { ThemeToggle } from '@/components/theme-toggle';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { useSignOut } from '@/lib/auth-actions';
import { orgHref, projectHref } from '@/lib/nav';
import { useProjectSlug, useOrgSlug } from '@/lib/tenant-context';
import { useSessionUser } from '@/lib/session';
import {
  useMarkNotificationsRead,
  useNotifications,
  useNotificationsRealtime,
} from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';

import { OfflineQueueBadge } from '@/components/offline-queue-badge';

export function AppHeader() {
  const { user, isPending } = useSessionUser();
  const signOut = useSignOut();
  const searchParams = useSearchParams();
  // Resolved org slug for the account menu's Settings link (org-scoped route).
  const orgSlug = useOrgSlug();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // button → "Hydration failed because the server rendered HTML didn't
  // match the client." Render the skeleton for the first client paint too,
  // then swap to the menu after mount.
  useEffect(() => {
    setMounted(true);
  }, []);

  const showUserArea = mounted && !isPending && user !== null;

  // T-D3: SSE pill only renders when the URL has ?debug=1. Read on
  // every render so URL changes (e.g. devtools typing the query) take
  // effect immediately. searchParams is stable per render from
  // next/navigation.
  const showDebugPill = searchParams.get('debug') === '1';

  return (
    <header className="border-border bg-background/95 supports-backdrop-filter:bg-background/75 sticky top-0 z-40 flex min-h-16 items-center justify-between gap-3 border-b px-4 pt-[max(0px,env(safe-area-inset-top))] backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        {/* T-Sidebar07: the expand/collapse affordance lives here (canonical
            shadcn sidebar-07 position) - beside the welcome message, visible
            on ALL breakpoints. Same LuPanelLeft icon as the sidebar's own
            toggle (SidebarToggleButton), shared via the export from
            app-shell. -ml-1 aligns the ghost button's hit area with the
            header's px-4 padding. */}
        <SidebarToggleButton className="-ml-1" />
        {/* Company logo (brand-icon.png - same square mark the collapsed
            sidebar uses) placed next to the toggle so the brand stays
            visible in the topbar even when the sidebar is collapsed /
            closed (mobile Sheet). */}
        <Link
          href={orgSlug !== null ? `/${orgSlug}` : '/'}
          className="inline-flex shrink-0 items-center overflow-hidden"
          aria-label="Shadhil Builders home"
          data-qa="topbar-brand-logo"
        >
          <Image
            src="/brand/logo-bg.png"
            alt="Shadhil Builders"
            width={120}
            height={20}
            className="w-30 h-auto object-contain"
            loading="eager"
          />
        </Link>
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
            and signals "loading" via shape, not text. Gated on the
            `mounted` flag so SSR and the first client paint both show
            the skeleton (no hydration mismatch from the SSR session). */}
        {showUserArea ? (
          <UserMenu
            name={user!.name || user!.email}
            role={user!.role}
            // Settings is org-scoped (`/[orgSlug]/settings`); the href needs the
            // resolved slug (which useOrgSlug falls back to from the URL).
            settingsHref={orgSlug !== null ? orgHref(orgSlug, '/settings') : null}
            onSignOut={() => void signOut()}
          />
        ) : (
          <div
            className="min-w-30 px-2"
            data-qa="user-skeleton-topbar"
          >
            <Skeleton variant="user" />
          </div>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Notification bell - opens a popover with the latest unread notifications,
// per-item mark-read, mark-all-read, and a footer link to the full
// notifications page. Live counts/realtime via useNotifications + SSE.
// ---------------------------------------------------------------------------

type NotificationRow = {
  id: string;
  type?: string;
  title?: string;
  body?: string;
  read?: boolean;
  createdAt?: string;
};

function NotificationBell() {
  const { data: projects } = useProjects();
  const orgSlug = useOrgSlug();
  const projectSlugCtx = useProjectSlug();
  const query = useNotifications({ unreadOnly: true });
  // T-E2: SSE keeps the unread count/list fresh (same channel as the
  // full notifications page).
  useNotificationsRealtime();
  const markRead = useMarkNotificationsRead();

  const rows = (query.data?.rows ?? []) as NotificationRow[];
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Mounted gate (hydration): see AppHeader above. projectHref needs the
  // resolved org + project slugs; until mounted we render a stable
  // placeholder href.
  const projectId = mounted
    ? (projectSlugCtx ?? pickDefaultProject(projects ?? [])?.slug ?? null)
    : null;
  const href = projectHref(mounted ? orgSlug : null, projectId, '/notifications');

  // Hydration (2026-09-18): `unread` MUST be gated on `mounted`, like `href`
  // below. It comes from a client-only query, so the server rendered 0
  // ("Notifications") while the first client paint rendered the real count
  // ("38 unread notifications") - React reported "Hydration failed because the
  // server rendered HTML didn't match the client" and regenerated the tree.
  // The label and the badge both derive from this ONE gated value so they can
  // never disagree. Logic lives in app-header-helpers.ts (unit-tested).
  const unread = renderedUnreadCount(mounted, query.data?.unread);

  return (
    <PopoverRoot>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="relative min-h-11 min-w-11 gap-1 px-2"
            aria-label={notificationBellLabel(unread)}
            data-qa="notifications-bell"
          >
            <LuBell className="size-5" />
            {unread > 0 ? (
              <span
                className="bg-primary text-primary-foreground absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums"
                aria-hidden="true"
              >
                {unread}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent className="w-80" align="end">
        <div className="flex items-center justify-between px-1 pb-1">
          <p className="text-sm font-semibold">Notifications</p>
          {/* Mark all as read - same mutation as the full page ([] = all). */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={markRead.isPending || unread === 0}
            onClick={() => markRead.mutate([])}
            data-qa="notifications-mark-all-read"
          >
            <LuCheckCheck className="size-3.5" />
            Mark all read
          </Button>
        </div>
        <Separator className="mb-1" />
        {query.isLoading ? (
          <Skeleton variant="text" className="p-2" />
        ) : rows.length > 0 ? (
          <ScrollArea className="h-80">
            <ul className="space-y-1 p-1">
              {rows.map((row, index) => {
                const isRead = row.read === true;
                const id = typeof row.id === 'string' ? row.id : null;
                return (
                  <li
                    key={id ?? `n-${index}`}
                    className="hover:bg-accent flex items-start gap-2 rounded-md px-2 py-2"
                    data-qa="notification-popover-row"
                  >
                    <span
                      aria-hidden
                      className={
                        isRead
                          ? 'text-muted-foreground mt-1.5'
                          : 'mt-1.5 text-blue-600'
                      }
                    >
                      {isRead ? '○' : '●'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {typeof row.title === 'string' && row.title.length > 0
                          ? row.title
                          : 'Notification'}
                      </p>
                      {typeof row.body === 'string' && row.body.length > 0 ? (
                        <p className="text-muted-foreground line-clamp-2 text-xs">
                          {row.body}
                        </p>
                      ) : null}
                      <p className="text-muted-foreground mt-0.5 text-[10px] uppercase tracking-wide">
                        {typeof row.createdAt === 'string'
                          ? dateIntl.formatDateTime(row.createdAt)
                          : ''}
                      </p>
                    </div>
                    {!isRead && id !== null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs"
                        disabled={markRead.isPending}
                        onClick={() => markRead.mutate([id])}
                        data-qa="notifications-mark-read"
                      >
                        Mark read
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        ) : (
          <div className="px-1 py-6 text-center" data-qa="notifications-popover-empty">
            <p className="text-sm font-medium">No unread notifications.</p>
            <p className="text-muted-foreground mt-1 text-xs">
              New leads, handoffs, and reminders land here automatically.
            </p>
          </div>
        )}
        {/* Footer: link to the full notifications page. */}
        <Separator className="my-1" />
        <Link
          href={href}
          className="hover:bg-accent flex w-full items-center justify-center gap-1 rounded-md px-3 py-2 text-sm"
        >
          View all notifications
        </Link>
      </PopoverContent>
    </PopoverRoot>
  );
}

function UserMenu({
  name,
  role,
  settingsHref,
  onSignOut,
}: {
  name: string;
  role: string;
  /** Resolved org-scoped Settings URL; null while the slug is unresolved. */
  settingsHref: string | null;
  onSignOut: () => void;
}) {
  return (
    <PopoverRoot>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 gap-2 px-3"
            // The name span is `hidden` below `sm`, so at narrow widths this
            // icon-only button has no text content - without an explicit label
            // it has NO accessible name (axe `button-name`, critical).
            aria-label={`Account menu for ${name}`}
            data-qa="account-menu"
          >
            <LuUserRound className="size-5" aria-hidden />
            <span className="hidden max-w-40 truncate sm:inline">
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
        {settingsHref !== null ? (
          <Link
            href={settingsHref}
            className="hover:bg-accent mt-1 flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm"
            data-qa="account-menu-settings"
          >
            <LuSettings className="size-4 shrink-0" />
            Settings
          </Link>
        ) : (
          // Org slug unresolved: keep the row's shape but make it inert, rather
          // than pointing at a bare `/settings` (which has no route).
          <span
            aria-disabled="true"
            className="text-muted-foreground mt-1 flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm"
            data-qa="account-menu-settings"
          >
            <LuSettings className="size-4 shrink-0" />
            Settings
          </span>
        )}
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
