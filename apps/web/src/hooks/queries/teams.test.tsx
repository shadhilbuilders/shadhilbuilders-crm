// useTeams hook tests - T-Sidebar07 (2026-09-05).
//
// Pins the honest-state contract: when the backend teams module is
// not wired (error from the BFF), the hook returns an empty array,
// not a thrown error or a fake spinner. Consumers can render "no
// projects" without a try/catch.
//
// Test strategy: use a real QueryClientProvider (no @testing-library
// in this app per the convention in use-nav-sync.test.tsx - act +
// createRoot from react-dom/client). The api() client is mocked via
// vi.mock so the hook can be driven without a network.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/apis/client', () => ({
  api: vi.fn(),
  qs: vi.fn(),
}));

// `globalThis.IS_REACT_ACT_ENVIRONMENT` tells React this is a test env so
// `act` works with a raw createRoot (no @testing-library/react in this app).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { useTeams } from './teams';
import { api } from '@/apis/client';

const mockedApi = vi.mocked(api);

function TeamsProbe({ onResult }: { onResult: (data: ReturnType<typeof useTeams>['data']) => void }): null {
  const q = useTeams();
  onResult(q.data);
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let captured: { data: ReturnType<typeof useTeams>['data'] | undefined } = { data: undefined };

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <TeamsProbe onResult={(d) => { captured.data = d; }} />
      </QueryClientProvider>,
    );
  });
  // Wait for the query to settle (success or error).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('useTeams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { data: undefined };
  });
  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container !== null && container.parentNode !== null) {
      container.parentNode.removeChild(container);
    }
    container = null;
  });

  it('returns the array the API returns on success', async () => {
    mockedApi.mockResolvedValueOnce([
      { id: 'p1', name: 'Shadhil Metro Heights', defaultAssigneeId: null, memberCount: 5 },
      { id: 'p2', name: 'Shadhil Skyline Towers', defaultAssigneeId: null, memberCount: 3 },
    ]);
    await mount();
    expect(captured.data).toEqual([
      { id: 'p1', name: 'Shadhil Metro Heights', defaultAssigneeId: null, memberCount: 5 },
      { id: 'p2', name: 'Shadhil Skyline Towers', defaultAssigneeId: null, memberCount: 3 },
    ]);
    expect(mockedApi).toHaveBeenCalledWith('/teams');
  });

  it('returns an empty array when the API throws (module not wired, no fake spinner)', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Network error'));
    await mount();
    // The hook swallows the error in the queryFn catch and returns [].
    // Captured state should be an empty array, NOT undefined and NOT a
    // thrown error.
    expect(captured.data).toEqual([]);
  });

  it('returns an empty array when the API returns a non-array (defensive)', async () => {
    // Some backend misbehavior - the response isn't an array.
    mockedApi.mockResolvedValueOnce({ unexpected: 'shape' } as unknown as never);
    await mount();
    expect(captured.data).toEqual([]);
  });
});
