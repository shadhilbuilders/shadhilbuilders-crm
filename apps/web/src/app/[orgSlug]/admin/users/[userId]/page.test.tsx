// /admin/users/[userId] - the specific-user page the Users table opens.
//
// It is a thin route: it reads the `userId` route param and hands it to the
// shared `UserDetailView` panel (identity, team, reports-to, projects,
// leads). The panel's own state matrix (loading / error / not-authorized)
// is covered by UserDetailView's own test, so this file pins the ROUTE
// contract only: the right user id reaches the panel.
//
// The page has no `mounted` gate of its own (the panel owns that), so the
// mock replaces the panel with a marker and the route is mounted with
// createRoot + act (the repo pattern).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  params: {} as { userId?: string },
  useUser: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => mocks.params,
}));

// The page reads the user's name for the title through the same `useUser`
// query the panel uses. Mocked here (react-query needs a provider this
// test does not set up); the panel is stubbed separately.
vi.mock('@/hooks/queries/users', () => ({
  useUser: mocks.useUser,
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
}));

vi.mock('@/components/users/UserDetailView', () => ({
  UserDetailView: ({ userId }: { userId: string }) => (
    <div data-qa="detail-stub">detail for {userId}</div>
  ),
}));

import UserDetailPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<UserDetailPage />);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  mocks.params = {};
  mocks.useUser.mockReset();
});

describe('UserDetailPage - /admin/users/[userId]', () => {
  it('renders the detail view for the user id in the route', async () => {
    mocks.params = { userId: 'user-42' };
    mocks.useUser.mockReturnValue({
      data: { id: 'user-42', name: 'Priya Sharma' },
      isLoading: false,
      error: null,
    });
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('detail for user-42');
    // The chrome: the user's name titles the page, and the breadcrumb
    // points back at the Users table.
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('data-qa="back-to-users"');
  });

  it('renders nothing when the route param is missing', async () => {
    mocks.params = {};
    mocks.useUser.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).not.toContain('data-qa="detail-stub"');
  });
});
