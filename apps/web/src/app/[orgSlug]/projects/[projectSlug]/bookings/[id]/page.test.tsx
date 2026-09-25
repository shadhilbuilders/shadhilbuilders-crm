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
    user: { id: 'u1', role: 'ADMIN', name: 'Admin', email: 'a@x' },
    isPending: false,
  })),
  // Mirrors the REAL helpers so the page's gating is actually exercised.
  // MANAGER was revoked from approval 2026-09-24; keeping it in this mock would
  // hide a regression in the page's use of the helper.
  canApproveBookings: vi.fn((role: string | undefined) => role === 'ADMIN' || role === 'OWNER'),
  // T-BOOK-ROLES: mirrors the real helper (DESIGN.md §4 "Initiate booking").
  // A partial mock here would make `canInitiate` undefined and silently drop
  // the TOKEN action from every case.
  canInitiateBookings: vi.fn((role: string | undefined) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER' || role === 'SALES_EXEC',
  ),
}));

import BookingDetailPage from './page';
import { useBooking } from '@/hooks/queries/crm';
import { useSessionUser } from '@/lib/session';

const mockedUseBooking = vi.mocked(useBooking);

const DEFAULT_USER = { id: 'u1', role: 'ADMIN', name: 'Admin', email: 'a@x' };

afterEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls but NOT implementations, so a test that swapped
  // the session role (e.g. the MANAGER approval-hiding cases) would otherwise
  // leak into every later test in this file. Restore the default explicitly.
  vi.mocked(useSessionUser).mockReturnValue({
    user: DEFAULT_USER,
    isPending: false,
  } as never);
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

  // T-BOOK-LINK: the unit identifies a booking, so the crumb and title are
  // unit-led with the lead name as the qualifier: "A-101 (Priya Sharma)".
  it('labels the breadcrumb + title with the unit, lead name in parentheses', () => {
    mockedUseBooking.mockReturnValue({
      data: {
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
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingDetailPage />);
    expect(html).toContain('A-101 (Priya Sharma)');
    expect(html).toContain('Unit A-101');
    // The lead is still shown - as its own labelled row in the info card.
    expect(html).toContain('Lead');
    expect(html).toContain('Priya Sharma');
  });

  it('falls back to the lead name when the unit number is absent', () => {
    mockedUseBooking.mockReturnValue({
      data: {
        id: 'b-1',
        leadId: 'lead-1',
        leadName: 'Priya Sharma',
        unitId: 'unit-1',
        userId: 'u-1',
        userName: 'Sales Exec',
        amount: '7500000',
        tokenAmount: null,
        status: 'HOLD',
        approvedById: null,
        approvedByName: null,
        createdAt: '2026-09-04T08:30:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingDetailPage />);
    // No trailing "undefined"/"()" leakage when the unit is missing.
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('()');
    expect(html).toContain('Priya Sharma');
  });

  it('offers APPROVED/REJECTED/CANCELLED for a TOKEN booking to an admin', () => {
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

  // ── Approval is ADMIN/OWNER only (owner decision, 2026-09-24) ────────────
  // The Actions card must hide the approval controls from a MANAGER while
  // keeping the non-approval actions that role still legitimately holds. This is
  // the "hide from non-admin members" requirement, pinned at the UI layer.
  it('a MANAGER sees no Approve/Reject on a TOKEN booking, but keeps Cancel', () => {
    vi.mocked(useSessionUser).mockReturnValue({
      user: { id: 'u1', role: 'MANAGER', name: 'Mgr', email: 'm@x' },
      isPending: false,
    } as never);
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
    // The approval decision is NOT offered.
    expect(html).not.toMatch(/data-qa="booking-to-APPROVED"/);
    expect(html).not.toMatch(/data-qa="booking-to-REJECTED"/);
    // Cancel is not an approval and must survive (the owner scoped the hide to
    // approval controls only - hiding the whole card would strand Cancel).
    expect(html).toMatch(/data-qa="booking-to-CANCELLED"/);
  });

  it('a MANAGER still sees the initiate (HOLD → TOKEN) action', () => {
    vi.mocked(useSessionUser).mockReturnValue({
      user: { id: 'u1', role: 'MANAGER', name: 'Mgr', email: 'm@x' },
      isPending: false,
    } as never);
    mockedUseBooking.mockReturnValue({
      data: {
        id: 'b-1',
        leadId: 'lead-1',
        leadName: 'Priya Sharma',
        unitId: 'unit-1',
        userId: 'u-1',
        userName: 'Sales Exec',
        amount: '7500000',
        tokenAmount: null,
        status: 'HOLD',
        approvedById: null,
        approvedByName: null,
        createdAt: '2026-09-04T08:30:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<BookingDetailPage />);
    expect(html).toMatch(/data-qa="booking-to-TOKEN"/);
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

// Action-button icons (user request 2026-09-15). Every non-approval transition
// used to share one generic arrow glyph, so "Token received" and "Cancelled"
// looked identical and the destructive action carried no visual warning.
// These pin that each offered action has its OWN icon.
describe('BookingDetailPage - action button icons', () => {
  /** Render the detail page with a booking in `status`, as a manager. */
  function renderFor(status: string) {
    mockedUseBooking.mockReturnValue({
      data: {
        id: 'b-1',
        leadId: 'lead-1',
        leadName: 'Priya Sharma',
        unitId: 'unit-1',
        unitNumber: 'A-101',
        userId: 'u-1',
        userName: 'Sales Exec',
        amount: '7500000',
        tokenAmount: '500000',
        status,
        approvedById: null,
        approvedByName: null,
        createdAt: '2026-09-04T08:30:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
      isLoading: false,
      error: null,
    } as never);
    return renderToStaticMarkup(<BookingDetailPage />);
  }

  /** The inner markup of the button carrying `qa`, or '' when absent. */
  function buttonMarkup(html: string, qa: string): string {
    const at = html.indexOf(`data-qa="${qa}"`);
    if (at === -1) return '';
    // Walk back to the opening tag, then forward past its close.
    const start = html.lastIndexOf('<', at);
    const end = html.indexOf('</button>', at);
    return html.slice(start, end === -1 ? html.length : end);
  }

  it('HOLD offers token-payment and cancel, each with its own icon', () => {
    const html = renderFor('HOLD');
    const token = buttonMarkup(html, 'booking-to-TOKEN');
    const cancel = buttonMarkup(html, 'booking-to-CANCELLED');
    expect(token).toContain('<svg');
    expect(cancel).toContain('<svg');
    // Distinct glyphs - the whole point of the change.
    expect(token).not.toBe(cancel);
  });

  it('CANCELLED does not reuse the token icon', () => {
    const html = renderFor('HOLD');
    const tokenSvg = /<svg[^>]*>.*?<\/svg>/.exec(buttonMarkup(html, 'booking-to-TOKEN'))?.[0];
    const cancelSvg = /<svg[^>]*>.*?<\/svg>/.exec(buttonMarkup(html, 'booking-to-CANCELLED'))?.[0];
    expect(tokenSvg).toBeTruthy();
    expect(cancelSvg).toBeTruthy();
    expect(tokenSvg).not.toBe(cancelSvg);
  });

  it('the approve button carries an icon', () => {
    const html = renderFor('TOKEN');
    expect(buttonMarkup(html, 'booking-to-APPROVED')).toContain('<svg');
  });

  it('icons are decorative - aria-hidden, never the accessible name', () => {
    const html = renderFor('TOKEN');
    for (const qa of ['booking-to-APPROVED', 'booking-to-REJECTED', 'booking-to-CANCELLED']) {
      const markup = buttonMarkup(html, qa);
      expect(markup).toContain('aria-hidden="true"');
      // The label must still be real text, not an icon-only button.
      expect(markup).toMatch(/>\s*(Approve|Reject|Cancel)[^<]*/);
    }
  });

  it('no action button falls back to a bare text arrow', () => {
    const html = renderFor('HOLD');
    expect(buttonMarkup(html, 'booking-to-TOKEN')).not.toContain('→');
    expect(buttonMarkup(html, 'booking-to-CANCELLED')).not.toContain('→');
  });

  it('the back action uses an icon instead of a text arrow', () => {
    const html = renderFor('HOLD');
    const at = html.indexOf('Back to bookings');
    const start = html.lastIndexOf('<button', at);
    const markup = html.slice(start, at);
    expect(markup).toContain('<svg');
    expect(markup).not.toContain('←');
  });

  // HOLD is created, never transitioned into: the backend's legalNextStates()
  // returns it as a target from no state at all. So it must have no action icon
  // - a map key nothing can ever reach is dead code that reads like a feature.
  it('HOLD is not offered as a transition target from any state', () => {
    for (const from of ['HOLD', 'TOKEN', 'APPROVED', 'REJECTED', 'CANCELLED']) {
      const html = renderFor(from);
      expect(buttonMarkup(html, 'booking-to-HOLD')).toBe('');
    }
  });
});

// T-BOOK-REASON: the reason input is now a props-API <Form> field (zod-driven)
// rather than a hand-rolled <Textarea> + useState, so the confirm button submits
// THROUGH the form and the resolver decides whether a move is allowed.
describe('BookingDetailPage - transition form wiring', () => {
  function renderFor(status: string) {
    mockedUseBooking.mockReturnValue({
      data: {
        id: 'b-1',
        leadId: 'lead-1',
        leadName: 'Priya Sharma',
        unitId: 'unit-1',
        unitNumber: 'A-101',
        userId: 'u-1',
        userName: 'Sales Exec',
        amount: '7500000',
        tokenAmount: '500000',
        status,
        approvedById: null,
        approvedByName: null,
        createdAt: '2026-09-04T08:30:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
      isLoading: false,
      error: null,
    } as never);
    return renderToStaticMarkup(<BookingDetailPage />);
  }

  /** The full <button> element carrying `qa`. Attribute order is NOT assumed. */
  function buttonFor(html: string, qa: string): string {
    const at = html.indexOf(`data-qa="${qa}"`);
    if (at === -1) return '';
    const start = html.lastIndexOf('<button', at);
    const end = html.indexOf('</button>', at);
    return start === -1 || end === -1 ? '' : html.slice(start, end);
  }

  it('the offered transition buttons are type=button, never accidental submits', () => {
    const html = renderFor('HOLD');
    for (const target of ['TOKEN', 'CANCELLED']) {
      const btn = buttonFor(html, `booking-to-${target}`);
      expect(btn, `${target} button missing`).not.toBe('');
      expect(btn).toContain('type="button"');
      // No form association on the chooser - it only opens the confirm step.
      expect(btn).not.toContain('type="submit"');
    }
  });
});
