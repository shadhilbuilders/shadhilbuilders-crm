'use client';

// Notification Center - full page (Wireframes #7 dropdown, #12 mobile; web
// full page per DESIGN.md §11): filter tabs All / Unread, mark-all-read,
// unread counter. The notifications REST module (Pass 1) returns
// `{ total, unread, rows }` - useNotifications unwraps the rows + exposes
// the counters (T-F1).
import { Box, Button } from '@paalstack/react-ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  useMarkNotificationsRead,
  useNotifications,
} from '@/hooks/queries/crm';

import { useNotificationsRealtime } from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';
import { notificationTypeLabel } from '@/lib/notification-labels';
import {
  defaultNotificationFilter,
  notificationFilterDef,
  notificationFiltersForRole,
  notificationInboxCopy,
  type NotificationFilter,
  type NotificationInboxCopy,
} from '@/lib/notification-inbox';
import { notificationHref } from '@/lib/notification-links';
import { useSessionUser } from '@/lib/session';
import { useOrgSlug, useProjectId, useProjectSlug } from '@/lib/tenant-context';

// Filter tabs + role-specific copy live in lib/notification-inbox.ts: a site
// engineer sees All + Unread only (the API clamps their inbox to progress.*).

type NotificationRow = {
  id: string;
  type?: string;
  title?: string;
  body?: string;
  leadId?: string | null;
  unitId?: string | null;
  read?: boolean;
  createdAt?: string;
};

export default function NotificationsPage() {
  const [selected, setSelected] = useState<NotificationFilter | null>(null);
  // Hydration: the session role is client-only, so the server render and first
  // client paint use role=undefined (full tab set); the engineer set lands
  // after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // T-ProjectSwitch: the inbox shows the active project's lead
  // notifications (server resolves through Notification.lead.projectId).
  const projectId = useProjectId() ?? undefined;
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const { user } = useSessionUser();
  const role = mounted ? user?.role : undefined;
  const filters = notificationFiltersForRole(role);
  const copy = notificationInboxCopy(role);
  const filter = selected ?? defaultNotificationFilter(role);
  const activeFilter = notificationFilterDef(filter);
  const notificationsQuery = useNotifications({
    unreadOnly: filter === 'UNREAD',
    typePrefix: activeFilter?.typePrefix,
    projectId,
  });
  // T-E2 (Week 6): live updates - new notifications stream in via SSE
  // and invalidate the list query (no 60s polling).
  useNotificationsRealtime();
  const markRead = useMarkNotificationsRead();
  // T25 (PR3): when the browser is offline and the list is loading,
  // show the "Will sync when online" hint via the skeleton.
  const isOnline = useOnlineStatus();

  const rows = notificationsQuery.data?.rows ?? [];
  const unread = notificationsQuery.data?.unread ?? 0;
  const total = notificationsQuery.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        breadcrumb={[{ label: 'Work' }, { label: 'Notifications' }]}
        subtitle={copy.pageSubtitle}
        action={
          <Button
            variant="outline"
            disabled={markRead.isPending || unread === 0}
            onClick={() => markRead.mutate([])}
            data-qa="mark-all-read"
          >
            Mark all as read
            {unread > 0 ? ` (${unread})` : ''}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {filters.map((item) => (
          <Button
            key={item.value}
            variant={filter === item.value ? 'default' : 'outline'}
            onClick={() => setSelected(item.value)}
            data-qa={`notifications-filter-${item.value.toLowerCase()}`}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {notificationsQuery.isLoading ? (
        <Skeleton variant="text" isOffline={!isOnline} />
      ) : rows.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-lg border">
          {rows.map((raw, index) => {
            const row = raw as NotificationRow;
            const isRead = row.read === true;
            const id = typeof row.id === 'string' ? row.id : null;
            const href = notificationHref(orgSlug, projectSlug, row);
            const titleText =
              typeof row.title === 'string' && row.title.length > 0
                ? row.title
                : 'Notification';
            return (
              <li
                key={id ?? `n-${index}`}
                className="flex items-start gap-3 px-4 py-3"
                data-qa="notification-row"
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
                  <p className="text-sm font-medium">
                    {href === null ? (
                      titleText
                    ) : (
                      <Link
                        href={href}
                        className="text-link hover:underline"
                        data-qa="notification-link"
                        onClick={() => {
                          if (!isRead && id !== null) markRead.mutate([id]);
                        }}
                      >
                        {titleText}
                      </Link>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {typeof row.body === 'string' ? row.body : ''}
                  </p>
                  {/* 12px minimum, sentence case. This was 10px UPPERCASE with
                      0.025em tracking: below the 12px legibility floor, shouting
                      the least important line on the row, and 50 of those nodes
                      were the single biggest detector hit on the page. */}
                  <p className="text-muted-foreground mt-1 text-xs">
                    {typeof row.createdAt === 'string'
                      ? dateIntl.formatDateTime(row.createdAt)
                      : ''}
                    {typeof row.type === 'string' && row.type.length > 0
                      ? ` · ${notificationTypeLabel(row.type)}`
                      : ''}
                  </p>
                </div>
                {!isRead && id !== null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={markRead.isPending}
                    onClick={() => markRead.mutate([id])}
                    data-qa="mark-read"
                    className="shrink-0"
                  >
                    Mark as read
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <NotificationsEmpty
          filter={filter}
          total={total}
          unread={unread}
          error={notificationsQuery.error}
          copy={copy}
        />
      )}
    </div>
  );
}

function NotificationsEmpty({
  filter,
  total,
  unread,
  error,
  copy,
}: {
  filter: NotificationFilter;
  total: number;
  unread: number;
  error: unknown;
  copy: NotificationInboxCopy;
}) {
  // If the backend returned rows=[] on the ALL filter, we render the
  // friendly "no notifications yet" empty state - the inbox genuinely
  // is empty. The error/non-built branches surface ModulePending
  // (ModulePending owns the loading / 404 / 500 surface contract).
  if (error !== null && error !== undefined) {
    return (
      <ModulePending
        title="Notification Center"
        description="Every trigger event lands here - new leads, handoffs, approvals, reminders (DESIGN.md §11)."
        error={error}
      />
    );
  }
  return (
    <Box
      className="border-border rounded-lg border p-10 text-center"
      data-qa="notifications-empty"
    >
      <p className="text-base font-medium">
        {filter === 'UNREAD'
          ? unread === 0
            ? 'No unread notifications.'
            : 'No matches.'
          : 'No notifications yet.'}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        {filter === 'UNREAD'
          ? copy.emptyHintUnread
          : total === 0
            ? copy.emptyHintNoRows
            : copy.emptyHintFiltered}
      </p>
    </Box>
  );
}