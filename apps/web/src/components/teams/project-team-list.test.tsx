// ProjectTeamList - T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI3).
//
// Mount pattern mirrors admin/teams/[teamId]/page.test.tsx: createRoot +
// act + a real QueryClientProvider (some paalstack components call
// useQueryClient unconditionally), hooks mocked via vi.mock.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useProjectTeams: vi.fn(),
  useLinkProjectTeam: vi.fn(),
  useUnlinkProjectTeam: vi.fn(),
  useTeams: vi.fn(),
}));

vi.mock('@/hooks/queries/project-teams', () => ({
  useProjectTeams: mocks.useProjectTeams,
  useLinkProjectTeam: mocks.useLinkProjectTeam,
  useUnlinkProjectTeam: mocks.useUnlinkProjectTeam,
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
}));

import { ProjectTeamList } from './project-team-list';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(props: {
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  canManage?: boolean;
}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ProjectTeamList
          projectId={props.projectId ?? 'proj-1'}
          projectName={props.projectName ?? 'Metro Heights'}
          projectSlug={props.projectSlug ?? 'metro-heights'}
          canManage={props.canManage ?? true}
        />
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
  mocks.useTeams.mockReturnValue({ data: [] });
  mocks.useLinkProjectTeam.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useUnlinkProjectTeam.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('ProjectTeamList', () => {
  it('renders a loading skeleton while the query is pending', async () => {
    baseMocks();
    mocks.useProjectTeams.mockReturnValue({ isLoading: true, error: null, data: undefined });
    await mount({});
    expect(container?.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it('renders the warm empty state when no teams are linked', async () => {
    baseMocks();
    mocks.useProjectTeams.mockReturnValue({
      isLoading: false,
      error: null,
      data: { projectId: 'proj-1', teams: [] },
    });
    await mount({});
    expect(document.body.textContent).toContain('No teams work on this project yet');
    expect(document.body.textContent).toContain('Link a team so its members and manager get project access.');
  });

  it('the empty state read-only copy differs for non-admin viewers', async () => {
    baseMocks();
    mocks.useProjectTeams.mockReturnValue({
      isLoading: false,
      error: null,
      data: { projectId: 'proj-1', teams: [] },
    });
    await mount({ canManage: false });
    expect(document.body.textContent).toContain('Ask an admin to link a team to this project.');
  });

  it('hides the Link team button for non-admin viewers', async () => {
    baseMocks();
    mocks.useProjectTeams.mockReturnValue({
      isLoading: false,
      error: null,
      data: { projectId: 'proj-1', teams: [] },
    });
    await mount({ canManage: false });
    expect(container?.querySelector('[data-qa="project-team-link-button"]')).toBeNull();
  });

  it('shows an error alert with retry on query failure', async () => {
    baseMocks();
    const refetch = vi.fn();
    mocks.useProjectTeams.mockReturnValue({
      isLoading: false,
      error: new Error('network down'),
      data: undefined,
      refetch,
    });
    await mount({});
    expect(document.body.textContent).toContain("Couldn't load linked teams.");
    expect(document.body.textContent).toContain('network down');
  });

  it('one linked team auto-expands and pins the manager first with a badge', async () => {
    baseMocks();
    mocks.useProjectTeams.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        projectId: 'proj-1',
        teams: [
          {
            teamId: 'team-a',
            teamName: 'Metro Sales',
            manager: { id: 'mgr-a', name: 'Meera' },
            memberCount: 2,
            leadCount: 0,
            canUnlink: true,
            members: [
              {
                userId: 'tc-1',
                teamId: 'team-a',
                name: 'Priya',
                email: 'priya@x.in',
                role: 'TELECALLER',
                assignedAt: new Date().toISOString(),
                isManagerSlot: false,
              },
              {
                userId: 'mgr-a',
                teamId: 'team-a',
                name: 'Meera',
                email: 'meera@x.in',
                role: 'MANAGER',
                assignedAt: new Date(0).toISOString(),
                isManagerSlot: true,
              },
            ],
          },
        ],
      },
    });
    await mount({});
    expect(document.body.textContent).toContain('1 linked team');
    expect(document.body.textContent).toContain('Metro Sales');
    expect(document.body.textContent).toContain('Meera · 2 members · 0 leads');
    // Auto-expanded (single linked team) - both members visible without a click.
    expect(document.body.textContent).toContain('Priya');
    // Manager badge present.
    expect(container?.querySelector('[data-qa="project-team-manager-badge-mgr-a"]')).not.toBeNull();
  });

  it('multiple linked teams start collapsed', async () => {
    baseMocks();
    const team = (id: string, name: string) => ({
      teamId: id,
      teamName: name,
      manager: null,
      memberCount: 1,
      leadCount: 0,
      canUnlink: true,
      members: [
        {
          userId: `user-${id}`,
          teamId: id,
          name: `Member of ${name}`,
          email: 'x@x.in',
          role: 'TELECALLER',
          assignedAt: new Date().toISOString(),
          isManagerSlot: false,
        },
      ],
    });
    mocks.useProjectTeams.mockReturnValue({
      isLoading: false,
      error: null,
      data: { projectId: 'proj-1', teams: [team('team-a', 'Metro Sales'), team('team-b', 'Closing Desk')] },
    });
    await mount({});
    expect(document.body.textContent).toContain('2 linked teams');
    // Neither team's members render until expanded.
    expect(document.body.textContent).not.toContain('Member of Metro Sales');
    expect(document.body.textContent).not.toContain('Member of Closing Desk');
  });
});
