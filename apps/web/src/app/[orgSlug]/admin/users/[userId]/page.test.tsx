// User detail page (/admin/users/[userId], autoplan 2026-09-13).
//
// Pins the render branches:
//   1. session pending             → <Skeleton variant="users" />
//   2. user not authorized (non-admin) → "Not authorized" panel
//   3. useUser isLoading           → <Skeleton variant="card" /> + "list"
//   4. useUser error               → inline retry error branch
//   5. SALES_EXEC/TELECALLER data  → manager row renders (name + email,
//      or "No manager assigned") + "Assign manager"/"Reassign manager"
//   6. MANAGER/ADMIN data          → manager row is OMITTED entirely
//   7. projects render as badges; empty → "Not assigned to any project."
//   8. "Link to project" button renders in the Projects card header
//      (canManageProjectMembers gate - actor is always ADMIN/OWNER here
//      since the page's own gate already requires isAdminLike)
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
  useProjects: vi.fn(() => ({ data: [] })),
  useLinkProjectMemberToProject: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useTeams: vi.fn(() => ({ data: [] })),
}));

vi.mock('@/hooks/queries/users', () => ({
  useUser: mocks.useUser,
  useAssignManager: mocks.useAssignManager,
}));

vi.mock('@/hooks/queries/projects', () => ({
  useProjects: mocks.useProjects,
  useLinkProjectMemberToProject: mocks.useLinkProjectMemberToProject,
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
  canManageUsers: (role: string) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
  canManageProjectMembers: (role: string) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrg: () => ({ id: 'org-ceid01', slug: 'shadhil-builders', name: 'Shadhil' }),
  useOrgSlug: () => 'shadhil-builders',
  useOrgId: () => 'org-ceid01',
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ userId: 'user-1' }),
}));

import UserDetailPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<UserDetailPage />);
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
  mocks.useProjects.mockClear();
  mocks.useLinkProjectMemberToProject.mockClear();
  mocks.useTeams.mockClear();
});

describe('UserDetailPage - state matrix', () => {
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
    // Write actions: an admin/owner viewer sees both "Reassign manager"
    // (a manager is already set) and "Link to project".
    expect(html).toContain('data-qa="user-assign-manager-button"');
    expect(html).toContain('Reassign manager');
    expect(html).toContain('data-qa="user-link-project-button"');
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
    // No projects → the empty state, not the badge list.
    expect(html).toContain('Not assigned to any project.');
    expect(html).not.toContain('data-qa="user-projects-list"');
  });

  it('MANAGER row: the manager section is omitted entirely', async () => {
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
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).not.toContain('data-qa="user-manager-row"');
    // No manager section → no "assign manager" button either, but the
    // Projects card's "Link to project" button is unaffected.
    expect(html).not.toContain('data-qa="user-assign-manager-button"');
    expect(html).toContain('data-qa="user-link-project-button"');
  });

  it('ADMIN row: the manager section is omitted entirely', async () => {
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
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).not.toContain('data-qa="user-manager-row"');
  });
});
