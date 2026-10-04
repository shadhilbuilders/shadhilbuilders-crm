// AddTeamMembersDialog - add telecallers / sales execs to a team. Pins:
//   1. staff list renders; people already on the team are shown disabled
//   2. submit is disabled until something is picked, then posts the picked ids
//   3. success toast reports added + already-members counts
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useUsers: vi.fn(),
  mutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeam: mocks.useTeam,
  useAddTeamMembers: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock('@/hooks/queries/users', () => ({ useUsers: mocks.useUsers }));
vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return { ...actual, toast: mocks.toast };
});
vi.mock('@/lib/labels', () => ({
  labelFor: (kind: string, v: string) => `${kind}:${v}`,
}));

import { AddTeamMembersDialog } from './AddTeamMembersDialog';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const team = {
  id: 'team-a',
  name: 'Construction Desk',
  defaultAssigneeId: null,
  memberCount: 1,
  managerId: null,
  managerName: null,
};

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AddTeamMembersDialog team={team} open onOpenChange={() => {}} />);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function seed() {
  mocks.useTeam.mockReturnValue({
    data: {
      id: 'team-a',
      name: 'Construction Desk',
      manager: null,
      members: [{ userId: 'u-in', name: 'Asha', email: 'asha@x', role: 'TELECALLER' }],
    },
    isLoading: false,
  });
  mocks.useUsers.mockReturnValue({
    data: {
      total: 2,
      rows: [
        { id: 'u-in', name: 'Asha', email: 'asha@x', role: 'TELECALLER', teamId: null, projects: [] },
        { id: 'u-new', name: 'Priya', email: 'priya@x', role: 'TELECALLER', teamId: null, projects: [] },
      ],
    },
    isLoading: false,
    isError: false,
  });
}

describe('AddTeamMembersDialog', () => {
  it('lists staff and marks current members as already in the team', async () => {
    seed();
    await mount();
    const html = document.body.innerHTML;
    expect(html).toContain('Priya');
    expect(html).toContain('Already in team');
    expect(mocks.useUsers).toHaveBeenCalledWith(
      expect.objectContaining({ role: ['TELECALLER', 'SALES_EXEC'] }),
    );
    const submit = document.body.querySelector(
      '[data-qa="team-add-members-submit"]',
    ) as HTMLButtonElement | null;
    expect(submit?.disabled).toBe(true);
  });

  it('submits the picked user ids and toasts the result', async () => {
    seed();
    mocks.mutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: (r: unknown) => void }) =>
        opts.onSuccess({ added: 1, alreadyMembers: 0 }),
    );
    await mount();
    const checkbox = document.body.querySelector(
      '[data-qa="team-add-member-checkbox-u-new"]',
    ) as HTMLElement | null;
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox?.click();
    });
    const submit = document.body.querySelector(
      '[data-qa="team-add-members-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
    });
    expect(mocks.mutate).toHaveBeenCalledWith(
      { userIds: ['u-new'] },
      expect.any(Object),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith(
      expect.stringContaining('1 member added to Construction Desk'),
    );
  });
});
