// T-D3 — Users management (state matrix).
//
// Pins the render branches in apps/web/src/app/(app)/users/page.tsx:
//   1. session pending             → <Skeleton variant="user" />
//   2. user not authorized (TELECALLER / SALES_EXEC) → "Not authorized" panel
//   3. useUsers isLoading          → <Skeleton variant="text" count={5} />
//   4. useUsers data is set        → user rows (id, name, email, role, team)
//   5. useUsers error             → error message rendered as plain text
//      (the page does NOT use ModulePending; the surface is "row
//      gone, but the page itself is still up" — better than a
//      full-page error because the user might still be able to create
//      a new user or sign out)
//
// Uses renderToStaticMarkup per the standing rule (apps/web has no
// @testing-library/react). The hook layer is mocked via vi.mock so the
// page renders with deterministic data.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted before the const declarations; use vi.hoisted to
// share the mock fns between the mock factory and the per-test setup.
const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUsers: vi.fn(),
  useCreateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useChangeUserRole: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/queries/users', () => ({
  useUsers: mocks.useUsers,
  useCreateUser: mocks.useCreateUser,
  useChangeUserRole: mocks.useChangeUserRole,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  canManageUsers: (role: string) =>
    role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
}));

import UsersPage from './page';

afterEach(() => {
  mocks.useSessionUser.mockReset();
  mocks.useUsers.mockReset();
});

describe('UsersPage — T-D3 state matrix', () => {
  it('session pending: useSessionUser.isPending renders <Skeleton>', () => {
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

    const html = renderToStaticMarkup(<UsersPage />);
    // Session-pending state: the page renders a full Skeleton
    // instead of the page chrome.
    expect(html).toContain('data-slot="skeleton"');
    // The page header / title is NOT rendered (Skeleton only).
    expect(html).not.toContain('All users across the organization');
  });

  it('not authorized: TELECALLER sees the "Not authorized" panel', () => {
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

    const html = renderToStaticMarkup(<UsersPage />);
    expect(html).toContain('Not authorized');
    expect(html).toContain('Only admins and managers');
  });

  it('loading: useUsers isLoading renders <Skeleton> rows', () => {
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

    const html = renderToStaticMarkup(<UsersPage />);
    // The page header is shown (admin authorized), but the table
    // body is a Skeleton, not a real table.
    expect(html).toContain('All users across the organization');
    expect(html).toContain('data-slot="skeleton"');
    // No user rows.
    expect(html).not.toContain('data-qa="user-row"');
  });

  it('partial: useUsers data renders user rows (id, name, email, role, team)', () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useUsers.mockReturnValue({
      data: [
        {
          id: 'u-priya',
          name: 'Priya Sharma',
          email: 'priya@example.com',
          role: 'SALES_EXEC',
          teamId: 't-1',
        },
        {
          id: 'u-rajesh',
          name: 'Rajesh Kumar',
          email: 'rajesh@example.com',
          role: 'TELECALLER',
          teamId: 't-1',
        },
      ],
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<UsersPage />);
    expect(html).toContain('All users across the organization');
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('priya@example.com');
    expect(html).toContain('Rajesh Kumar');
    // No Skeleton, no "Not authorized".
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('Not authorized');
  });

  it('error: useUsers error surfaces inline (not ModulePending — design choice)', () => {
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

    const html = renderToStaticMarkup(<UsersPage />);
    // The header is shown.
    expect(html).toContain('All users across the organization');
    // The error message surfaces inline.
    expect(html).toContain('API 500');
    // No ModulePending-style "failed to load" surface.
    expect(html).not.toContain('failed to load');
  });
});
