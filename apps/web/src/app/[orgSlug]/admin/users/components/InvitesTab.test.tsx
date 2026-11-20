// InvitesTab (2026-11-20) - the four states.
//
// Each state is asserted separately because "it renders something" would pass
// for a spinner where an error belongs. The error case also pins `role="alert"`:
// the frontend rule is that errors are ANNOUNCED, not merely painted red.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { InviteRow } from '@shadhil/api-types';

import { InvitesTab } from './InvitesTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useInvites: vi.fn(),
}));

vi.mock('@/hooks/queries/invites', () => ({
  useInvites: mocks.useInvites,
  useResendInvite: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn(), data: undefined }),
  useRevokeInvite: () => ({ mutate: vi.fn(), isPending: false }),
}));

// jsdom has no matchMedia; the hook falls back to `false` (the full column
// set), which is the safe branch. Defined so the compact path is reachable too.
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

const ROW: InviteRow = {
  id: 'inv-1',
  email: 'ramesh@example.in',
  name: 'Ramesh Kumar',
  phone: '919876543210',
  role: 'TELECALLER',
  team: { id: 't-1', name: 'Team Alpha' },
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  invitedBy: { id: 'u-1', name: 'Admin', email: 'admin@example.in' },
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

function mount(): HTMLDivElement {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <InvitesTab createTrigger={<button type="button">Invite staff</button>} />
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('InvitesTab - the four states', () => {
  it('LOADING renders the table skeleton, not a spinner', () => {
    mocks.useInvites.mockReturnValue({
      isLoading: true,
      isFetching: true,
      data: undefined,
      error: null,
      refetch: vi.fn(),
    });
    const el = mount();
    // The shared Skeleton primitive is the repo's loading idiom for content.
    expect(el.querySelector('[data-qa="skeleton"], [data-qa="skeleton-table"]')).not.toBeNull();
  });

  it('EMPTY shows copy plus the create CTA, never a blank panel', () => {
    mocks.useInvites.mockReturnValue({
      isLoading: false,
      isFetching: false,
      data: { rows: [], total: 0 },
      error: null,
      refetch: vi.fn(),
    });
    const el = mount();
    expect(el.textContent).toContain('No invites yet');
    // The CTA is present so the empty state is not a dead end.
    expect(el.textContent).toContain('Invite staff');
  });

  it('ERROR announces itself with role=alert and offers a retry', () => {
    const refetch = vi.fn();
    mocks.useInvites.mockReturnValue({
      isLoading: false,
      isFetching: false,
      data: undefined,
      error: new Error('boom'),
      refetch,
    });
    const el = mount();

    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't load invites");

    const retry = el.querySelector<HTMLButtonElement>('[data-qa="invites-retry-button"]');
    expect(retry).not.toBeNull();
    act(() => retry!.click());
    expect(refetch).toHaveBeenCalled();
  });

  it('POPULATED renders the row and its status as text', () => {
    mocks.useInvites.mockReturnValue({
      isLoading: false,
      isFetching: false,
      data: { rows: [ROW], total: 1 },
      error: null,
      refetch: vi.fn(),
    });
    const el = mount();
    expect(el.textContent).toContain('Ramesh Kumar');
    // Status must be readable as a word, not only as a colour.
    expect(el.textContent).toContain('Pending');
    // The filter control is present - "no filtering" is the anti-pattern for a
    // table that will accumulate history. Asserted via the combobox's presence
    // in the toolbar (the placeholder lives on an inner input the Combobox
    // portal may not mount synchronously in jsdom).
    expect(el.querySelector('[role="combobox"], input') !== null).toBe(true);
  });
});
