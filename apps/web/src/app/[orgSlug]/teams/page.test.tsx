// Work -> My Teams list page - T-TEAM-AUTHORITATIVE (2026-09-13, design
// doc UI1). Mount pattern mirrors admin/teams/page.test.tsx.
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
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
}));

import MyTeamsPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MyTeamsPage />);
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
  vi.clearAllMocks();
});

const managerUser = { id: 'mgr-1', name: 'Meera', email: 'meera@x', role: 'MANAGER', teamId: 'team-a', organizationId: 'org-1' };

describe('MyTeamsPage', () => {
  it('shows a skeleton while the session is pending', async () => {
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true, error: null });
    mocks.useTeams.mockReturnValue({ data: undefined, isLoading: false, error: null });
    await mount();
    expect(document.body.textContent).not.toContain('My Teams');
  });

  it('non-MANAGER roles see "Not authorized"', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'tc-1', name: 'Priya', email: 'p@x', role: 'TELECALLER', teamId: 'team-a', organizationId: 'org-1' },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({ data: [], isLoading: false, error: null });
    await mount();
    expect(document.body.textContent).toContain('Not authorized');
  });

  it('ADMIN also sees "Not authorized" (they use Admin -> Teams instead)', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'admin-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null, organizationId: 'org-1' },
      isPending: false,
      error: null,
    });
    mocks.useTeams.mockReturnValue({ data: [], isLoading: false, error: null });
    await mount();
    expect(document.body.textContent).toContain('Not authorized');
  });

  it('splits teams into "You manage" and "You\'re a member of" sections', async () => {
    mocks.useSessionUser.mockReturnValue({ user: managerUser, isPending: false, error: null });
    mocks.useTeams.mockReturnValue({
      isLoading: false,
      error: null,
      data: [
        { id: 'team-a', name: 'Metro Sales', defaultAssigneeId: null, memberCount: 5, managerId: 'mgr-1', managerName: 'Meera' },
        { id: 'team-b', name: 'Closing Desk', defaultAssigneeId: null, memberCount: 3, managerId: 'mgr-2', managerName: 'Arjun' },
      ],
    });
    await mount();
    expect(document.body.textContent).toContain('You manage');
    expect(document.body.textContent).toContain('Metro Sales');
    expect(document.body.textContent).toContain("You're a member of");
    expect(document.body.textContent).toContain('Closing Desk');
  });

  it('empty state when the manager leads and belongs to no team', async () => {
    mocks.useSessionUser.mockReturnValue({ user: managerUser, isPending: false, error: null });
    mocks.useTeams.mockReturnValue({ isLoading: false, error: null, data: [] });
    await mount();
    expect(document.body.textContent).toContain("You don't lead or belong to a team yet.");
  });
});
