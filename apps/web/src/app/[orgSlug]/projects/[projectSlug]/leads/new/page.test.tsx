// Create-Lead page - team picker for multi-team managers, T-TEAM-
// AUTHORITATIVE (2026-09-13) follow-up. leads.service.ts's
// _createWithClient has accepted an optional `teamId` since the additive
// cutover landed, with an explicit comment that a UI picker was follow-up
// scope - this test file pins that follow-up.
//
// Mount pattern mirrors admin/teams/[teamId]/page.test.tsx: createRoot +
// act, hooks mocked via vi.mock (no QueryClientProvider needed here - this
// page's own hooks are all mocked, none call useQuery/useMutation for
// real).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useTeams: vi.fn(),
  useCreateLead: vi.fn(),
  useProjectId: vi.fn(),
  useOrgSlug: vi.fn(),
  useProjectSlug: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
}));

vi.mock('@/hooks/queries/teams', () => ({
  useTeams: mocks.useTeams,
}));

vi.mock('@/hooks/queries/crm', () => ({
  useCreateLead: mocks.useCreateLead,
}));

vi.mock('@/lib/tenant-context', () => ({
  useProjectId: mocks.useProjectId,
  useOrgSlug: mocks.useOrgSlug,
  useProjectSlug: mocks.useProjectSlug,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

import NewLeadPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<NewLeadPage />);
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
  mocks.useProjectId.mockReturnValue('proj-1');
  mocks.useOrgSlug.mockReturnValue('shadhil-builders');
  mocks.useProjectSlug.mockReturnValue('metro-heights');
  mocks.useCreateLead.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('NewLeadPage - team picker for multi-team managers', () => {
  it('a single-team manager sees no Team field (unchanged behavior)', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'mgr-1', name: 'Meera', email: 'm@x', role: 'MANAGER', teamId: 'team-a' },
    });
    mocks.useTeams.mockReturnValue({
      data: [{ id: 'team-a', name: 'Metro Sales', defaultAssigneeId: null, memberCount: 5, managerId: 'mgr-1', managerName: 'Meera' }],
    });
    await mount();
    expect(container?.querySelector('[data-qa="form-field-teamId"]')).toBeNull();
  });

  it('a non-manager (e.g. TELECALLER) never sees the Team field, even if useTeams returns rows', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'tc-1', name: 'Priya', email: 'p@x', role: 'TELECALLER', teamId: 'team-a' },
    });
    mocks.useTeams.mockReturnValue({
      data: [{ id: 'team-a', name: 'Metro Sales', defaultAssigneeId: null, memberCount: 5, managerId: 'mgr-1', managerName: 'Meera' }],
    });
    await mount();
    expect(container?.querySelector('[data-qa="form-field-teamId"]')).toBeNull();
  });

  it('a manager leading TWO teams sees the Team field (Select trigger present, teamId form field mounted)', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'mgr-1', name: 'Meera', email: 'm@x', role: 'MANAGER', teamId: 'team-a' },
    });
    mocks.useTeams.mockReturnValue({
      data: [
        { id: 'team-a', name: 'Metro Sales', defaultAssigneeId: null, memberCount: 5, managerId: 'mgr-1', managerName: 'Meera' },
        { id: 'team-b', name: 'Launch Support', defaultAssigneeId: null, memberCount: 3, managerId: 'mgr-1', managerName: 'Meera' },
        // Accessible (ordinary membership) but NOT managed - must be
        // excluded, since leads.service.ts 403s on a non-managed teamId.
        { id: 'team-c', name: 'Weekend Enquiries', defaultAssigneeId: null, memberCount: 2, managerId: 'mgr-2', managerName: 'Arjun' },
      ],
    });
    await mount();
    const fieldWrapper = container?.querySelector('[data-qa="form-field-teamId"]');
    expect(fieldWrapper).not.toBeNull();
    expect(fieldWrapper?.textContent).toContain('Team');
    // The Select's options render into a portal on open (Base UI), so
    // they aren't in the static tree - the hidden form-value carrier
    // defaulting to the sentinel is the synchronously-checkable contract
    // (see the next test); "which options were OFFERED" is covered at
    // the data layer by the `managedTeams` filter itself (only rows
    // where `managerId === user.id` reach the `options` prop at all -
    // team-c would never be passed to the Select in the first place).
    expect(container?.querySelector('#teamId[role="combobox"]')).not.toBeNull();
  });

  it('the Team field\'s hidden form value defaults to the sentinel (let the backend pick), not a specific team', async () => {
    baseMocks();
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'mgr-1', name: 'Meera', email: 'm@x', role: 'MANAGER', teamId: 'team-a' },
    });
    mocks.useTeams.mockReturnValue({
      data: [
        { id: 'team-a', name: 'Metro Sales', defaultAssigneeId: null, memberCount: 5, managerId: 'mgr-1', managerName: 'Meera' },
        { id: 'team-b', name: 'Launch Support', defaultAssigneeId: null, memberCount: 3, managerId: 'mgr-1', managerName: 'Meera' },
      ],
    });
    await mount();
    const hiddenInput = container?.querySelector('input[name="teamId"]') as HTMLInputElement | null;
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput?.value).toBe('');
  });
});
