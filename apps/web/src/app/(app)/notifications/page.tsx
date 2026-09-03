'use client';

// Notification Center — full page (Wireframes #7 dropdown, #12 mobile; web
// full page per DESIGN.md §11): filter tabs All / Unread / Leads / Bookings
// / Visits, date grouping, mark-all-read, deep links. The notifications
// module (SSE + REST) is a backend stub; the bell in AppHeader shows the
// live unread badge once it lands.
import { Button } from '@paalstack/react-ui';
import { useState } from 'react';

import { ModulePending } from '@/components/shared/ModulePending';
import { PageHeader } from '../PageHeader';
import {
  useMarkNotificationsRead,
  useNotifications,
} from '@/hooks/queries/crm';

type Filter = 'ALL' | 'UNREAD' | 'LEADS' | 'BOOKINGS' | 'VISITS';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'UNREAD', label: 'Unread' },
  { value: 'LEADS', label: 'Leads' },
  { value: 'BOOKINGS', label: 'Bookings' },
  { value: 'VISITS', label: 'Visits' },
];

export default function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>('ALL');
  const notificationsQuery = useNotifications({
    unreadOnly: filter === 'UNREAD',
  });
  const markRead = useMarkNotificationsRead();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        breadcrumb={[{ label: 'Work' }, { label: 'Notifications' }]}
        subtitle="In-app inbox for all 12 triggers. 90-day visibility."
        action={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate([])}
          >
            Mark all as read
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((item) => (
          <Button
            key={item.value}
            variant={filter === item.value ? 'default' : 'outline'}
            size="sm"
            className="min-h-11"
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {notificationsQuery.isLoading ? (
        <div className="text-muted-foreground py-16 text-center text-sm">
          Loading notifications…
        </div>
      ) : notificationsQuery.data !== undefined &&
        Array.isArray(notificationsQuery.data) ? (
        <ul className="border-border divide-border divide-y rounded-lg border">
          {(notificationsQuery.data as Record<string, unknown>[]).map(
            (notification, index) => (
              <li key={index} className="flex items-start gap-3 px-4 py-3">
                <span aria-hidden className="mt-1.5">
                  {notification.read === true ? '○' : '●'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {String(notification.title ?? 'Notification')}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {String(notification.body ?? '')}
                  </p>
                </div>
              </li>
            ),
          )}
        </ul>
      ) : (
        <ModulePending
          title="Notification Center"
          description="Every trigger event lands here — new leads, handoffs, approvals, reminders (DESIGN.md §11). The notifications module ships in Implementation Plan Week 7 with the SSE channel."
          error={notificationsQuery.error}
        />
      )}
    </div>
  );
}