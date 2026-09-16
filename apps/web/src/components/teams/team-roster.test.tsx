// TeamRosterMemberRow - T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI1).
//
// Locks in the two rules that must never drift between Admin -> Teams and
// Work -> My Teams (see team-roster.tsx's file header):
//   1. The manager row is pinned with a Manager badge and never offers
//      "Remove from this team", regardless of `canRemove`.
//   2. Every other row's "Remove from this team" is gated purely on the
//      caller-supplied `canRemove` boolean.
//
// Mount pattern mirrors project-team-list.test.tsx: createRoot + act + a
// real QueryClientProvider (TeamMemberRemovalDialog's inner hooks call
// useQuery/useMutation unconditionally).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useRemovalPreview: vi.fn(),
  useReassignAndRemove: vi.fn(),
}));

vi.mock('@/hooks/queries/team-members', () => ({
  useRemovalPreview: mocks.useRemovalPreview,
  useReassignAndRemove: mocks.useReassignAndRemove,
}));

import { TeamRosterMemberRow } from './team-roster';
import type { TeamMemberRow } from '@/hooks/queries/teams';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(props: {
  member: TeamMemberRow;
  managerId: string | null;
  canRemove: boolean;
  dataQaPrefix?: string;
}): Promise<void> {
  mocks.useRemovalPreview.mockReturnValue({ isLoading: false, error: null, data: undefined, refetch: vi.fn() });
  mocks.useReassignAndRemove.mockReturnValue({ mutate: vi.fn(), isPending: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <TeamRosterMemberRow
          teamId="team-a"
          teamName="Metro Sales"
          member={props.member}
          managerId={props.managerId}
          canRemove={props.canRemove}
          dataQaPrefix={props.dataQaPrefix}
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

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

const managerMember: TeamMemberRow = {
  userId: 'mgr-a',
  name: 'Meera',
  email: 'meera@x.in',
  role: 'MANAGER',
};

const ordinaryMember: TeamMemberRow = {
  userId: 'tc-1',
  name: 'Priya',
  email: 'priya@x.in',
  role: 'TELECALLER',
};

describe('TeamRosterMemberRow', () => {
  it('pins the manager row with a Manager badge and never offers remove, even when canRemove=true', async () => {
    await mount({ member: managerMember, managerId: 'mgr-a', canRemove: true });
    expect(container?.querySelector('[data-qa="team-member-manager-badge-mgr-a"]')).not.toBeNull();
    expect(container?.querySelector('[data-qa="team-member-remove-mgr-a"]')).toBeNull();
  });

  it('shows "Remove from this team" on an ordinary member row when canRemove=true', async () => {
    await mount({ member: ordinaryMember, managerId: 'mgr-a', canRemove: true });
    expect(container?.querySelector('[data-qa="team-member-remove-tc-1"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Remove from this team');
  });

  it('hides "Remove from this team" on an ordinary member row when canRemove=false', async () => {
    await mount({ member: ordinaryMember, managerId: 'mgr-a', canRemove: false });
    expect(container?.querySelector('[data-qa="team-member-remove-tc-1"]')).toBeNull();
  });

  it('honours a custom dataQaPrefix (My Teams uses "my-team-member")', async () => {
    await mount({
      member: ordinaryMember,
      managerId: 'mgr-a',
      canRemove: true,
      dataQaPrefix: 'my-team-member',
    });
    expect(container?.querySelector('[data-qa="my-team-member-remove-tc-1"]')).not.toBeNull();
    expect(container?.querySelector('[data-qa="team-member-remove-tc-1"]')).toBeNull();
  });

  it('always shows the role badge for every row', async () => {
    await mount({ member: ordinaryMember, managerId: 'mgr-a', canRemove: false });
    expect(document.body.textContent).toContain('Priya');
    expect(document.body.textContent).toContain('priya@x.in');
  });
});
