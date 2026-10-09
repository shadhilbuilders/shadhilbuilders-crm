// T-D3 - Users management (state matrix) + autoplan 2026-09-09 (DataTable rebuild).
//
// Pins the render branches in apps/web/src/app/(app)/users/page.tsx:
//   1. session pending             → <Skeleton variant="user" />
//   2. user not authorized (TELECALLER / SALES_EXEC) → "Not authorized" panel
//   3. useUsers isLoading          → <Skeleton variant="table" />
//   4. useUsers data is set        → DataTable rows (name, email, role, team)
//   5. useUsers error             → inline retry error branch
//   6. self-row shows "ROLE (you)"; non-self rows render a role Select
//   7. empty data → "No users yet." empty state
//
// The page has a `mounted` gate (`if (!mounted || sessionPending) return
// <Skeleton/>`) where `mounted` flips true only in `useEffect`. Under
// `renderToStaticMarkup` effects never run, so `mounted` stays false and the
// page renders Skeleton for every test. Fix: MOUNT the page with
// `createRoot` + `act` (which runs effects) - the same pattern as
// `use-nav-sync.test.tsx`. This keeps the page code unchanged and tests the
// real render path.
//
// The hook layer is mocked via vi.mock.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `globalThis.IS_REACT_ACT_ENVIRONMENT` tells React this is a test env so
// `act` works with a raw createRoot (no @testing-library/react in this app).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// vi.mock is hoisted before the const declarations; use vi.hoisted to
// share the mock fns between the mock factory and the per-test setup.
const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUsers: vi.fn(),
  useCreateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useChangeUserRole: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  })),
  useUpdateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useResetUserPassword: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useTeams: vi.fn(() => ({
    data: [
      { id: 't-1', name: 'Team Alpha', defaultAssigneeId: null, memberCount: 0 },
    ],
    isLoading: false,
  })),
}));

