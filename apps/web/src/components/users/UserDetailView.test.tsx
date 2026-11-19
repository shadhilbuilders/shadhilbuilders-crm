// UserDetailView (rendered on /admin/users/[userId]; autoplan 2026-09-13).
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUser: vi.fn(),
  useAssignManager: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useTeams: vi.fn(() => ({ data: [] })),
  // 2026-11-19: the panel now owns Edit + Delete, so it mounts the shared
  // dialogs and navigates away after a soft delete.
  useUpdateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useChangeUserRole: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  routerReplace: vi.fn(),
}));

vi.mock('@/hooks/queries/users', () => ({
  useUser: mocks.useUser,
  useAssignManager: mocks.useAssignManager,
  useUpdateUser: mocks.useUpdateUser,
  useDeleteUser: mocks.useDeleteUser,
  useChangeUserRole: mocks.useChangeUserRole,
  useResetUserPassword: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.routerReplace, push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
}));

// The dialogs build their return path from the org slug; the real hook needs a
// TenantProvider this render does not mount.
vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'test',
  useProjectSlug: () => null,
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
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
  canManageUsers: (role: string) => role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
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

// 2026-11-10: an ENGINEER target mounts the villas card instead of the leads card.
vi.mock('@/components/users/UserUnitsCard', () => ({
  UserUnitsCard: ({ engineerId }: { engineerId: string }) => (
    <div data-qa="user-units-card">villas for {engineerId}</div>
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
  mocks.useUpdateUser.mockClear();
  mocks.useDeleteUser.mockClear();
  mocks.useChangeUserRole.mockClear();
  mocks.routerReplace.mockClear();
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

  // ── ENGINEER (2026-11-07) ───────────────────────────────────────────────
  // The reported bug: this page said "No manager assigned" for an engineer
  // whose team clearly had one, because the reporting rule was a positive
  // role union that excluded ENGINEER.
  it('ENGINEER: shows the assigned-villas card and NOT the leads card', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'eng-1',
        email: 'arjun@example.com',
        name: 'Arjun Site',
        role: 'ENGINEER',
        teamId: 'team-1',
        teamName: "Ravi's Team",
        teamIds: ['team-1'],
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('villas for eng-1');
    expect(html).not.toContain('leads for eng-1');
  });

  it('ENGINEER: shows manager + assign button (the reported bug)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'eng-1',
        email: 'arjun@example.com',
        name: 'Arjun Site',
        role: 'ENGINEER',
        teamId: 'team-1',
        teamName: "Ravi's Team",
        teamIds: ['team-1'],
        manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@example.com' },
        projects: [{ id: 'proj-1', name: 'Metro Heights' }],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="user-manager-row"');
    expect(html).toContain('Ravi Manager');
    expect(html).not.toContain('No manager assigned');
    // Assignable - an admin can repair an engineer's reporting line.
    expect(html).toContain('data-qa="user-assign-manager-button"');
    expect(html).toContain('Reassign manager');
  });

  // ── CUSTOMER (regression) ───────────────────────────────────────────────
  // `showReportsTo = role !== 'OWNER'` rendered a bogus "No manager assigned"
  // row for buyer accounts. CUSTOMER has no reporting line at all.
  it('ADMIN viewer: assign button IS offered on an ENGINEER', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'eng-1',
        email: 'arjun@example.com',
        name: 'Arjun Site',
        role: 'ENGINEER',
        teamId: 'team-1',
        teamName: "Ravi's Team",
        teamIds: ['team-1'],
        manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@example.com' },
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    expect(container?.innerHTML ?? '').toContain('data-qa="user-assign-manager-button"');
  });

  it('CUSTOMER: no "Reports to" row and no assign button', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
      isPending: false,
    });
    mocks.useUser.mockReturnValue({
      data: {
        id: 'cust-1',
        email: 'buyer@example.com',
        name: 'Buyer',
        role: 'CUSTOMER',
        teamId: null,
        teamName: null,
        teamIds: [],
        manager: null,
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).not.toContain('data-qa="user-manager-row"');
    expect(html).not.toContain('No manager assigned');
    expect(html).not.toContain('data-qa="user-assign-manager-button"');
  });
});

