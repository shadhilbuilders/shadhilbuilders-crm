// protects= a site engineer's inbox shows All + Unread only and speaks site
// language; fails_when= Leads/Bookings/Visits tabs or lead copy reach an
// ENGINEER, or another role loses a tab.
import { describe, expect, it } from 'vitest';

import {
  defaultNotificationFilter,
  notificationFiltersForRole,
  notificationInboxCopy,
} from './notification-inbox';

const OTHER_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER', 'CUSTOMER'] as const;

describe('notificationFiltersForRole', () => {
  it('gives an ENGINEER exactly All then Unread', () => {
    expect(notificationFiltersForRole('ENGINEER').map((f) => f.value)).toEqual(['ALL', 'UNREAD']);
  });

  it('gives every other role (and undefined) all six tabs', () => {
    for (const role of [...OTHER_ROLES, undefined]) {
      expect(notificationFiltersForRole(role).map((f) => f.value)).toEqual([
        'ALL',
        'UNREAD',
        'LEADS',
        'BOOKINGS',
        'VISITS',
        'SITE',
      ]);
    }
  });

  it('sends no type prefix on the engineer tabs (the API clamp scopes them)', () => {
    for (const f of notificationFiltersForRole('ENGINEER')) {
      expect(f.typePrefix).toBeUndefined();
    }
  });
});

describe('defaultNotificationFilter', () => {
  it('is ALL for every role', () => {
    for (const role of ['ENGINEER', ...OTHER_ROLES, undefined] as const) {
      expect(defaultNotificationFilter(role)).toBe('ALL');
    }
  });
});

describe('notificationInboxCopy', () => {
  it('uses site wording with no lead vocabulary for an ENGINEER', () => {
    const copy = notificationInboxCopy('ENGINEER');
    expect(copy.popoverTitle).toBe('Site updates');
    const all = Object.values(copy).join(' ').toLowerCase();
    for (const word of ['lead', 'handoff', 'booking', 'visit', 'reminder', 'trigger']) {
      expect(all).not.toContain(word);
    }
  });

  it('keeps the original wording for every other role', () => {
    for (const role of [...OTHER_ROLES, undefined]) {
      const copy = notificationInboxCopy(role);
      expect(copy.popoverTitle).toBe('Notifications');
      expect(copy.emptyHintUnread).toBe(
        'New leads, handoffs, and reminders land here automatically.',
      );
      expect(copy.emptyHintFiltered).toBe('Try switching to the All tab.');
    }
  });
});
