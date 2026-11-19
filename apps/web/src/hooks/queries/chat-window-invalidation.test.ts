// @vitest-environment node
// T-WA-WINDOW (2026-11-19): an inbound customer message must refresh the reply-window
// state, not just the message list.
//
// The live symptom: the customer's reply appeared in the thread immediately (messages
// ride the realtime SSE channel) while the composer still showed "the 24-hour WhatsApp
// reply window is closed", because `useChatThreadState` only polls every 60 seconds and
// nothing invalidated it. The operator reasonably read that as the integration being
// broken, when the server was already answering `windowOpen: true`.
//
// Tested through the exported helper rather than a rendered hook: this repo has no
// @testing-library/react, so the contract under test is "which caches get dropped"
// (same approach as booking-cache-invalidation.test.ts).
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';

import { invalidateChatSideEffects } from './crm';

/** The unique query-key roots an invalidation touched (deduped, sorted). */
function invalidatedRoots(client: QueryClient): string[] {
  const roots = new Set(
    client
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => String(q.queryKey[0])),
  );
  return [...roots].sort();
}

const LEAD = 'ld1';

describe('a chat event refreshes the thread AND its reply-window state', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const key of [
      ['chat', LEAD, 'CUSTOMER'],
      ['chat', LEAD, 'INTERNAL'],
      ['chat-state', LEAD],
      ['chat-state', 'other-lead'],
      ['leads'],
    ]) {
      client.setQueryData(key, []);
    }
  });

  it('drops the message list and the window state for that lead', () => {
    invalidateChatSideEffects(client, LEAD, 'CUSTOMER');

    const stateQueries = client
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[0] === 'chat-state');

    // The regression: without the state invalidation the composer keeps showing the
    // closed-window notice for up to a minute after the customer writes.
    expect(stateQueries.find((q) => q.queryKey[1] === LEAD)?.state.isInvalidated).toBe(true);
    expect(invalidatedRoots(client)).toContain('chat');
  });

  it('leaves another lead\u2019s window state alone', () => {
    invalidateChatSideEffects(client, LEAD, 'CUSTOMER');

    const other = client
      .getQueryCache()
      .getAll()
      .find((q) => q.queryKey[0] === 'chat-state' && q.queryKey[1] === 'other-lead');

    expect(other?.state.isInvalidated).toBe(false);
  });
});
