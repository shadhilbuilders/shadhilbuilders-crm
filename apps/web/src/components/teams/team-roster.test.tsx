// TeamRosterMemberRow - T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI1).
//
// Locks in the two rules that must never drift between Admin -> Teams and
// Work -> My Team (see team-roster.tsx's file header):
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
  useUpdateTeamMemberWeight: vi.fn(() => ({ mutateAsync: vi.fn(), isLoading: false })),
  useUpdateTeamMemberCap: vi.fn(() => ({ mutateAsync: vi.fn(), isLoading: false })),
}));

vi.mock('@/hooks/queries/team-members', () => ({
  useRemovalPreview: mocks.useRemovalPreview,
  useReassignAndRemove: mocks.useReassignAndRemove,
}));

vi.mock('@/hooks/queries/teams', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/hooks/queries/teams')>();
  return {
    ...actual,
    useUpdateTeamMemberWeight: mocks.useUpdateTeamMemberWeight,
    useUpdateTeamMemberCap: mocks.useUpdateTeamMemberCap,
  };
});

import { TeamRosterMemberRow } from './team-roster';
import type { TeamMemberRow } from '@/hooks/queries/teams';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(props: {
  member: TeamMemberRow;
  managerId: string | null;
  managerName?: string | null;
  ownerName?: string | null;
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
          managerName={props.managerName}
          ownerName={props.ownerName}
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

  it('honours a custom dataQaPrefix (My Team uses "my-team-member")', async () => {
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

  it('shows the weight editor on a removable ordinary member (auto-assign)', async () => {
    await mount({ member: { ...ordinaryMember, weight: 2 }, managerId: 'mgr-a', canRemove: true });
    const input = container?.querySelector('[data-qa="team-member-weight-tc-1"]');
    expect(input).not.toBeNull();
    // Defaults to the member's current weight.
    expect((input as HTMLInputElement | null)?.value).toBe('2');
    // Hidden on the manager row (a manager doesn't take auto-assigned leads).
    await unmount();
    await mount({ member: managerMember, managerId: 'mgr-a', canRemove: true });
    expect(container?.querySelector('[data-qa="team-member-weight-mgr-a"]')).toBeNull();
  });

  it('gives a sales exec no weight editor - they are outside the auto-assign pool', async () => {
    // 2026-09-28: auto-assign is telecaller-only, so an editable weight on an
    // exec row would promise routing that no longer happens. The row says so
    // instead of offering a control.
    await mount({
      member: { userId: 'se-1', name: 'Vikram', email: 'vikram@x.in', role: 'SALES_EXEC', weight: 3 },
      managerId: 'mgr-a',
      canRemove: true,
    });
    expect(container?.querySelector('[data-qa="team-member-weight-se-1"]')).toBeNull();
    expect(container?.querySelector('[data-qa="team-member-weight-inert-se-1"]')).not.toBeNull();
    expect(container?.textContent).toContain('Not auto-assigned');
  });

  it('shows the open-lead cap editor on a telecaller, and hides it from the manager', async () => {
    // T-MAXOPENLEADS (2026-09-28): weight is a share, the cap is a ceiling -
    // two separate controls. Same routability rule as the weight editor.
    await mount({
      member: { ...ordinaryMember, weight: 1, maxOpenLeads: 12 },
      managerId: 'mgr-a',
      canRemove: true,
    });
    const capInput = container?.querySelector(
      '[data-qa="team-member-cap-tc-1"]',
    ) as HTMLInputElement | null;
    expect(capInput).not.toBeNull();
    // Seeded from the member's stored ceiling.
    expect(capInput?.value).toBe('12');

    await unmount();
    await mount({ member: managerMember, managerId: 'mgr-a', canRemove: true });
    expect(container?.querySelector('[data-qa="team-member-cap-mgr-a"]')).toBeNull();
  });

  it('renders an empty cap input (placeholder) for an uncapped member', async () => {
    // null must read as "no cap", not as 0 - which would mean "send nothing".
    await mount({
      member: { ...ordinaryMember, weight: 1, maxOpenLeads: null },
      managerId: 'mgr-a',
      canRemove: true,
    });
    const capInput = container?.querySelector(
      '[data-qa="team-member-cap-tc-1"]',
    ) as HTMLInputElement | null;
    expect(capInput).not.toBeNull();
    expect(capInput?.value).toBe('');
    expect(capInput?.placeholder).toBe('No cap');
  });

  it('commits a changed weight via useUpdateTeamMemberWeight on blur', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ userId: 'tc-1', teamId: 'team-a', weight: 5 });
    mocks.useUpdateTeamMemberWeight.mockReturnValue({ mutateAsync, isLoading: false });
    await mount({ member: { ...ordinaryMember, weight: 1 }, managerId: 'mgr-a', canRemove: true });
    const input = container?.querySelector('[data-qa="team-member-weight-tc-1"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      input!.value = '5';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      // React's onBlur is wired through the native `focusout` event.
      input!.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      teamId: 'team-a',
      userId: 'tc-1',
      weight: 5,
    });
  });

  it('hides the weight editor when canRemove is false (matching remove gating)', async () => {
    await mount({ member: ordinaryMember, managerId: 'mgr-a', canRemove: false });
    expect(container?.querySelector('[data-qa="team-member-weight-tc-1"]')).toBeNull();
  });

  describe('"Reports to" (T-REPORTS-TO-OWNER, 2026-10-06)', () => {
    it('a MANAGER row reports to the org OWNER, not this team\'s manager name', async () => {
      await mount({
        member: managerMember,
        managerId: 'mgr-a',
        managerName: 'Meera',
        ownerName: 'Deepak Owner',
        canRemove: true,
      });
      const row = container?.querySelector('[data-qa="team-member-reports-to-mgr-a"]');
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain('Deepak Owner');
    });

    it('a TELECALLER/SALES_EXEC row reports to THIS team\'s manager', async () => {
      await mount({
        member: ordinaryMember,
        managerId: 'mgr-a',
        managerName: 'Meera',
        ownerName: 'Deepak Owner',
        canRemove: true,
      });
      const row = container?.querySelector('[data-qa="team-member-reports-to-tc-1"]');
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain('Meera');
    });

    it('falls back to "nobody assigned yet" when the relevant target is null', async () => {
      await mount({
        member: ordinaryMember,
        managerId: 'mgr-a',
        managerName: null,
        ownerName: 'Deepak Owner',
        canRemove: true,
      });
      const row = container?.querySelector('[data-qa="team-member-reports-to-tc-1"]');
      expect(row?.textContent).toContain('nobody assigned yet');
    });

    it('a MANAGER row still reports to the owner even as an ordinary (non-pinned) member of a DIFFERENT team', async () => {
      // managerId here is someone ELSE's id - this MANAGER member is not
      // the pinned leader of THIS roster, but still reports to the owner.
      await mount({
        member: managerMember,
        managerId: 'someone-else',
        managerName: 'Someone Else',
        ownerName: 'Deepak Owner',
        canRemove: true,
      });
      const row = container?.querySelector('[data-qa="team-member-reports-to-mgr-a"]');
      expect(row?.textContent).toContain('Deepak Owner');
      expect(row?.textContent).not.toContain('Someone Else');
    });
  });
});
