// protects= notification rows link to where the reader can act (2026-11-10);
// fails_when= a row with no anchor becomes a dead link, an unassigned engineer is
// sent to a villa page they lost, or "Mark as read" ends up nested in the link.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useNotifications: vi.fn(),
  useNotificationsRealtime: vi.fn(),
  useMarkNotificationsRead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: vi.fn(() => true) }));
vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({ user: { role: 'ENGINEER' }, isPending: false })),
  isSiteOnlyRole: (role: string | undefined) => role === 'ENGINEER',
}));
vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil',
  useProjectSlug: () => 'metro',
  useProjectId: () => 'proj-1',
}));

import NotificationsPage from './page';
import { useNotifications } from '@/hooks/queries/crm';

const mocked = vi.mocked(useNotifications);
const rowsOf = (rows: unknown[], unread = 1) =>
  mocked.mockReturnValue({ data: { rows, total: rows.length, unread }, isLoading: false, error: null } as never);

afterEach(() => vi.clearAllMocks());

describe('NotificationsPage links', () => {
  it('links a progress.assigned row to the villa page', () => {
    rowsOf([{ id: 'n1', type: 'progress.assigned', title: 'A-101 assigned to you', body: 'b', unitId: 'u1', read: false, createdAt: '2026-11-10T00:00:00Z' }]);
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain('href="/shadhil/projects/metro/site/u1"');
    expect(html).toContain('Villa assigned');
  });

  it('sends progress.unassigned to the site home', () => {
    rowsOf([{ id: 'n2', type: 'progress.unassigned', title: 'A-102 reassigned', body: 'b', unitId: 'u2', read: true, createdAt: '2026-11-10T00:00:00Z' }]);
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain('href="/shadhil/projects/metro/site"');
    expect(html).not.toContain('/site/u2');
  });

  it('keeps a row with neither lead nor unit as plain text', () => {
    rowsOf([{ id: 'n3', type: 'system', title: 'Plain row', body: 'b', read: true, createdAt: '2026-11-10T00:00:00Z' }]);
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain('Plain row');
    expect(html).not.toContain('data-qa="notification-link"');
  });

  it('renders Mark as read beside the link, not inside it', () => {
    rowsOf([{ id: 'n4', type: 'progress.assigned', title: 'T', body: 'b', unitId: 'u1', read: false, createdAt: '2026-11-10T00:00:00Z' }]);
    const html = renderToStaticMarkup(<NotificationsPage />);
    const anchor = html.slice(html.indexOf('data-qa="notification-link"'));
    const anchorBody = anchor.slice(0, anchor.indexOf('</a>'));
    expect(anchorBody).not.toContain('Mark as read');
    expect(html).toContain('Mark as read');
  });

  it('shows the empty state when there are no rows', () => {
    rowsOf([], 0);
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain('No notifications yet.');
  });
});
