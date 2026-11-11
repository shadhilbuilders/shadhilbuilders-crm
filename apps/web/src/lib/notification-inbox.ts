// Role-shaped notification inbox facts (2026-11-10): which filter tabs a role
// sees, and which words the inbox uses.
//
// A site engineer has no lead, booking or visit work, so those tabs are not
// merely empty for them - they are the wrong question. They get ALL + UNREAD
// only; the API clamps their inbox to `progress.*`, so "All" means "all my site
// updates". Kept out of the route file (Next route files may only export
// reserved names) and out of app-header.tsx (the page needs it too).
import type { Role } from '@/apis/client';
import { isSiteOnlyRole } from '@/lib/session';

export type NotificationFilter = 'ALL' | 'UNREAD' | 'LEADS' | 'BOOKINGS' | 'VISITS' | 'SITE';

export type NotificationFilterDef = {
  value: NotificationFilter;
  label: string;
  typePrefix?: string;
};

// T-F2: ALL/UNREAD use unreadOnly; the rest use typePrefix
// (e.g. 'lead' matches lead.created, lead.transition, lead.reassigned).
// Site-update notifications are typed 'progress.*', which no other prefix matches.
export const NOTIFICATION_FILTERS: readonly NotificationFilterDef[] = [
  { value: 'ALL', label: 'All' },
  { value: 'UNREAD', label: 'Unread' },
  { value: 'LEADS', label: 'Leads', typePrefix: 'lead' },
  { value: 'BOOKINGS', label: 'Bookings', typePrefix: 'booking' },
  { value: 'VISITS', label: 'Visits', typePrefix: 'visit' },
  { value: 'SITE', label: 'Site updates', typePrefix: 'progress' },
];

const SITE_ONLY_FILTERS: ReadonlySet<NotificationFilter> = new Set(['ALL', 'UNREAD']);

export function notificationFiltersForRole(
  role: Role | undefined,
): readonly NotificationFilterDef[] {
  if (!isSiteOnlyRole(role)) return NOTIFICATION_FILTERS;
  return NOTIFICATION_FILTERS.filter((f) => SITE_ONLY_FILTERS.has(f.value));
}

export function defaultNotificationFilter(_role: Role | undefined): NotificationFilter {
  return 'ALL';
}

export function notificationFilterDef(
  value: NotificationFilter,
): NotificationFilterDef | undefined {
  return NOTIFICATION_FILTERS.find((f) => f.value === value);
}

export type NotificationInboxCopy = {
  pageSubtitle: string;
  popoverTitle: string;
  emptyHintUnread: string;
  emptyHintNoRows: string;
  emptyHintFiltered: string;
};

const DEFAULT_COPY: NotificationInboxCopy = {
  pageSubtitle: 'In-app inbox. 90-day visibility.',
  popoverTitle: 'Notifications',
  emptyHintUnread: 'New leads, handoffs, and reminders land here automatically.',
  emptyHintNoRows: 'Trigger events will appear here as soon as they happen.',
  emptyHintFiltered: 'Try switching to the All tab.',
};

const SITE_ONLY_COPY: NotificationInboxCopy = {
  pageSubtitle: 'Site updates inbox. 90-day visibility.',
  popoverTitle: 'Site updates',
  emptyHintUnread: 'New site photos and villa assignments land here.',
  emptyHintNoRows: 'Site photos and villa assignments will appear here as they happen.',
  emptyHintFiltered: 'Try the All tab.',
};

export function notificationInboxCopy(role: Role | undefined): NotificationInboxCopy {
  return isSiteOnlyRole(role) ? SITE_ONLY_COPY : DEFAULT_COPY;
}
