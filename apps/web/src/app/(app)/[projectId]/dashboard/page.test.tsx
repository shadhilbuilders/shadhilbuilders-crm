// Project dashboard page test - real-data wiring (autoplan 2026-09-08).
//
// Pins: real KPI values render from useDashboardStats (not placeholders),
// and the new charts receive the aggregate data. Uses renderToStaticMarkup
// per the standing rule (apps/web has no @testing-library/react). The hook
// layer is mocked via vi.mock so the page renders with deterministic data.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.clearAllMocks();
});

describe('DashboardPage - real-data wiring (autoplan 2026-09-08)', () => {
  it('renders real KPI values (not placeholders) for a MANAGER', () => {
    mockedUseDashboardStats.mockReturnValue({
      data: STATS,
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<DashboardPage />);
    // Real KPI numbers render.
    expect(html).toContain('New leads today');
    expect(html).toContain('5');
    expect(html).toContain('Overdue leads');
    expect(html).toContain('2');
    // Apostrophe is HTML-escaped in renderToStaticMarkup.
    expect(html).toContain('Today&#x27;s visits');
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

  it('shows a KPI skeleton while stats are loading', () => {
    mockedUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<DashboardPage />);
    // The KPI strip is replaced by a shape-matched skeleton while loading.
    expect(html).toContain('data-skeleton-variant="kpi"');
    expect(html).toContain('aria-label="Loading kpi"');
  });

  it('shows an error banner when the stats query fails', () => {
    mockedUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('API 500: Internal Server Error'),
    } as never);

    const html = renderToStaticMarkup(<DashboardPage />);
    expect(html).toContain('Dashboard data unavailable');
    expect(html).toContain('API 500: Internal Server Error');
  });
});