vi.mock('@/hooks/queries/users', () => ({
  useUsers: mocks.useUsers,
  useCreateUser: mocks.useCreateUser,
  useChangeUserRole: mocks.useChangeUserRole,
  useUpdateUser: mocks.useUpdateUser,
  useDeleteUser: mocks.useDeleteUser,
  useResetUserPassword: mocks.useResetUserPassword,
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  canManageUsers: (role: string) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
  outranks: (actor: string, target: string) => {
    const rank: Record<string, number> = {
      OWNER: 4,
      ADMIN: 3,
      MANAGER: 2,
      TELECALLER: 1,
      SALES_EXEC: 1,
    };
    return (rank[actor] ?? 0) > (rank[target] ?? 0);
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import UsersPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<UsersPage />);
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
  mocks.useUsers.mockReset();
});

describe('UsersPage - T-D3 state matrix', () => {
  it('session pending: useSessionUser.isPending renders <Skeleton>', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: null,
      isPending: true,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    // Session-pending state: the page renders a full Skeleton
    // instead of the page chrome.
    expect(html).toContain('data-slot="skeleton"');
    // The page header / title is NOT rendered (Skeleton only).
    expect(html).not.toContain('All users across the organization');
  });

  it('not authorized: TELECALLER sees the "Not authorized" panel', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-tc', name: 'TC', email: 'tc@x', role: 'TELECALLER', teamId: 't1' },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
    expect(html).toContain('Only owners and admins');
  });

  it('not authorized: MANAGER sees the "Not authorized" panel', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-m', name: 'Mgr', email: 'm@x', role: 'MANAGER', teamId: 't1' },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
  });

  it('loading: useUsers isLoading renders <Skeleton> rows', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    // The page header is shown (admin authorized), but the table
    // body is a Skeleton, not a real table.
    expect(html).toContain('All users across the organization');
    expect(html).toContain('data-slot="skeleton"');
    // No user rows.
    expect(html).not.toContain('data-qa="data-table-row"');
  });

  it('partial: useUsers data renders DataTable rows (name, email, role, projects)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: {
        rows: [
          {
            id: 'u-priya',
            name: 'Priya Sharma',
            email: 'priya@example.com',
            role: 'SALES_EXEC',
            teamId: 't-1',
            projects: ['Shadhil Metro Heights'],
          },
          {
            id: 'u-rajesh',
            name: 'Rajesh Kumar',
            email: 'rajesh@example.com',
            role: 'TELECALLER',
            teamId: 't-1',
            projects: ['Shadhil Skyline Towers', 'Shadhil Metro Heights'],
          },
        ],
        total: 2,
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('All users across the organization');
    // DataTable container + rows.
    expect(html).toContain('data-qa="data-table"');
    expect(html).toContain('data-qa="data-table-row"');
    // Toolbar search input.
    expect(html).toContain('data-qa="data-table-search-input"');
    // Server-driven role filter (Combobox multiple in the toolbar left side).
    // The Combobox trigger renders its placeholder text; assert on the visible
    // placeholder instead.
    expect(html).toContain('Filter by role');
    // User names + emails render.
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('priya@example.com');
    expect(html).toContain('Rajesh Kumar');
    // Projects column shows a COUNT (autoplan 2026-09-13), not the joined
    // name list - the full list is a Tooltip hover-away (content isn't in
    // the static-mount markup, so it isn't asserted here).
    expect(html).toContain('1 project');
    expect(html).toContain('2 projects');
    expect(html).not.toContain('Shadhil Metro Heights');
    // No Skeleton, no "Not authorized".
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('Not authorized');
  });

  it('self-row shows "(you)"; role renders as text; actions column present', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: {
        rows: [
          {
            id: 'u-1',
            name: 'Admin',
            email: 'a@x',
            role: 'ADMIN',
            teamId: null,
            projects: [],
          },
          {
            id: 'u-priya',
            name: 'Priya Sharma',
            email: 'priya@example.com',
            role: 'SALES_EXEC',
            teamId: 't-1',
            projects: ['Shadhil Metro Heights'],
            reportsTo: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@example.com' },
          },
        ],
        total: 2,
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    // Self-row shows the "(you)" marker in the NAME cell.
    expect(html).toContain('(you)');
    // Role renders as TEXT (friendly label), not an inline Select.
    expect(html).toContain('Sales Executive');
    expect(html).not.toContain('data-qa="select-trigger"');
    // Actions column: a row-actions trigger per row (hierarchy-gated).
    expect(html).toContain('data-qa="data-table-row-actions-button"');
    // User details live on Staff Permission now: names are plain text, no
    // link to a per-user page.
    expect(html).toContain('data-qa="user-row-name-u-priya"');
    expect(html).not.toContain('data-qa="user-row-link-');
    expect(html).not.toContain('/admin/users/');
    expect(html).not.toContain('cursor-pointer');
    // "Reports to" column: the manager/owner name, or a dash when nobody.
    expect(html).toContain('Reports to');
    expect(html).toContain('data-qa="user-reports-to-u-priya"');
    expect(html).toContain('Ravi Manager');
    expect(html).toContain('data-qa="user-reports-to-u-1"');
  });

  it('empty: useUsers data is [] renders the "No users yet." empty state', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: { rows: [], total: 0 },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('No users yet.');
    expect(html).toContain('Create a user to get started.');
  });

  it('error: useUsers error surfaces inline (not ModulePending - design choice)', async () => {
    // The users page does NOT route errors through ModulePending;
    // it surfaces the error inline at the top of the body so the
    // user can still use the page (e.g. create a user) when the
    // list endpoint is down. Pin that choice.
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('API 500: Internal Server Error'),
    });

    await mount();
    const html = container?.innerHTML ?? '';
    // The header is shown.
    expect(html).toContain('All users across the organization');
    // The error message surfaces inline.
    expect(html).toContain('API 500');
    // No ModulePending-style "failed to load" surface.
    expect(html).not.toContain('failed to load');
  });
});
