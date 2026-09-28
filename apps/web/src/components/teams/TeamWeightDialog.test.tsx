// TeamWeightDialog - T-AUTOASSIGN (2026-09-17): one-screen per-member
// routing-weight management. Pins:
//   1. loading             → <Loading> placeholder
//   2. no members          → "No members in this team yet."
//   3. members             → a weight input per routable TELECALLER member
//   4. manager row         → no weight input (a manager isn't routable)
//   5. sales exec row      → no weight input, "Not auto-assigned" instead
//                            (2026-09-28: the auto-assign pool is telecaller-only)
//   6. commit on blur      → calls updateTeamMemberWeight({teamId,userId,weight})
//
// Mount with createRoot + act (the dialog's useTeam must run).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useUpdateTeamMemberWeight: vi.fn(() => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isLoading: false,
  })),
  useUpdateTeamMemberCap: vi.fn(() => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isLoading: false,
  })),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeam: mocks.useTeam,
  useUpdateTeamMemberWeight: mocks.useUpdateTeamMemberWeight,
  useUpdateTeamMemberCap: mocks.useUpdateTeamMemberCap,
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return { ...actual, toast: mocks.toast };
});

vi.mock('@/lib/labels', () => ({
  labelFor: (kind: string, v: string) => `${kind}:${v}`,
}));

import { TeamWeightDialog } from './TeamWeightDialog';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const team = {
  id: 'team-a',
  name: 'Construction Desk',
  defaultAssigneeId: null,
  memberCount: 2,
  managerId: 'mgr-1',
  managerName: 'Maya Rao',
  autoAssignLeads: true,
};

async function mount(open = true): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TeamWeightDialog team={team} open={open} onOpenChange={() => {}} />,
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

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('TeamWeightDialog', () => {
  it('shows a loading placeholder while members are pending', async () => {
    mocks.useTeam.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    await mount();
    // Dialog portals its content to document.body, not the container div.
    expect(document.body.innerHTML).toContain('Loading members');
  });

  it('renders a weight input per non-manager member and hides the manager editor', async () => {
    mocks.useTeam.mockReturnValue({
      data: {
        id: 'team-a',
        name: 'Construction Desk',
        manager: { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x' },
        members: [
          { userId: 'tc-1', name: 'Priya', email: 'priya@x', role: 'TELECALLER', weight: 2 },
          { userId: 'se-1', name: 'Vikram', email: 'vikram@x', role: 'SALES_EXEC', weight: 4 },
          { userId: 'mgr-1', name: 'Maya Rao', email: 'maya@x', role: 'MANAGER', weight: 1 },
        ],
      },
      isLoading: false,
      isError: false,
    });
    await mount();
    const html = document.body.innerHTML;
    // Telecaller gets a weight input seeded from the DB value.
    expect(html).toContain('data-qa="team-weight-input-tc-1"');
    expect(html).toContain('value="2"');
    expect(html).toContain('Priya');
    // Manager row is present but has NO weight editor.
    expect(html).toContain('Maya Rao');
    expect(html).not.toContain('data-qa="team-weight-input-mgr-1"');
    // Sales exec row: no editor either, labelled instead - their weight is
    // inert because new leads are never auto-assigned to an exec.
    expect(html).not.toContain('data-qa="team-weight-input-se-1"');
    expect(html).toContain('data-qa="team-weight-inert-se-1"');
    expect(html).toContain('Not auto-assigned');
    // T-MAXOPENLEADS (2026-09-28): the ceiling editor sits beside the weight
    // one for routable members, and nowhere else.
    expect(html).toContain('data-qa="team-cap-input-tc-1"');
    expect(html).not.toContain('data-qa="team-cap-input-mgr-1"');
    expect(html).not.toContain('data-qa="team-cap-input-se-1"');
  });

  it('shows an empty state when the team has no members', async () => {
    mocks.useTeam.mockReturnValue({
      data: { id: 'team-a', name: 'Construction Desk', manager: null, members: [] },
      isLoading: false,
      isError: false,
    });
    await mount();
    expect(document.body.innerHTML).toContain('No members in this team yet.');
  });
});
