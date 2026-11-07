// Inventory grid - the row actions menu is an ADMIN/OWNER surface.
//
// Unit writes (create / edit / delete) are ADMIN/OWNER only at the service
// (InventoryService.create/update/delete) and in RLS, but the grid offered
// "Edit" to every role: a MANAGER opening it got a form whose Save always came
// back 403. The menu must therefore be absent for non-admin roles - not merely
// missing an item, because a kebab that opens an empty popup is worse than no
// kebab at all.
//
// Mounted with createRoot + act (not renderToStaticMarkup): the page gates on a
// `mounted` flag that only flips in useEffect, so a static render would show
// canEdit=false for EVERY role and the admin positive control would prove
// nothing. Same harness as admin/users/page.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useInventoryUnits: vi.fn(),
  useInventoryUnitsEnvelope: vi.fn(() => 1),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ orgSlug: 'org-1', projectSlug: 'proj-1' }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/tenant-context', () => ({
  useProjectId: () => 'proj-1',
  useOrgSlug: () => 'org-1',
  useProjectSlug: () => 'proj-1',
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string | undefined) => role === 'ADMIN' || role === 'OWNER',
  canManageProjectMembers: (role: string | undefined) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
}));

vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: () => true,
}));

vi.mock('@paalstack/react-hooks', () => ({
  useDebouncedValue: (value: string) => [value, () => {}],
}));

vi.mock('@/hooks/queries/inventory', () => ({
  useInventoryUnits: mocks.useInventoryUnits,
  useInventoryUnitsEnvelope: mocks.useInventoryUnitsEnvelope,
  useInventoryPhases: () => ({ data: [], isLoading: false, error: null }),
  useProjectOptions: () => ({ data: [], isLoading: false, error: null }),
  useUnit: () => ({ data: undefined }),
  useDeleteUnit: () => ({ mutate: vi.fn(), isPending: false }),
  // UnitEditDialog is mounted by the page unconditionally (it renders nothing
  // while `unit === null`), so its mutation hook must exist even though these
  // tests never open it.
  useUpdateUnit: () => ({ mutate: vi.fn(), isPending: false }),
}));

import InventoryPage from './page';

const UNIT_ROW = {
  id: 'unit-1',
  phaseId: 'phase-1',
  phaseName: 'Phase 1',
  projectId: 'proj-1',
  projectName: 'Proj 1',
  unitNumber: 'A-101',
  plotNumber: 37,
  bhk: 3,
  facing: 'North',
  sqft: 1450,
  buildupSqft: '1450.00',
  pricePerSqft: '4000.00',
  price: '5800000.00',
  status: 'AVAILABLE',
  createdAt: '2026-09-01T00:00:00.000Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<InventoryPage />);
  });
  return container.innerHTML;
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

function mockRole(role: string): void {
  mocks.useSessionUser.mockReturnValue({
    user: { id: 'u-1', name: 'Actor', email: 'a@x', role, teamId: null },
    isPending: false,
    error: null,
  });
}

afterEach(async () => {
  await unmount();
  mocks.useSessionUser.mockReset();
  mocks.useInventoryUnits.mockReset();
});

describe('Inventory grid - unit edit is ADMIN/OWNER only', () => {
  beforeEach(() => {
    mocks.useInventoryUnits.mockReturnValue({
      data: [UNIT_ROW],
      isLoading: false,
      error: null,
    });
  });

  it('renders the row actions menu for an ADMIN (positive control)', async () => {
    mockRole('ADMIN');
    const html = await mount();

    expect(html).toContain('data-qa="data-table-row"');
    expect(html).toContain('data-qa="data-table-row-actions-button"');
  });

  it('renders the row actions menu for an OWNER', async () => {
    mockRole('OWNER');
    const html = await mount();

    expect(html).toContain('data-qa="data-table-row-actions-button"');
  });

  it.each(['MANAGER', 'SALES_EXEC', 'TELECALLER', 'ENGINEER'])(
    'hides the row actions menu entirely for %s',
    async (role) => {
      mockRole(role);
      const html = await mount();

      // The grid itself still renders - they may read inventory.
      expect(html).toContain('A-101');
      // ...but there is no trigger for a write action they cannot perform.
      expect(html).not.toContain('data-qa="data-table-row-actions-button"');
    },
  );
});
