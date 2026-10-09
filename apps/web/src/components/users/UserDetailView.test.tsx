// UserDetailView (rendered on /admin/staff-permission; autoplan 2026-09-13).
//
// Pins the render branches:
//   1. session pending             → <Skeleton variant="users" />
//   2. user not authorized (non-admin) → "Not authorized" panel
//   3. useUser isLoading           → <Skeleton variant="card" /> + "list"
//   4. useUser error               → inline retry error branch
//   5. SALES_EXEC/TELECALLER data  → "Reports to" row renders (name + email,
//      or "No manager assigned") + "Assign manager"/"Reassign manager"
//   6. MANAGER/ADMIN data          → "Reports to" row renders the org
//      OWNER, read-only (no assign button) - T-REPORTS-TO-OWNER 2026-10-06
//   6b. OWNER data                 → the row is OMITTED entirely (reports
//      to nobody)
//   7. projects render as badges; empty → the team-aware empty copy
//      (T-TEAM-AUTHORITATIVE 2026-09-13 clean cutover: Projects card is
//      read-only now - ProjectMember, the per-user link this used to
//      offer, was retired; project staffing is team-based only)
//
// Page has a `mounted` gate (flips true only in useEffect) - mount with
// createRoot + act (runs effects), same pattern as users/page.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUser: vi.fn(),
  useAssignManager: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useTeams: vi.fn(() => ({ data: [] })),
}));

vi.mock('@/hooks/queries/users', () => ({
  useUser: mocks.useUser,
  useAssignManager: mocks.useAssignManager,
  useResetUserPassword: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
  outranks: (actor: string, target: string) => {
    const rank: Record<string, number> = { OWNER: 4, ADMIN: 3, MANAGER: 2, TELECALLER: 1, SALES_EXEC: 1 };
    return (rank[actor] ?? 0) > (rank[target] ?? 0);
  },
  canManageUsers: (role: string) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
}));

// T-USER-LEADS (2026-09-24): the page now mounts UserLeadsCard, which reads
// react-query (useLeads + useProjects) and needs a QueryClientProvider this
// test does not set up. These assertions are all about the user-detail
// panels, so stub the card with a marker - its own behaviour is covered by
// UserLeadsCard's tests and the live-API probe.
vi.mock('@/components/users/UserLeadsCard', () => ({
  UserLeadsCard: ({ userId }: { userId: string }) => (
    <div data-qa="user-leads-card-shell">leads for {userId}</div>
  ),
}));

import { UserDetailView } from './UserDetailView';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<UserDetailView userId="user-1" />);
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
  mocks.useUser.mockReset();
  mocks.useAssignManager.mockClear();
  mocks.useTeams.mockClear();
});

describe('UserDetailView - state matrix', () => {
  it('session pending renders <Skeleton>', async () => {
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true });
    mocks.useUser.mockReturnValue({ data: undefined, isLoading: false, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-slot="skeleton"');
  });

  it('not authorized: TELECALLER sees the "Not authorized" panel', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-tc', role: 'TELECALLER', email: 'tc@x', teamId: 't1' },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({ data: undefined, isLoading: false, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
  });

  it('loading: useUser isLoading renders <Skeleton> card + list', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({ data: undefined, isLoading: true, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain('data-qa="user-info-card"');
  });

  it('error: useUser error surfaces inline with a retry button', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    const refetch = vi.fn();
    mocks.useUser.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('API 404: User not found'),
      refetch,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain("Couldn't load this user.");
    expect(html).toContain('API 404');
    expect(html).toContain('data-qa="user-detail-retry-button"');
  });

  it('SALES_EXEC: shows manager name + email', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'exec-1',
        email: 'priya@example.com',
        name: 'Priya Sharma',
        role: 'SALES_EXEC',
        teamId: 'team-1',
        teamName: "Ravi's Team",
        manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@example.com' },
        projects: [{ id: 'proj-1', name: 'Metro Heights' }],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="user-info-card"');
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('priya@example.com');
    expect(html).toContain('data-qa="user-manager-row"');
    expect(html).toContain('Ravi Manager');
    expect(html).toContain('ravi@example.com');
    expect(html).toContain("Ravi's Team");
    // Projects render as badges.
    expect(html).toContain('data-qa="user-projects-list"');
    expect(html).toContain('Metro Heights');
    // Write action: an admin/owner viewer sees "Reassign manager" (a
    // manager is already set). The Projects card is read-only now (no
    // link action - ProjectMember was retired).
    expect(html).toContain('data-qa="user-assign-manager-button"');
    expect(html).toContain('Reassign manager');
  });

  it('SALES_EXEC with no manager yet: button reads "Assign manager"', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'exec-2',
        email: 'kiran@example.com',
        name: 'Kiran Rao',
        role: 'SALES_EXEC',
        teamId: null,
        teamName: null,
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="user-assign-manager-button"');
    expect(html).toContain('Assign manager');
    expect(html).not.toContain('Reassign manager');
  });

  it('TELECALLER with no manager assigned: shows "No manager assigned"', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'tc-1',
        email: 'rajesh@example.com',
        name: 'Rajesh Kumar',
        role: 'TELECALLER',
        teamId: 'team-2',
        teamName: 'Unled Team',
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="user-manager-row"');
    expect(html).toContain('No manager assigned');
    // No projects → the team-aware empty state, not the badge list.
    expect(html).toContain("Unled Team isn't linked to any project yet.");
    expect(html).not.toContain('data-qa="user-projects-list"');
  });

  it('MANAGER row: "Reports to" shows the org OWNER, read-only (no assign button)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'mgr-1',
        email: 'ravi@example.com',
        name: 'Ravi Manager',
        role: 'MANAGER',
        teamId: null,
        teamName: null,
        manager: { id: 'owner-1', name: 'Deepak Owner', email: 'owner@example.com' },
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="user-manager-row"');
    expect(html).toContain('Reports to');
    expect(html).toContain('Deepak Owner');
    expect(html).toContain('owner@example.com');
    // T-REPORTS-TO-OWNER: fixed, never assignable - no button for a
    // MANAGER/ADMIN row even though the viewer canManageUsers.
    expect(html).not.toContain('data-qa="user-assign-manager-button"');
    expect(html).toContain('data-qa="user-projects-card"');
  });

  it('ADMIN row: "Reports to" shows the org OWNER, read-only (no assign button)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'admin-2',
        email: 'admin2@example.com',
        name: 'Second Admin',
        role: 'ADMIN',
        teamId: null,
        teamName: null,
        manager: { id: 'owner-1', name: 'Deepak Owner', email: 'owner@example.com' },
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="user-manager-row"');
    expect(html).toContain('Deepak Owner');
    expect(html).not.toContain('data-qa="user-assign-manager-button"');
  });

  it('OWNER row: the "Reports to" section is omitted entirely (reports to nobody)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'owner-1',
        email: 'owner@example.com',
        name: 'Deepak Owner',
        role: 'OWNER',
        teamId: null,
        teamName: null,
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).not.toContain('data-qa="user-manager-row"');
    expect(html).not.toContain('data-qa="user-assign-manager-button"');
  });
});
