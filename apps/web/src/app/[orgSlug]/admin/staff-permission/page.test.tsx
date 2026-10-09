// Staff Permission page (/admin/staff-permission).
//
// Pins the render branches:
//   1. session pending                → <Skeleton>
//   2. non-admin (TELECALLER/MANAGER) → "Not authorized" panel
//   3. admin, no ?userId=             → picker + "Select a staff member" prompt
//   4. admin, ?userId=user-9          → picker + UserDetailView for that user
//   5. picking a user                 → router.replace(.../staff-permission?userId=<id>)
//   6. clearing the picker            → router.replace(.../staff-permission)
//
// The page has a `mounted` gate (flips true in useEffect) - mount with
// createRoot + act, same pattern as users/page.test.tsx. The picker and the
// detail view have their own tests, so both are stubbed with markers.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  replace: vi.fn(),
  search: { current: '' },
  picker: {
    onValueChange: undefined as ((id: string) => void) | undefined,
  },
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}));

vi.mock('@/components/users/UserPicker', () => ({
  UserPicker: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (id: string) => void;
  }) => {
    mocks.picker.onValueChange = onValueChange;
    return <div data-qa="picker-stub">picker value={value}</div>;
  },
}));

vi.mock('@/components/users/UserDetailView', () => ({
  UserDetailView: ({ userId }: { userId: string }) => (
    <div data-qa="detail-stub">detail for {userId}</div>
  ),
}));

import StaffPermissionPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<StaffPermissionPage />);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  mocks.useSessionUser.mockReset();
  mocks.replace.mockReset();
  mocks.search.current = '';
  mocks.picker.onValueChange = undefined;
});

const admin = { user: { id: 'u-1', role: 'ADMIN' }, isPending: false };

describe('StaffPermissionPage', () => {
  it('session pending renders a skeleton', async () => {
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true });
    await mount();
    expect(container?.innerHTML).toContain('data-slot="skeleton"');
  });

  it('non-admin sees the "Not authorized" panel and no picker', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'u-2', role: 'MANAGER' },
      isPending: false,
    });
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
    expect(html).not.toContain('data-qa="picker-stub"');
  });

  it('admin with no selection sees the picker and the select-a-user prompt', async () => {
    mocks.useSessionUser.mockReturnValue(admin);
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Staff Permission');
    expect(html).toContain('data-qa="picker-stub"');
    expect(html).toContain('Select a staff member to view their details');
    expect(html).not.toContain('data-qa="detail-stub"');
  });

  it('admin with ?userId= sees the detail view for that user', async () => {
    mocks.useSessionUser.mockReturnValue(admin);
    mocks.search.current = 'userId=user-9';
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('detail for user-9');
    expect(html).toContain('picker value=user-9');
    expect(html).not.toContain('Select a staff member to view their details');
  });

  it('picking a user puts the id in the URL', async () => {
    mocks.useSessionUser.mockReturnValue(admin);
    await mount();
    await act(async () => {
      mocks.picker.onValueChange?.('user-3');
    });
    expect(mocks.replace).toHaveBeenCalledWith(
      '/shadhil-builders/admin/staff-permission?userId=user-3',
    );
  });

  it('clearing the picker removes the id from the URL', async () => {
    mocks.useSessionUser.mockReturnValue(admin);
    mocks.search.current = 'userId=user-9';
    await mount();
    await act(async () => {
      mocks.picker.onValueChange?.('');
    });
    expect(mocks.replace).toHaveBeenCalledWith(
      '/shadhil-builders/admin/staff-permission',
    );
  });
});
