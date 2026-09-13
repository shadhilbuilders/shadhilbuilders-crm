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

// ────────────────────────────────────────────────────────────────────────────
// T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI6) - batch grouping
// ────────────────────────────────────────────────────────────────────────────
describe('AuditPage - removal batch grouping (UI6)', () => {
  const batchId = 'batch_123_abc';
  const anchorRow = {
    id: 'audit-anchor',
    userId: 'admin-1',
    userName: 'Admin',
    action: 'team.member.remove',
    entityType: 'Team',
    entityId: 'team-a',
    before: { userId: 'tc-1', teamId: 'team-a' },
    after: {
      removedUserId: 'tc-1',
      removedUserName: 'Priya Sharma',
      teamId: 'team-a',
      teamName: 'Metro Sales',
      replacementUserId: 'tc-2',
      replacementName: 'Rahul Verma',
      transferredLeadCount: 2,
    },
    reason: 'leaving the team',
    createdAt: '2026-09-13T08:00:00Z',
    batchId,
  };
  const detailRow1 = {
    id: 'audit-detail-1',
    userId: 'admin-1',
    userName: 'Admin',
    action: 'lead.ownership_transfer',
    entityType: 'Lead',
    entityId: 'lead-1',
    before: { ownerId: 'tc-1', coOwnerId: null },
    after: { ownerId: 'tc-2', coOwnerId: null },
    reason: null,
    createdAt: '2026-09-13T08:00:00Z',
    batchId,
  };
  const detailRow2 = {
    id: 'audit-detail-2',
    userId: 'admin-1',
    userName: 'Admin',
    action: 'lead.ownership_transfer',
    entityType: 'Lead',
    entityId: 'lead-2',
    before: { ownerId: 'tc-1', coOwnerId: null },
    after: { ownerId: 'tc-2', coOwnerId: null },
    reason: null,
    createdAt: '2026-09-13T08:00:00Z',
    batchId,
  };

  it('shows the batch summary line instead of raw ids, and hides detail rows until expanded', async () => {
    mockedUseAuditLog.mockReturnValue({
      data: { rows: [anchorRow, detailRow1, detailRow2], total: 3 },
      isLoading: false,
      error: null,
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Priya Sharma removed from Metro Sales · 2 leads transferred to Rahul Verma');
    // Detail rows are collapsed by default.
    expect(container?.querySelector('[data-qa="audit-batch-toggle-batch_123_abc"]')).not.toBeNull();
    const detailAppearances = (html.match(/lead-1/g) ?? []).length;
    // entityId "lead-1" should not appear in the collapsed table body at all
    // (the detail row rendering the "Lead · lead-1" entity text is hidden).
    expect(detailAppearances).toBe(0);
  });

  it('non-batched rows render exactly as before (no toggle, plain Before -> After)', async () => {
    mockedUseAuditLog.mockReturnValue({
      data: {
        rows: [
          {
            id: 'a-plain',
            userId: 'u1',
            userName: 'Owner',
            action: 'lead.transition',
            entityType: 'Lead',
            entityId: 'lead-999',
            before: { state: 'NEW' },
            after: { state: 'CONTACTED' },
            reason: 'call',
            createdAt: '2026-09-04T08:30:00Z',
            batchId: null,
          },
        ],
        total: 1,
      },
      isLoading: false,
      error: null,
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Lead transition');
    expect(html).toMatch(/(state).*NEW/);
    expect(container?.querySelector('[data-qa^="audit-batch-toggle-"]')).toBeNull();
  });
});
