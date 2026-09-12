import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isAdminLike: (role: string) => role === 'ADMIN' || role === 'OWNER',
}));

import AdminLayout from './layout';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AdminLayout>
        <div data-qa="admin-child">Admin content</div>
      </AdminLayout>,
    );
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe('AdminLayout gate', () => {
  it('OWNER sees children', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'o-1', name: 'Owner', email: 'o@x', role: 'OWNER', teamId: null },
      isPending: false,
      error: null,
    });
    await mount();
    expect(container?.innerHTML ?? '').toContain('Admin content');
  });

  it('ADMIN sees children', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'a-1', name: 'Admin', email: 'a@x', role: 'ADMIN', teamId: null },
      isPending: false,
      error: null,
    });
    await mount();
    expect(container?.innerHTML ?? '').toContain('Admin content');
  });

  it('MANAGER is not authorized', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 'm-1', name: 'Mgr', email: 'm@x', role: 'MANAGER', teamId: 't1' },
      isPending: false,
      error: null,
    });
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Not authorized');
    expect(html).not.toContain('Admin content');
  });

  it('TELECALLER is not authorized', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: { id: 't-1', name: 'Tc', email: 't@x', role: 'TELECALLER', teamId: 't1' },
      isPending: false,
      error: null,
    });
    await mount();
    expect(container?.innerHTML ?? '').toContain('Not authorized');
  });
});
