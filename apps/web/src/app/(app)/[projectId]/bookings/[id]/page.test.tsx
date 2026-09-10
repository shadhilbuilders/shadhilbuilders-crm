// T-BOOK - BookingDetailPage wire-shape contract.
//
// Pins: the single-booking fetch renders the info card + status badge;
// the actions card offers legal next states (TOKEN → APPROVED/REJECTED/
// CANCELLED for a manager); ModulePending surfaces on error.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'proj-1', id: 'b-1' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useBooking: vi.fn(),
  useUpdateBooking: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u1', role: 'MANAGER', name: 'Mgr', email: 'm@x' },
    isPending: false,
  })),
  canApproveBookings: vi.fn((role: string | undefined) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
  ),
}));

import BookingDetailPage from './page';
import { useBooking } from '@/hooks/queries/crm';

const mockedUseBooking = vi.mocked(useBooking);

afterEach(() => {
  vi.clearAllMocks();
});

describe('BookingDetailPage - wire-shape contract (T-BOOK)', () => {
  it('renders the info card + status badge when the booking resolves', () => {
    mockedUseBooking.mockReturnValue({
      data: {
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
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingDetailPage />);
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('Token received');
    expect(html).toMatch(/data-qa="booking-info-card"/);
    expect(html).toMatch(/data-qa="booking-status-badge"/);
    // Currency formatting
    expect(html).toContain('₹75,00,000');
    expect(html).toContain('₹5,00,000');
  });

  it('offers APPROVED/REJECTED/CANCELLED for a TOKEN booking to a manager', () => {
    mockedUseBooking.mockReturnValue({
      data: {
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
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingDetailPage />);
    expect(html).toMatch(/data-qa="booking-to-APPROVED"/);
    expect(html).toMatch(/data-qa="booking-to-REJECTED"/);
    expect(html).toMatch(/data-qa="booking-to-CANCELLED"/);
  });

  it('renders ModulePending when the query has an error', () => {
    const apiError = new Error('API 404: Not Found');
    mockedUseBooking.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<BookingDetailPage />);
    expect(html).toContain('failed to load');
    expect(html).toContain('API 404: Not Found');
  });
});
