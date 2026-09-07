// T-D3 - Lead Inbox (state matrix).
//
// Pins the three render branches in apps/web/src/app/(app)/leads/page.tsx:
//
//   1. isLoading === true         → <Skeleton variant="table" />
//   2. data is an array (any size) → <LeadTable />  (partial + empty both land here;
//                                                the table itself renders the
//                                                "No leads match these filters." panel
//                                                when rows.length === 0)
//   3. data is undefined + error   → <ModulePending error={...} />
//
// The page does NOT distinguish "error" from "module not shipped" -
// both fall to ModulePending. That matches the project-wide convention
// in components/shared/ModulePending.tsx (the title is "Lead Inbox"
// either way). The wire-shape contract pins the three branches so a
// future regression that adds an explicit "fetched but empty" branch
// surfaces here as a deliberate code change, not a silent UI bug.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react). The hook layer is mocked via vi.mock so the
// page renders with deterministic data.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'proj-1' }),
}));

vi.mock('@/hooks/queries/crm', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useLeads: vi.fn(),
  };
});

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
    isPending: false,
  })),
}));

import LeadInboxPage from './page';
import { useLeads } from '@/hooks/queries/crm';

const mockedUseLeads = vi.mocked(useLeads);

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadInboxPage - T-D3 state matrix', () => {
  it('loading: isLoading === true renders <Skeleton> and not the table', () => {
    mockedUseLeads.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    // The Skeleton renders an animated placeholder; in
    // renderToStaticMarkup the class is the signal (no real DOM
    // measurement). We assert the page header is present + the
    // table is NOT rendered.
    expect(html).toContain('Lead Inbox');
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain('No leads match these filters');
  });

  it('partial: data is an array of 1 row renders the LeadTable with the row', () => {
    mockedUseLeads.mockReturnValue({
      data: [
        {
          id: 'lead-1',
          name: 'Priya Sharma',
          phone: '+919876543210',
          status: 'NEW',
          source: 'WEBSITE',
          ownerName: 'Admin',
          updatedAt: '2026-09-04T10:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('Lead Inbox');
    expect(html).toContain('Priya Sharma');
    // The status badge renders the friendly label ("New") via
    // lib/labels.ts, NOT the raw enum - same wire-shape as
    // LeadStatusBadge. assert the friendly form.
    expect(html).toContain('New');
    // The link wraps the name and points to /{projectId}/leads/{id}.
    expect(html).toContain('href="/proj-1/leads/lead-1"');
    // No Skeleton, no ModulePending ("failed to load" surface).
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('failed to load');
  });

  it('empty: data is an empty array renders the LeadTable with "No leads match these filters" (still partial)', () => {
    mockedUseLeads.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    // The page still has the header; the empty state is inside
    // the table - a 1-cell panel - and the ModulePending
    // ("failed to load") surface is NOT shown (because data
    // resolved cleanly, just to []).
    expect(html).toContain('Lead Inbox');
    expect(html).toContain('No leads match these filters');
    expect(html).not.toContain('failed to load');
  });

  it('error: data is undefined and error is set renders <ModulePending>', () => {
    const apiError = new Error('API 500: Internal Server Error');
    mockedUseLeads.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('Lead Inbox');
    // ModulePending surfaces the error message via its "failed to
    // load" branch.
    expect(html).toContain('failed to load');
    expect(html).toContain('API 500');
    // Empty-state panel and Skeleton must not appear.
    expect(html).not.toContain('No leads match these filters');
    expect(html).not.toContain('data-slot="skeleton"');
  });
});
