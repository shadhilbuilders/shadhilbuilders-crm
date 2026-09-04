// T-F3 — AuditPage wire-shape contract.
//
// Pins: rows render when useAuditLog resolves with { rows, total };
// ModulePending surfaces on error; the friendly empty state shows
// when the list resolves empty. Admin gate (canViewAudit) is
// exercised via a mocked useSessionUser.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useAuditLog: vi.fn(),
}));

vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({ user: { id: 'u1', role: 'ADMIN', name: 'Owner', email: 'owner@x' }, isPending: false })),
  canViewAudit: vi.fn((role: string | undefined) => role === 'ADMIN' || role === 'OWNER'),
}));

import AuditPage from './page';
import { useAuditLog } from '@/hooks/queries/crm';

const mockedUseAuditLog = vi.mocked(useAuditLog);

afterEach(() => {
  vi.clearAllMocks();
});

describe('AuditPage — wire-shape contract (T-F3)', () => {
  it('renders rows when useAuditLog resolves with {rows, total}', () => {
    mockedUseAuditLog.mockReturnValue({
      data: {
        rows: [
          {
            id: 'a-1',
            userId: 'u1',
            userName: 'Owner',
            action: 'lead.transition',
            entityType: 'Lead',
            entityId: 'lead-123',
            before: { state: 'NEW' },
            after: { state: 'CONTACTED' },
            reason: 'Initial outreach call',
            createdAt: '2026-09-04T08:30:00Z',
          },
          {
            id: 'a-2',
            userId: 'u2',
            userName: 'Manager',
            action: 'booking.approve',
            entityType: 'Booking',
            entityId: 'book-456',
            before: { status: 'TOKEN' },
            after: { status: 'APPROVED' },
            reason: 'Token received + manager approval',
            createdAt: '2026-09-03T15:42:00Z',
          },
        ],
        total: 2,
      },
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<AuditPage />);
    // Action column entries render
    expect(html).toContain('lead.transition');
    expect(html).toContain('booking.approve');
    // User column shows userName (priority over userId)
    expect(html).toContain('Owner');
    expect(html).toContain('Manager');
    // Entity column
    expect(html).toContain('Lead');
    expect(html).toContain('Booking');
    // Before → After column renders the transition summary.
    // react-dom/server escapes the JSON quotes to &quot; on output, so
    // we match on the rendered, HTML-encoded form rather than the raw JSON.
    expect(html).toMatch(/(state|status).*NEW/);
    expect(html).toMatch(/(state|status).*CONTACTED/);
  });

  it('renders ModulePending when the query has an error', () => {
    const apiError = new Error('API 500: Internal Server Error');
    mockedUseAuditLog.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<AuditPage />);
    expect(html).toContain('failed to load');
    expect(html).toContain('API 500: Internal Server Error');
    expect(html).not.toContain('No audit entries yet');
  });

  it('renders the friendly empty state when the list resolves with zero rows', () => {
    mockedUseAuditLog.mockReturnValue({
      data: { rows: [], total: 0 },
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<AuditPage />);
    expect(html).toContain('No audit entries yet.');
    expect(html).toMatch(/data-qa="audit-empty"/);
  });
});