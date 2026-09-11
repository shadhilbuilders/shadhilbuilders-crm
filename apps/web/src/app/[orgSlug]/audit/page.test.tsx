// T-F3 - AuditPage wire-shape contract.
//
// Pins: rows render when useAuditLog resolves with { rows, total };
// ModulePending surfaces on error; the friendly empty state shows
// when the list resolves empty. Admin gate (canViewAudit) is
// exercised via a mocked useSessionUser.
//
// The page has a `mounted` gate (`if (!mounted || sessionPending) return
// <Skeleton/>`) where `mounted` flips true only in `useEffect`. Under
// `renderToStaticMarkup` effects never run, so `mounted` stays false and the
// page renders Skeleton for every test. Fix: MOUNT the page with
// `createRoot` + `act` (which runs effects) - the same pattern as
// `use-nav-sync.test.tsx` and the users page test. This keeps the page code
// unchanged and tests the real render path.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `globalThis.IS_REACT_ACT_ENVIRONMENT` tells React this is a test env so
// `act` works with a raw createRoot (no @testing-library/react in this app).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock('@/hooks/queries/crm', () => ({
  useAuditLog: vi.fn(),
  useAuditLogRealtime: vi.fn(),
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AuditPage />);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('AuditPage - wire-shape contract (T-F3)', () => {
  it('renders rows when useAuditLog resolves with {rows, total}', async () => {
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
            action: 'booking.transition',
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

    await mount();
    const html = container?.innerHTML ?? '';
    // Action column entries render (friendly labels, not raw action keys)
    expect(html).toContain('Lead transition');
    expect(html).toContain('Booking transition');
    // User column shows userName (priority over userId)
    expect(html).toContain('Owner');
    expect(html).toContain('Manager');
    // Entity column
    expect(html).toContain('Lead');
    expect(html).toContain('Booking');
    // Before → After column renders the transition summary.
    expect(html).toMatch(/(state|status).*NEW/);
    expect(html).toMatch(/(state|status).*CONTACTED/);
  });

  it('renders ModulePending when the query has an error', async () => {
    const apiError = new Error('API 500: Internal Server Error');
    mockedUseAuditLog.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('failed to load');
    expect(html).toContain('API 500: Internal Server Error');
    expect(html).not.toContain('No audit entries yet');
  });

  it('renders the friendly empty state when the list resolves with zero rows', async () => {
    mockedUseAuditLog.mockReturnValue({
      data: { rows: [], total: 0 },
      isLoading: false,
      error: null,
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('No audit entries yet.');
    expect(html).toMatch(/data-qa="audit-empty"/);
  });
});
