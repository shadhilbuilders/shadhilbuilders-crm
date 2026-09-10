// T-BOOK - BookingsPage wire-shape contract (DataTable rebuild).
//
// Pins: rows render when useBookings resolves with the unwrapped row array;
// the retryable error state shows on error; the friendly empty state shows
// when the list resolves empty.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'proj-1' }),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useBookings: vi.fn(),
  useBookingsEnvelope: vi.fn(() => 0),
  useDeleteBooking: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useEditBooking: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('@paalstack/react-hooks', () => ({
  useDebouncedValue: (value: string) => [value, () => {}],
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u1', role: 'SALES_EXEC', name: 'Exec', email: 'e@x' },
    isPending: false,
  })),
  canApproveBookings: vi.fn((role: string | undefined) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
  ),
  isAdminLike: vi.fn((role: string | undefined) =>
    role === 'ADMIN' || role === 'OWNER',
  ),
}));

import BookingsPage from './page';
import { useBookings } from '@/hooks/queries/crm';

const mockedUseBookings = vi.mocked(useBookings);

afterEach(() => {
  vi.clearAllMocks();
});

describe('BookingsPage - wire-shape contract (T-BOOK)', () => {
  it('renders rows when useBookings resolves with the unwrapped row array', () => {
    mockedUseBookings.mockReturnValue({
      data: [
        {
          id: 'b-1',
          leadId: 'lead-1',
          leadName: 'Priya Sharma',
          unitId: 'unit-1',
          userId: 'u-1',
          userName: 'Sales Exec',
          amount: '7500000',
          tokenAmount: '500000',
          status: 'TOKEN',
          approvedById: null,
          approvedByName: null,
          createdAt: '2026-09-04T08:30:00Z',
          updatedAt: '2026-09-04T08:30:00Z',
        },
        {
          id: 'b-2',
          leadId: 'lead-2',
          leadName: 'Rajesh Kumar',
          unitId: 'unit-2',
          userId: 'u-2',
          userName: 'Sales Exec',
          amount: '4500000',
          tokenAmount: null,
          status: 'HOLD',
          approvedById: null,
          approvedByName: null,
          createdAt: '2026-09-03T15:42:00Z',
          updatedAt: '2026-09-03T15:42:00Z',
        },
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingsPage />);
    // Lead column links back to the parent lead
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('Rajesh Kumar');
    expect(html).toContain('href="/proj-1/leads/lead-1"');
    // Status badges via labelFor (NOT raw enum)
    expect(html).toContain('Token received');
    expect(html).toContain('On hold');
    expect(html).not.toContain('>TOKEN<');
    expect(html).not.toContain('>HOLD<');
    // Currency formatting (amount column)
    expect(html).toContain('₹75,00,000');
    expect(html).toContain('₹5,00,000');
    // Badge test ID
    expect(html).toMatch(/data-qa="booking-status-badge"/);
  });

  it('renders the retryable error state when the query has an error', () => {
    const apiError = new Error('API 500: Internal Server Error');
    mockedUseBookings.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<BookingsPage />);
    expect(html).toContain('Couldn&#x27;t load the bookings.');
    expect(html).toContain('API 500: Internal Server Error');
    expect(html).toMatch(/data-qa="bookings-retry-button"/);
    expect(html).not.toContain('No bookings yet');
  });

  it('renders the friendly empty state when the list resolves empty', () => {
    mockedUseBookings.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingsPage />);
    expect(html).toContain('No bookings yet.');
    expect(html).toMatch(/data-qa="bookings-empty"/);
  });
});
