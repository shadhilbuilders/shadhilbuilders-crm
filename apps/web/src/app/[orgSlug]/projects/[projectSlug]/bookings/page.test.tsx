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
  useParams: () => ({ orgId: 'org-1', projectId: 'proj-1' }),
  // T-BOOK-APPROVE: the page gained router.push for the "View details" row
  // action, so this mock must export useRouter or every render throws.
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

// Slug-based URL scheme: the page reads org/project SLUGS from the tenant
// context, not from useParams anymore.
vi.mock('@/lib/tenant-context', () => ({
  useOrg: () => ({ id: 'org-1', slug: 'org-1', name: 'Org 1' }),
  useProject: () => ({ id: 'proj-1', slug: 'proj-1', name: 'Proj 1' }),
  useOrgId: () => 'org-1',
  useProjectId: () => 'proj-1',
  useOrgSlug: () => 'org-1',
  useProjectSlug: () => 'proj-1',
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
  // T-BOOK-APPROVE: BookingApprovalDialog (mounted by this page) calls
  // useUpdateBooking. A partial mock here makes every page render throw
  // "No useUpdateBooking export is defined on the @/hooks/queries/crm mock".
  useUpdateBooking: vi.fn(() => ({
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
          unitNumber: 'A-101',
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
          unitNumber: 'B-201',
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
    // T-BOOK-LINK: Unit (first column) is the row's single clickable link and
    // opens the BOOKING. Lead is plain text (user direction).
    function tagAfter(marker: string): string {
      const at = html.indexOf(marker);
      if (at === -1) return '';
      const end = html.indexOf('>', at);
      return end === -1 ? html.slice(at) : html.slice(at, end + 1);
    }
    expect(tagAfter('data-qa="booking-unit-link"')).toContain(
      'href="/org-1/projects/proj-1/bookings/b-1"',
    );
    // The lead is NOT a link.
    expect(html).not.toContain('booking-lead-link');
    expect(html).not.toContain('href="/org-1/projects/proj-1/leads/lead-1"');
    expect(html).toMatch(/data-qa="booking-lead">Priya Sharma</);
    expect(html).toContain('Rajesh Kumar');
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

  // T-BOOK-LINK: Unit leads the column order (it is the booking's natural key).
  it('renders Unit before Lead', () => {
    mockedUseBookings.mockReturnValue({
      data: [
        {
          id: 'b-1',
          leadId: 'lead-1',
          leadName: 'Priya Sharma',
          unitId: 'unit-1',
          unitNumber: 'A-101',
          userName: 'Sales Exec',
          amount: '7500000',
          tokenAmount: '500000',
          status: 'TOKEN',
          approvedByName: null,
          createdAt: '2026-09-04T08:30:00Z',
          updatedAt: '2026-09-04T08:30:00Z',
        },
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingsPage />);
    const unitIdx = html.indexOf('>Unit<');
    const leadIdx = html.indexOf('>Lead<');
    expect(unitIdx).toBeGreaterThan(-1);
    expect(leadIdx).toBeGreaterThan(-1);
    expect(unitIdx).toBeLessThan(leadIdx);
  });

  // T-BOOK-APPROVE + T-BOOK-UNIT: the row exposes the unit no, and the Actions
  // menu is where the manager decision now lives.
  //
  // The "Awaiting approval" hint and the Approve/Reject item are gated on
  // `canApprove = mounted && canApproveBookings(...)`, and `mounted` flips only
  // in useEffect - which never runs under renderToStaticMarkup. So this test
  // pins what SSR can show (unit no + the actions trigger); the approval
  // gating itself is covered by booking-roles.test.ts and
  // BookingApprovalDialog.test.tsx.
  it('shows the unit number and a row-actions trigger', () => {
    mockedUseBookings.mockReturnValue({
      data: [
        {
          id: 'b-1',
          leadId: 'lead-1',
          leadName: 'Priya Sharma',
          unitId: 'unit-1',
          unitNumber: 'A-101',
          userName: 'Sales Exec',
          amount: '7500000',
          tokenAmount: '500000',
          status: 'TOKEN',
          approvedByName: null,
          createdAt: '2026-09-04T08:30:00Z',
          updatedAt: '2026-09-04T08:30:00Z',
        },
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingsPage />);
    // The Unit column is first and its cell is now a LINK to the booking.
    expect(html).toMatch(/data-qa="booking-unit-link"[^>]*>A-101</);
    // Row actions menu is present (View lead / Edit / Delete, + Approve for
    // a manager on a TOKEN row).
    expect(html).toMatch(/data-qa="data-table-row-actions-button"/);
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
