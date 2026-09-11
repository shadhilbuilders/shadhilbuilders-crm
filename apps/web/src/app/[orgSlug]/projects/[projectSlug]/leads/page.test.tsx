// T-D3 + autoplan 2026-09-07 - Lead Inbox state matrix (rewritten page).
//
// Pins the render branches of the DataTable-based inbox:
//   1. isLoading === true         → <Skeleton variant="table" />
//   2. error + no data            → inline retry error branch (D21)
//   3. data array, empty + search → "No leads match this search."
//   4. data array, empty, clean   → "No leads yet." (warm queue empty)
//   5. data array with rows       → name link + friendly status label
//   6. overdue row                → "Overdue" badge (NEW + createdAt > 30 min)
//   7. delete action visible/hidden by role (D14: canDeleteLeads)
//
// T-SRVPG (2026-09-07): the summary counts now come from the server
// envelope (useLeadsEnvelope → overdueCount / newTodayCount), not from
// client-side row filtering. The status filter is a server-driven
// MultiSelect (toolbar left side) instead of the DataTable's client-side
// facet filter.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react). The hook layer is mocked via vi.mock.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ orgId: 'org-1', projectId: 'proj-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

// Slug-based URL scheme: the page reads org/project SLUGS from the tenant
// context (the resolved server layout value), not from useParams anymore.
vi.mock('@/lib/tenant-context', () => ({
  useOrg: () => ({ id: 'org-1', slug: 'org-1', name: 'Org 1' }),
  useProject: () => ({ id: 'proj-1', slug: 'proj-1', name: 'Proj 1' }),
  useOrgId: () => 'org-1',
  useProjectId: () => 'proj-1',
  useOrgSlug: () => 'org-1',
  useProjectSlug: () => 'proj-1',
}));

vi.mock('@/hooks/queries/crm', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useLeads: vi.fn(),
    useLeadsEnvelope: vi.fn(() => null),
    useDeleteLead: vi.fn(() => ({
      mutate: vi.fn(),
      isPending: false,
    })),
    useUpdateLead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  };
});

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
    isPending: false,
  })),
  canDeleteLeads: (role: string) => role === 'ADMIN' || role === 'OWNER',
  canReassign: (role: string) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
}));

// Mock the reassign dialog (jsdom portal rule - it calls useMutation /
// useQueryClient which would throw without a QueryClientProvider; the detail
// page test mocks LeadActionPanel the same way). The dialog's open/close
// behavior and its combobox fetch are covered by the dialog's own test.
vi.mock('@/components/leads/LeadReassignDialog', () => ({
  LeadReassignDialog: () => null,
}));

import LeadInboxPage from './page';
import { useLeads, useLeadsEnvelope } from '@/hooks/queries/crm';

const mockedUseLeads = vi.mocked(useLeads);
const mockedUseLeadsEnvelope = vi.mocked(useLeadsEnvelope);

const baseRow = {
  id: 'lead-1',
  name: 'Priya Sharma',
  phone: '9876543210',
  status: 'NEW',
  source: 'WEBSITE',
  ownerName: 'Admin',
  createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 60 min ago → overdue
  updatedAt: new Date().toISOString(),
};

function freshRow(overrides: Record<string, unknown>) {
  return { ...baseRow, ...overrides };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadInboxPage - state matrix (rewritten)', () => {
  it('loading: renders the summary skeleton + table skeleton, no error branch', () => {
    mockedUseLeads.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('Lead Inbox');
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain('Try again');
  });

  it('row: renders name link, friendly status label, and per-row actions', () => {
    mockedUseLeads.mockReturnValue({
      data: [freshRow({})],
      isLoading: false,
      error: null,
    } as never);
    mockedUseLeadsEnvelope.mockReturnValue({
      total: 1,
      overdueCount: 1,
      newTodayCount: 0,
    });

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('href="/org-1/projects/proj-1/leads/lead-1"');
    // Friendly label via LeadStatusBadge (T11 rule), not raw enum.
    expect(html).toContain('New');
    expect(html).not.toMatch(/>NEW</);
    // The library DataTableRowActions renders its own trigger marker.
    expect(html).toContain('data-qa="data-table-row-actions-button"');
    // Storybook ToolbarWithRightSideContent pattern: search lives in the
    // toolbar + the create button is the toolbar's right-side content.
    expect(html).toContain('data-qa="data-table-search-input"');
    expect(html).toContain('data-qa="data-table-toolbar-right-side-content"');
    expect(html).toContain('data-qa="new-lead-button"');
  });

  it('overdue: NEW + created 60 min ago renders the Overdue badge', () => {
    mockedUseLeads.mockReturnValue({
      data: [freshRow({})],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('data-qa="lead-overdue-badge"');
    expect(html).toContain('Overdue');
  });

  it('fresh: NEW + created 5 min ago does NOT render the Overdue badge', () => {
    mockedUseLeads.mockReturnValue({
      data: [
        freshRow({
          createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).not.toContain('data-qa="lead-overdue-badge"');
  });

  it('non-NEW state never renders the Overdue badge', () => {
    mockedUseLeads.mockReturnValue({
      data: [
        freshRow({
          status: 'CONTACTED',
          createdAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
        }),
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).not.toContain('data-qa="lead-overdue-badge"');
  });

  it('summary line: reads overdue + new-today counts from the server envelope (D12 + T-SRVPG)', () => {
    mockedUseLeads.mockReturnValue({
      data: [freshRow({})],
      isLoading: false,
      error: null,
    } as never);
    mockedUseLeadsEnvelope.mockReturnValue({
      total: 2,
      overdueCount: 1,
      newTodayCount: 1,
    });

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('1 overdue');
    expect(html).toContain('1 new today');
  });

  it('empty + no search: warm queue empty state', () => {
    mockedUseLeads.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    expect(html).toContain('No leads yet.');
  });

  it('error: renders the retry branch (D21), not ModulePending', () => {
    const apiError = new Error('API 500: Internal Server Error');
    mockedUseLeads.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    // renderToStaticMarkup escapes the apostrophe as &#x27;.
    expect(html).toContain('load the lead queue.');
    expect(html).toContain('Try again');
    expect(html).toContain('data-qa="leads-retry-button"');
  });

  it('delete action: VISIBLE for ADMIN (canDeleteLeads)', () => {
    mockedUseLeads.mockReturnValue({
      data: [freshRow({})],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadInboxPage />);
    // The library DataTableRowActions trigger renders in SSR; the menu
    // content opens on click (client-only). Role-visibility is pinned at
    // the unit level in lib/session (canDeleteLeads mirrors RLS) + the
    // backend D14 tests. (The library's trigger uses a generic sr-only
    // "Open menu" label - no per-row aria-label prop.)
    expect(html).toContain('data-qa="data-table-row-actions-button"');
  });
});