// 2026-11-19: Edit + Delete on the specific-user page.
//
// The panel is where an admin lands after clicking a row, so it carries the two
// actions the list hides in a dropdown. What these pin is the GATING, because it
// has to mirror two different server guards (update: strictly outrank, no
// self-edit; remove: admin class, no self, OWNER protected) and the delete
// navigation, because a soft-deleted user no longer resolves on this route.
describe('UserDetailView - edit and delete actions', () => {
  const TARGET = {
    id: 'user-2',
    email: 'priya@example.com',
    name: 'Priya Sharma',
    role: 'TELECALLER',
    teamId: 'team-1',
    teamName: "Ravi's Team",
    manager: null,
    projects: [],
    phone: '919876543210',
  };

  function asActor(id: string, role: string) {
    mocks.useSessionUser.mockReturnValue({
      user: { id, role, email: `${id}@x`, teamId: null },
      isPending: false,
    });
  }

  function withTarget(overrides: Record<string, unknown> = {}) {
    mocks.useUser.mockReturnValue({
      data: { ...TARGET, ...overrides },
      isLoading: false,
      error: null,
    });
  }

  function button(selector: string): HTMLButtonElement | null {
    return container?.querySelector<HTMLButtonElement>(selector) ?? null;
  }

  async function click(el: Element | null): Promise<void> {
    expect(el).not.toBeNull();
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  // The dialogs are Radix portals: their DOM lands in <body>, not in the
  // container the panel was rendered into.
  function field(name: string): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>(`[data-qa="${name}"]`);
  }

  it('an ADMIN sees Edit and Delete on a staff member they outrank', async () => {
    asActor('admin-1', 'ADMIN');
    withTarget();

    await mount();

    expect(button('[data-qa="user-edit-button"]')).not.toBeNull();
    expect(button('[data-qa="user-delete-button"]')).not.toBeNull();
  });

  it('hides both on an OWNER row - nobody outranks the OWNER and it cannot be deleted', async () => {
    asActor('admin-1', 'ADMIN');
    withTarget({ id: 'owner-1', role: 'OWNER', name: 'Arun Owner' });

    await mount();

    expect(button('[data-qa="user-edit-button"]')).toBeNull();
    expect(button('[data-qa="user-delete-button"]')).toBeNull();
  });

  it('hides both on your own account', async () => {
    asActor('admin-1', 'ADMIN');
    withTarget({ id: 'admin-1', role: 'ADMIN', name: 'Self Admin' });

    await mount();

    expect(button('[data-qa="user-edit-button"]')).toBeNull();
    expect(button('[data-qa="user-delete-button"]')).toBeNull();
  });

  it('Edit opens the shared dialog prefilled, with the phone in 10-digit form', async () => {
    asActor('admin-1', 'ADMIN');
    withTarget();

    await mount();
    await click(button('[data-qa="user-edit-button"]'));

    // The stored value is 12-digit E.164; the field must show the 10-digit form
    // or the first keystroke truncates it (defect history in lib/phone.ts).
    expect(field('edit-user-name')?.value).toBe('Priya Sharma');
    expect(field('edit-user-email')?.value).toBe('priya@example.com');
    expect(field('edit-user-phone')?.value).toBe('9876543210');
  });

  it('Delete confirms through the mutation and leaves the dead route', async () => {
    asActor('admin-1', 'ADMIN');
    withTarget();
    const mutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    mocks.useDeleteUser.mockReturnValue({ mutate, isPending: false });

    await mount();
    await click(button('[data-qa="user-delete-button"]'));

    const confirm = Array.from(document.querySelectorAll('button')).find((b) =>
      /delete user/i.test(b.textContent ?? ''),
    );
    await click(confirm ?? null);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe('user-2');
    // Leaving the route is the point: a soft-deleted user 404s from here.
    expect(mocks.routerReplace).toHaveBeenCalledWith('/test/admin/users');
  });
});

// 2026-11-19: the role change joined Edit and Delete on this page, sharing the
// dialog the users list already used. Its gating is assertCanChangeRole's shape:
// never OWNER as source or destination (nothing outranks OWNER), never self.
describe('UserDetailView - change role', () => {
  const TARGET = {
    id: 'exec-9',
    email: 'karthik@example.com',
    name: 'Karthik R',
    role: 'SALES_EXEC',
    teamId: 'team-1',
    teamName: "Ravi's Team",
    manager: null,
    projects: [],
    phone: null,
  };

  function actor(id: string, role: string) {
    mocks.useSessionUser.mockReturnValue({
      user: { id, role, email: `${id}@x`, teamId: null },
      isPending: false,
    });
  }

  async function click(el: Element | null): Promise<void> {
    expect(el).not.toBeNull();
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('offers the role change on a user the actor outranks', async () => {
    actor('admin-1', 'ADMIN');
    mocks.useUser.mockReturnValue({ data: TARGET, isLoading: false, error: null });

    await mount();

    expect(container?.querySelector('[data-qa="user-change-role-button"]')).not.toBeNull();
  });

  it('hides it on your own account and on the OWNER row', async () => {
    actor('admin-1', 'ADMIN');
    mocks.useUser.mockReturnValue({
      data: { ...TARGET, id: 'admin-1', name: 'Self Admin', role: 'ADMIN' },
      isLoading: false,
      error: null,
    });
    await mount();
    expect(container?.querySelector('[data-qa="user-change-role-button"]')).toBeNull();
    await unmount();

    mocks.useUser.mockReturnValue({
      data: { ...TARGET, id: 'owner-1', name: 'Arun Owner', role: 'OWNER' },
      isLoading: false,
      error: null,
    });
    await mount();
    expect(container?.querySelector('[data-qa="user-change-role-button"]')).toBeNull();
  });

  it('opens the shared dialog showing the current role', async () => {
    actor('admin-1', 'ADMIN');
    mocks.useUser.mockReturnValue({ data: TARGET, isLoading: false, error: null });

    await mount();
    await click(container?.querySelector('[data-qa="user-change-role-button"]') ?? null);

    // Portal content: <body>, not the mount container.
    const dialogText = document.body.textContent ?? '';
    expect(dialogText).toContain('Change role for Karthik R');
    expect(dialogText).toContain('Current role');
    // Sales exec, not a generic default: the form is seeded from the target.
    expect(document.body.querySelector('[data-qa="change-role-confirm"]')).not.toBeNull();
  });
});
