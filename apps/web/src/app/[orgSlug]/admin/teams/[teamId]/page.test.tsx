// T-TEAM-CRUD (2026-09-13) - org team roster page.
//
// Pins the render branches added on top of the existing roster (which
// already covered project link/unlink):
//   1. not authorized (non-admin)               -> "Not authorized"
//   2. loading                                   -> <Skeleton />
//   3. team loaded                                -> header "Actions" menu
//      trigger + a "Move to team" button per member row.
//
// Mount with createRoot + act (the page has a `mounted` gate), same
// pattern as ../page.test.tsx and admin/users/[userId]/page.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useTeam: vi.fn(),
  useTeams: vi.fn(),
  useReassignTeamMembers: vi.fn(),
  useUpdateTeamMemberWeight: vi.fn(),
  useUpdateTeamMemberCap: vi.fn(),
  useProjects: vi.fn(),
  useLinkProjectMemberToProject: vi.fn(),
  useUnlinkProjectMember: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeam: mocks.useTeam,
  useTeams: mocks.useTeams,
  useReassignTeamMembers: mocks.useReassignTeamMembers,
  // team-roster.tsx calls useUpdateTeamMemberWeight for the per-member
  // weight edit in the "Move to team" action menu - the mock must export it
  // or the import throws at module load.
  useUpdateTeamMemberWeight: mocks.useUpdateTeamMemberWeight,
  // T-MAXOPENLEADS (2026-09-28): and the cap hook, imported by the same row.
  useUpdateTeamMemberCap: mocks.useUpdateTeamMemberCap,
}));

vi.mock('@/hooks/queries/projects', () => ({
  useProjects: mocks.useProjects,
  useLinkProjectMemberToProject: mocks.useLinkProjectMemberToProject,
  useUnlinkProjectMember: mocks.useUnlinkProjectMember,
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
  useParams: () => ({ teamId: 't-1' }),
  useRouter: () => ({ push: mocks.routerPush }),
}));

import TeamRosterPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // MemberCard's LinkProjectDialog calls useQueryClient() unconditionally
  // (regardless of the dialog's open state) - a real QueryClientProvider is
  // required, same as leads/page.test.tsx's rationale for LeadReassignDialog.
  const queryClient = new QueryClient();
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <TeamRosterPage />
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
  mocks.useTeams.mockReturnValue({ data: [], isLoading: false, error: null });
  mocks.useReassignTeamMembers.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useProjects.mockReturnValue({ data: [] });
  mocks.useLinkProjectMemberToProject.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useUnlinkProjectMember.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useUpdateTeamMemberWeight.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('TeamRosterPage - org team roster', () => {
  it('MANAGER is NOT authorized (org teams is admin/owner only)', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-mgr', name: 'M', email: 'm@x', role: 'MANAGER', teamId: 't-1' },
      isPending: false,
      error: null,
    });
    mocks.useTeam.mockReturnValue({ data: undefined, isLoading: false, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
  });

  it('session pending renders <Skeleton>', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true, error: null });
    mocks.useTeam.mockReturnValue({ data: undefined, isLoading: false, error: null });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-slot="skeleton"');
  });

  it('renders the header Actions menu + a "Move to team" button per member (ADMIN/OWNER surface)', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    mocks.useTeam.mockReturnValue({
      data: {
        id: 't-1',
        name: 'Construction Desk',
        manager: { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x' },
        members: [
          {
            userId: 'u-tc',
            name: 'Tele Caller One',
            email: 'tc1@x',
            role: 'TELECALLER',
            projects: [],
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('data-qa="team-header-actions-button"');
    expect(html).toContain('data-qa="team-member-move-u-tc"');
    expect(html).toContain('Move to team');
  });
});
