// T-D3 - Lead Detail (state matrix).
//
// Pins the three render branches in apps/web/src/app/(app)/[projectId]/leads/[id]/page.tsx:
//
//   1. isLoading === true           → <Skeleton variant="card" /> + variant="list"
//   2. data is set                  → detail layout (LeadInfoCard + LeadActionPanel +
//                                       LeadVisitPanel + LeadTimeline + <LeadChatPane />)
//   3. data is undefined + error   → <ModulePending error={...} />
//
// The page has no separate empty state - a missing lead falls to the
// error branch (the route param ?id may not resolve, the BFF may 404,
// or the leads module is not yet wired up). ModulePending is the
// universal "couldn't load this" surface.
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react). The hook layer is mocked via vi.mock so the
// page renders with deterministic data.
//
// The detail page composes several child components (LeadActionPanel,
// LeadVisitPanel, LeadTimeline, LeadChatPane). Each of those pulls
// its own react-query hooks; mocking only `useLead`/`useLeadActivities`
// leaves the children crashing on `useQueryClient()`. We mock the
// child components as a render-only stub so the page-level state
// branches are the unit under test. (The children have their own
// dedicated tests.)
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// next/navigation: useParams is a client hook. Render the page
// directly - the page reads `params?.id` from useParams; we use
// a string fallback that the page already handles.
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'lead-1', projectId: 'proj-1' }),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useLead: vi.fn(),
  useLeadActivities: vi.fn(),
}));

vi.mock('@/components/shared/LeadActionPanel', () => ({
  LeadActionPanel: () => null,
  EditLeadForm: () => null,
}));
vi.mock('@/components/shared/LeadVisitPanel', () => ({
  LeadVisitPanel: () => null,
}));
vi.mock('@/components/shared/LeadChatPane', () => ({
  LeadChatPane: () => null,
}));
vi.mock('@/components/shared/LeadStatusBadge', () => ({
  LeadStatusBadge: () => null,
}));
vi.mock('@/components/shared/PhoneNumber', () => ({
  PhoneNumber: () => null,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
    isPending: false,
  })),
}));

import LeadDetailPage from './page';
import { useLead, useLeadActivities } from '@/hooks/queries/crm';

const mockedUseLead = vi.mocked(useLead);
const mockedUseLeadActivities = vi.mocked(useLeadActivities);

const FULL_LEAD = {
  id: 'lead-1',
  name: 'Priya Sharma',
  phone: '+919876543210',
  email: 'priya@example.com',
  source: 'WEBSITE',
  status: 'NEW',
  ownerId: 'u-2',
  ownerName: 'Asha T.',
  ownerType: 'TELECALLER',
  coOwnerId: null,
  coOwnerName: null,
  teamId: 'team-1',
  projectId: null,
  createdAt: '2026-09-04T10:00:00Z',
  updatedAt: '2026-09-04T10:00:00Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadDetailPage - T-D3 state matrix', () => {
  it('loading: useLead isLoading renders <Skeleton> and not the detail layout', () => {
    mockedUseLead.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);
    mockedUseLeadActivities.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadDetailPage />);
    // Page header (always rendered)
    expect(html).toContain('Back to inbox');
    // Skeleton is rendered.
    expect(html).toContain('data-slot="skeleton"');
    // ModulePending ("failed to load") surface is NOT rendered.
    expect(html).not.toContain('failed to load');
  });

  it('data: useLead resolves with data renders the detail layout with the name + phone', () => {
    mockedUseLead.mockReturnValue({
      data: FULL_LEAD,
      isLoading: false,
      error: null,
    } as never);
    mockedUseLeadActivities.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadDetailPage />);
    expect(html).toContain('Back to inbox');
    // The lead name appears in the breadcrumb.
    expect(html).toContain('Priya Sharma');
    // The info card renders the source + owner labels.
    expect(html).toContain('Website');
    expect(html).toContain('Asha T.');
    // No Skeleton on the data branch.
    expect(html).not.toContain('data-slot="skeleton"');
    // No ModulePending ("failed to load") surface.
    expect(html).not.toContain('failed to load');
  });

  it('error: useLead error and no data renders <ModulePending>', () => {
    const apiError = new Error('API 404: Lead not found');
    mockedUseLead.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);
    mockedUseLeadActivities.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadDetailPage />);
    expect(html).toContain('Back to inbox');
    // ModulePending surfaces the error message.
    expect(html).toContain('failed to load');
    expect(html).toContain('API 404');
    // No Skeleton.
    expect(html).not.toContain('data-slot="skeleton"');
  });
});
