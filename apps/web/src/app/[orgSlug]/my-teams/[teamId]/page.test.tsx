// Work -> My Teams -> [teamId] roster - T-TEAM-AUTHORITATIVE (2026-09-13).
// Mount pattern mirrors admin/teams/[teamId]/page.test.tsx: createRoot +
// act + a real QueryClientProvider (TeamMemberRemovalDialog's inner hooks
// call useQuery/useMutation unconditionally).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useTeam: vi.fn(),
  useRemovalPreview: vi.fn(),
  useReassignAndRemove: vi.fn(),
  useUpdateTeamMemberWeight: vi.fn(),
  useUpdateTeamMemberCap: vi.fn(),
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeam: mocks.useTeam,
  // team-roster.tsx calls useUpdateTeamMemberWeight for the per-member weight
  // edit (T-AUTOASSIGN, 2026-09-17). A hand-rolled module mock REPLACES the
  // whole module, so every hook the component imports must be exported here or
  // the import throws "No export is defined on the mock" at render time.
  // Mirrors admin/teams/[teamId]/page.test.tsx, which was updated with the hook.
  useUpdateTeamMemberWeight: mocks.useUpdateTeamMemberWeight,
  // T-MAXOPENLEADS (2026-09-28): the roster now also imports the cap hook, so
  // this mock has to carry it too - the same trap as above, one field later.
  useUpdateTeamMemberCap: mocks.useUpdateTeamMemberCap,
}));

vi.mock('@/hooks/queries/team-members', () => ({
  useRemovalPreview: mocks.useRemovalPreview,
  useReassignAndRemove: mocks.useReassignAndRemove,
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ teamId: 'team-a' }),
}));

import MyTeamRosterPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MyTeamRosterPage />
      </QueryClientProvider>,
    );
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

function baseMocks(): void {
  mocks.useRemovalPreview.mockReturnValue({ isLoading: false, error: null, data: undefined, refetch: vi.fn() });
  mocks.useReassignAndRemove.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useUpdateTeamMemberWeight.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

const managerUser = { id: 'mgr-1', name: 'Meera', email: 'meera@x', role: 'MANAGER', teamId: 'team-a', organizationId: 'org-1' };

describe('MyTeamRosterPage', () => {
  it('non-MANAGER/admin-class roles see "Not authorized"', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'tc-1', name: 'Priya', email: 'p@x', role: 'TELECALLER', teamId: 'team-a', organizationId: 'org-1' },
      isPending: false,
      error: null,
    });
    mocks.useTeam.mockReturnValue({ data: undefined, isLoading: true, error: null });
    await mount();
    expect(document.body.textContent).toContain('Not authorized');
  });

  it('pins the manager row with a Manager badge and NO remove action on it', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({ user: managerUser, isPending: false, error: null });
    mocks.useTeam.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        id: 'team-a',
        name: 'Metro Sales',
        manager: { id: 'mgr-1', name: 'Meera', email: 'meera@x' },
        members: [
          { userId: 'mgr-1', name: 'Meera', email: 'meera@x', role: 'MANAGER', projects: [] },
          { userId: 'tc-1', name: 'Priya', email: 'priya@x', role: 'TELECALLER', projects: [] },
        ],
      },
    });
    await mount();
    expect(document.body.textContent).toContain('You manage this team.');
    expect(container?.querySelector('[data-qa="my-team-member-remove-mgr-1"]')).toBeNull();
    expect(container?.querySelector('[data-qa="my-team-member-remove-tc-1"]')).not.toBeNull();
  });

  it('an ordinary member (not the manager of this team) sees no remove actions at all', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({ user: managerUser, isPending: false, error: null });
    mocks.useTeam.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        id: 'team-b',
        name: 'Closing Desk',
        manager: { id: 'mgr-2', name: 'Arjun', email: 'arjun@x' },
        members: [
          { userId: 'mgr-2', name: 'Arjun', email: 'arjun@x', role: 'MANAGER', projects: [] },
          { userId: 'tc-2', name: 'Rahul', email: 'rahul@x', role: 'TELECALLER', projects: [] },
        ],
      },
    });
    await mount();
    expect(document.body.textContent).toContain('Managed by Arjun.');
    expect(container?.querySelector('[data-qa="my-team-member-remove-tc-2"]')).toBeNull();
  });
});
