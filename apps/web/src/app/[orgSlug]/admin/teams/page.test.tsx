// T-ORG-TEAMS (2026-09-10) - org Teams list page.
//
// Pins the render branches in apps/web/src/app/(app)/teams/page.tsx:
//   1. session pending          → <Skeleton />
//   2. user not authorized (MANAGER / TELECALLER / SALES_EXEC) → "Not authorized"
//   3. useTeams isLoading       → <Skeleton variant="table" />
//   4. useTeams data set        → DataTable rows (team, manager, member count)
//   5. useTeams error           → inline retry branch
//   6. empty                    → "No teams yet."
//
// Page has a `mounted` gate (flips true only in useEffect), so MOUNT with
// createRoot + act (runs effects) - the same pattern as users/page.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useTeams: vi.fn(),
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrg: () => ({ id: 'org-ceid01', slug: 'shadhil-builders', name: 'Shadhil' }),
  useOrgSlug: () => 'shadhil-builders',
  useOrgId: () => 'org-ceid01',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import TeamsPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TeamsPage />);
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

afterEach(async () => {
  await unmount();
  mocks.useSessionUser.mockReset();
  mocks.useTeams.mockReset();
});

describe('TeamsPage - org teams list', () => {
  it('session pending renders <Skeleton>', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: null,
      isPending: true,
      error: null,
    });
    mocks.useTeams.mockReturnValue({ data: [], isLoading: false });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-slot="skeleton"');
  });

  it('MANAGER is NOT authorized (org teams is admin/owner only)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-mgr', name: 'M', email: 'm@x', role: 'MANAGER', teamId: 't1' },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({ data: [], isLoading: false });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
    expect(html).toContain('Only admins can view the org teams');
  });

  it('loading renders a table Skeleton', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({ data: undefined, isLoading: true, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Deleting a team with members or an active manager is blocked');
    expect(html).toContain('data-slot="skeleton"');
  });

  it('renders team rows (name, manager, member count)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({
      data: [
        {
          id: 't-1',
          name: 'Construction Desk',
          defaultAssigneeId: null,
          memberCount: 4,
          managerId: 'mgr-1',
          managerName: 'Maya Rao',
          autoAssignLeads: true,
        },
        {
          id: 't-2',
          name: 'Real Estate Desk',
          defaultAssigneeId: null,
          memberCount: 2,
          managerId: null,
          managerName: null,
          autoAssignLeads: false,
        },
      ],
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Construction Desk');
    expect(html).toContain('Maya Rao');
    expect(html).toContain('Real Estate Desk');
    expect(html).toContain('No manager assigned');
    // Links to the roster pages, prefixed with the active org slug.
    expect(html).toContain('data-qa="team-row-link-t-1"');
    expect(html).toContain('href="/shadhil-builders/admin/teams/t-1"');
    // T-AUTOASSIGN badge next to the team name (enabled vs disabled).
    expect(html).toContain('data-qa="team-auto-assign-t-1"');
    expect(html).toContain('Auto-assign');
    expect(html).toContain('data-qa="team-auto-assign-t-2"');
    expect(html).toContain('Manager first');
  });

  it('error surfaces inline', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('API 500'),
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain("Couldn't load teams.");
    expect(html).toContain('API 500');
  });

  it('empty state shows "No teams yet."', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({ data: [], isLoading: false, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('No teams yet.');
  });

  it('renders the New team header action + a row actions menu per team (ADMIN/OWNER surface)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({
      data: [
        {
          id: 't-1',
          name: 'Construction Desk',
          defaultAssigneeId: null,
          memberCount: 4,
          managerId: 'mgr-1',
          managerName: 'Maya Rao',
        },
      ],
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    // Header action - the create dialog trigger.
    expect(html).toContain('New team');
    // Row actions menu (Edit / Reassign all members / Delete), same
    // ellipsis-trigger shape as ProjectRowActions/UserRowActions.
    expect(html).toContain('data-qa="team-row-actions"');
    expect(html).toContain('data-qa="data-table-row-actions-button"');
  });
});
