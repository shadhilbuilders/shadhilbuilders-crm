// Admin project A-Z detail page tests.
//   Pins the render branches: not-authorized, not-found, and the loaded
//   project (identity card + count grid + phases/options/units sections).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useParams: vi.fn(),
  useSessionUser: vi.fn(),
  useProjectDetail: vi.fn(),
  useDashboardStats: vi.fn(),
  useLeads: vi.fn(),
  useLeadsEnvelope: vi.fn(),
  useInventoryUnits: vi.fn(),
  useInventoryPhases: vi.fn(),
  useProjectOptions: vi.fn(),
  useOrgSlug: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: mocks.useParams,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
}));

vi.mock('@/hooks/queries', () => ({
  useProjectDetail: mocks.useProjectDetail,
  useProjectsTable: vi.fn(),
}));

vi.mock('@/hooks/queries/dashboard', () => ({
  useDashboardStats: mocks.useDashboardStats,
}));

vi.mock('@/hooks/queries/crm', () => ({
  useLeads: mocks.useLeads,
  useLeadsEnvelope: mocks.useLeadsEnvelope,
}));

vi.mock('@/hooks/queries/inventory', () => ({
  useInventoryUnits: mocks.useInventoryUnits,
  useInventoryPhases: mocks.useInventoryPhases,
  useProjectOptions: mocks.useProjectOptions,
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: mocks.useOrgSlug,
}));

// Mock the reusable section components so we don't mount their real queries.
vi.mock('@/components/inventory/PhasesSection', () => ({
  PhasesSection: () => <div data-qa="phases-section">Phases</div>,
}));
vi.mock('@/components/inventory/ProjectOptionsSection', () => ({
  FacingOptionsCard: () => <div data-qa="facing-options">Facing</div>,
  BhkOptionsCard: () => <div data-qa="bhk-options">BHK</div>,
}));
vi.mock('@/components/teams/project-team-list', () => ({
  ProjectTeamList: () => <div data-qa="project-team-list">Teams</div>,
}));
vi.mock('@/components/projects/project-form-bodies', () => ({
  ProjectFormBody: () => null,
  ProjectDeleteBody: () => null,
}));

import AdminProjectDetailPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AdminProjectDetailPage />);
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

function baseDetail() {
  return {
    id: 'proj-1',
    slug: 'shadhil-metro-heights',
    name: 'Shadhil Metro Heights',
    address: 'Chennai',
    reraNumber: null,
    cmdaNumber: null,
    createdAt: '2026-09-17T06:35:29.000Z',
    counts: {
      phases: 3,
      units: 16,
      options: 9,
      teams: 1,
      teamMembers: 2,
      leads: 12,
      bookings: 0,
    },
  };
}

function baseMocks(): void {
  mocks.useParams.mockReturnValue({ projectId: 'proj-1' });
  mocks.useOrgSlug.mockReturnValue('shadhil-builders');
  mocks.useProjectDetail.mockReturnValue({
    data: baseDetail(),
    isLoading: false,
  });
  mocks.useDashboardStats.mockReturnValue({
    data: { kpis: { newLeadsToday: 1, overdueLeads: 2, visitsToday: 3 } },
  });
  mocks.useLeads.mockReturnValue({ data: [], isLoading: false });
  mocks.useLeadsEnvelope.mockReturnValue({ total: 0 });
  mocks.useInventoryUnits.mockReturnValue({ data: [], isLoading: false });
  mocks.useInventoryPhases.mockReturnValue({ data: [], isLoading: false });
  mocks.useProjectOptions.mockReturnValue({ data: [], isLoading: false });
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('AdminProjectDetailPage', () => {
  it('renders the project identity + count grid for an ADMIN', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'a-1', role: 'ADMIN', name: 'Admin', email: 'a@x' },
      isPending: false,
      error: null,
    });
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Shadhil Metro Heights');
    expect(html).toContain('shadhil-metro-heights');
    expect(html).toContain('Chennai');
    expect(html).toContain('At a glance');
    expect(html).toContain('Phases');
  });

  it('shows NOT-AUTHORIZED for a TELECALLER', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'tc-1', role: 'TELECALLER', name: 'Priya', email: 'p@x' },
      isPending: false,
      error: null,
    });
    await mount();
    expect(container?.innerHTML ?? '').toContain('Not authorized');
  });

  it('shows Project not found when the detail 404s', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'a-1', role: 'ADMIN', name: 'Admin', email: 'a@x' },
      isPending: false,
      error: null,
    });
    mocks.useProjectDetail.mockReturnValue({
      data: null,
      isLoading: false,
    });
    await mount();
    expect(container?.innerHTML ?? '').toContain('Project not found');
  });

  it('renders leads then pagination as siblings (no overlay)', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'a-1', role: 'ADMIN', name: 'Admin', email: 'a@x' },
      isPending: false,
      error: null,
    });
    mocks.useLeads.mockReturnValue({
      data: Array.from({ length: 10 }, (_, i) => ({
        id: `lead-${i}`,
        name: `Lead ${i}`,
        ownerName: 'Telecaller',
      })),
      isLoading: false,
    });
    mocks.useLeadsEnvelope.mockReturnValue({ total: 28 });
    await mount();
    const pager = container?.querySelector('[data-qa="admin-project-leads-pagination"]');
    expect(pager).not.toBeNull();
    const list = pager?.previousElementSibling;
    expect(list?.tagName).toBe('DIV');
    expect(list?.querySelectorAll('li').length).toBe(10);
    expect(pager?.parentElement?.contains(list as Node)).toBe(true);
    expect(list?.contains(pager as Node)).toBe(false);
  });
});
