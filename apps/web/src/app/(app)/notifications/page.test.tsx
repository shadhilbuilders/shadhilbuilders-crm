// T-F2 - NotificationsPage wire-shape contract.
//
// Pins the three required behaviors: rows render when useNotifications
// resolves with { rows, unread, total }; ModulePending shows on error;
// the friendly empty state shows when the list resolves empty.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react). The hook layer is mocked via vi.mock so the
// page renders with deterministic data.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useNotifications: vi.fn(),
  useNotificationsRealtime: vi.fn(),
  useMarkNotificationsRead: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('@/hooks/use-session-user-stub-not-used', () => ({}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({ user: null, isPending: false })),
}));

import NotificationsPage from './page';
import { useNotifications } from '@/hooks/queries/crm';

const mockedUseNotifications = vi.mocked(useNotifications);

afterEach(() => {
  vi.clearAllMocks();
});

describe('NotificationsPage - wire-shape contract (T-F2)', () => {
  it('renders rows when useNotifications resolves with {rows, unread, total}', () => {
    mockedUseNotifications.mockReturnValue({
      data: {
        rows: [
          {
            id: 'n-1',
            title: 'New lead assigned',
            body: 'Rajesh Kumar - VISIT_REQUESTED',
            read: false,
            createdAt: '2026-09-04T08:30:00Z',
            type: 'lead.assigned',
          },
          {
            id: 'n-2',
            title: 'Visit confirmed',
            body: 'Priya Sharma booked a visit for Saturday',
            read: true,
            createdAt: '2026-09-03T15:42:00Z',
            type: 'visit.scheduled',
          },
        ],
        total: 2,
        unread: 1,
      },
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<NotificationsPage />);
    // Row content
    expect(html).toContain('New lead assigned');
    expect(html).toContain('Rajesh Kumar - VISIT_REQUESTED');
    expect(html).toContain('Visit confirmed');
    expect(html).toContain('Priya Sharma booked a visit for Saturday');
    // Unread count surfaced on the "Mark all as read" CTA
    expect(html).toContain('Mark all as read');
    expect(html).toContain('(1)');
    // Read vs unread markers
    expect(html).toContain('●');
    expect(html).toContain('○');
    // Test IDs
    expect(html).toMatch(/data-qa="notification-row"/);
  });

  it('renders ModulePending when the query has an error (honest-state contract)', () => {
    const apiError = new Error('API 500: Internal Server Error');
    mockedUseNotifications.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<NotificationsPage />);
    // ModulePending surfaces the error message via its "failed to load"
    // branch. The page title is "Notification Center" - the empty-state
    // shell we control does NOT appear because the error path owns it.
    expect(html).toContain('failed to load');
    expect(html).toContain('API 500: Internal Server Error');
    expect(html).not.toContain('No notifications yet');
  });

  it('renders the friendly empty state when the list resolves with zero rows on ALL', () => {
    mockedUseNotifications.mockReturnValue({
      data: { rows: [], total: 0, unread: 0 },
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain('No notifications yet.');
    expect(html).toContain('Trigger events will appear here');
    expect(html).toMatch(/data-qa="notifications-empty"/);
    // The disabled "Mark all as read" must NOT show a number when unread=0
    expect(html).toContain('Mark all as read');
    expect(html).not.toMatch(/Mark all as read \(\d+\)/);
  });
});