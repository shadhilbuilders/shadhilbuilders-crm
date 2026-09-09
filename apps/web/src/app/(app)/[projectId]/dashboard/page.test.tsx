// Project dashboard page test - real-data wiring (autoplan 2026-09-08).
//
// Pins: real KPI values render from useDashboardStats (not placeholders),
// and the new charts receive the aggregate data.
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

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({ user: { name: 'Demo Manager', role: 'MANAGER' }, isPending: false })),
  isAdminLike: vi.fn((role: string) => role === 'ADMIN' || role === 'OWNER'),
}));

vi.mock('@/hooks/queries/dashboard', () => ({
  useDashboardStats: vi.fn(),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useLeads: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useVisits: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useBookings: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}));

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ projectId: 'proj-metro' })),
}));

import DashboardPage from './page';
import { useDashboardStats } from '@/hooks/queries/dashboard';

const mockedUseDashboardStats = vi.mocked(useDashboardStats);

const STATS = {
  kpis: {
    newLeadsToday: 5,
    overdueLeads: 2,
    visitsToday: 3,
    visitsThisWeek: 12,
    bookingsOnHold: 1,
    noShowRate: 0,
    avgTimeToFirstTouch: null,
  },
  pipeline: [
    { status: 'NEW', count: 3 },
    { status: 'WON', count: 1 },
  ],
  leadsOverTime: [
    { date: '2026-09-07', count: 5 },
    { date: '2026-09-08', count: 2 },
  ],
  leadSources: [{ source: 'META_AD', count: 4 }],
  teamPerformance: [{ ownerId: 'o-1', ownerName: 'Priya', count: 4 }],
  visitsThisWeek: [
    { day: 'Mon', count: 1 },
    { day: 'Tue', count: 2 },
  ],
  bookingsByStatus: [{ status: 'HOLD', count: 1 }],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DashboardPage />);
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

describe('DashboardPage - real-data wiring (autoplan 2026-09-08)', () => {
  it('renders real KPI values (not placeholders) for a MANAGER', async () => {
    mockedUseDashboardStats.mockReturnValue({
      data: STATS,
      isLoading: false,
      error: null,
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    // Real KPI numbers render.
    expect(html).toContain('New leads today');
    expect(html).toContain('5');
    expect(html).toContain('Overdue leads');
    expect(html).toContain('2');
    // Apostrophe is a literal character in a real DOM mount (createRoot+act),
    // unlike renderToStaticMarkup which HTML-escapes it to &#x27;.
    expect(html).toContain("Today's visits");
    expect(html).toContain('3');
    expect(html).toContain('Bookings on hold');
    expect(html).toContain('1');
    // New chart titles render.
    expect(html).toContain('Leads over time');
    expect(html).toContain('Lead sources');
    expect(html).toContain('Team performance');
    // The conversion funnel was removed (redundant with the pipeline funnel).
    expect(html).not.toContain('Conversion funnel');
  });

  it('shows a KPI skeleton while stats are loading', async () => {
    mockedUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    // The KPI strip is replaced by a shape-matched skeleton while loading.
    expect(html).toContain('data-skeleton-variant="kpi"');
    expect(html).toContain('aria-label="Loading kpi"');
  });

  it('shows an error banner when the stats query fails', async () => {
    mockedUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('API 500: Internal Server Error'),
    } as never);

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Dashboard data unavailable');
    expect(html).toContain('API 500: Internal Server Error');
  });
});
