'use client';

// Notification Center - full page (Wireframes #7 dropdown, #12 mobile; web
// full page per DESIGN.md §11): filter tabs All / Unread, mark-all-read,
// unread counter. The notifications REST module (Pass 1) returns
// `{ total, unread, rows }` - useNotifications unwraps the rows + exposes
// the counters (T-F1).
import { Box, Button } from '@paalstack/react-ui';
import { useState } from 'react';

import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  useMarkNotificationsRead,
  useNotifications,
} from '@/hooks/queries/crm';
import { useParams } from 'next/navigation';

import { useNotificationsRealtime } from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';

// T-F2: the filter tabs are all wired to backend query params now.
// ALL/UNREAD use unreadOnly; LEADS/BOOKINGS/VISITS use typePrefix
// (e.g. 'lead' matches lead.created, lead.transition, lead.reassigned).
type Filter = 'ALL' | 'UNREAD' | 'LEADS' | 'BOOKINGS' | 'VISITS';

const FILTERS: { value: Filter; label: string; typePrefix?: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'UNREAD', label: 'Unread' },
  { value: 'LEADS', label: 'Leads', typePrefix: 'lead' },
  { value: 'BOOKINGS', label: 'Bookings', typePrefix: 'booking' },
  { value: 'VISITS', label: 'Visits', typePrefix: 'visit' },
];

type NotificationRow = {
  id: string;
  type?: string;
  title?: string;
  body?: string;
  leadId?: string | null;
  read?: boolean;
  createdAt?: string;
};

export default function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>('ALL');
  // T-ProjectSwitch: the inbox shows the active project's lead
  // notifications (server resolves through Notification.lead.projectId).
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : undefined;
  const activeFilter = FILTERS.find((f) => f.value === filter);
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
        subtitle="In-app inbox. 90-day visibility."
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
        {FILTERS.map((item) => (
          <Button
            key={item.value}
            variant={filter === item.value ? 'default' : 'outline'}
            onClick={() => setFilter(item.value)}
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
                    {typeof row.title === 'string' && row.title.length > 0
                      ? row.title
                      : 'Notification'}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {typeof row.body === 'string' ? row.body : ''}
                  </p>
                  <p className="text-muted-foreground mt-1 text-[10px] tracking-wide uppercase">
                    {typeof row.createdAt === 'string'
                      ? dateIntl.formatDateTime(row.createdAt)
                      : ''}
                    {typeof row.type === 'string' && row.type.length > 0
                      ? ` · ${row.type}`
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
}: {
  filter: Filter;
  total: number;
  unread: number;
  error: unknown;
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
          ? 'New leads, handoffs, and reminders land here automatically.'
          : total === 0
            ? 'Trigger events will appear here as soon as they happen.'
            : 'Try switching to the All tab.'}
      </p>
    </Box>
  );
}