// @vitest-environment node
// T-BOOK-LEADSYNC (2026-09-15): a booking write moves `Lead.state` on the
// server, so every booking mutation must also drop the lead caches. Without it
// the leads page/board keeps showing the pre-booking state for up to the
// 5-minute staleTime - the client-side twin of the drift this task fixed.
//
// This repo has no @testing-library/react, and hook tests here cover the pure
// rule rather than a rendered component (see projects.test.ts). So the
// invalidation wiring is exercised through the exported helper contract: the
// hooks all funnel into `invalidateBookingSideEffects`, which is what these
// tests drive through a real QueryClient seeded with the caches in play.
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, beforeEach } from 'vitest';

import { invalidateBookingSideEffects } from './crm';

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

describe('booking writes invalidate the lead caches (T-BOOK-LEADSYNC)', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed every cache a booking write can affect.
    for (const key of [
      ['bookings'],
      ['bookings', 'bk1'],
      ['inventory', 'units'],
      ['leads'],
      ['lead', 'ld1'],
      ['dashboard-stats'],
      ['dashboard-exceptions'],
    ]) {
      client.setQueryData(key, []);
    }
  });

  it('refreshes bookings, inventory, leads AND KPI surfaces - including the single lead', () => {
    invalidateBookingSideEffects(client, 'bk1', 'ld1');
    expect(invalidatedRoots(client)).toEqual([
      'bookings',
      'dashboard-exceptions',
      'dashboard-stats',
      'inventory',
      'lead',
      'leads',
    ]);
  });

  it('refreshes the leads LIST even when the lead id is unknown', () => {
    // The delete path only has the booking id: the row (and its leadId) is gone
    // by the time the response arrives. The list - which is what the pipeline
    // board and the leads grid read - must still be dropped.
    invalidateBookingSideEffects(client, 'bk1');
    const roots = invalidatedRoots(client);
    expect(roots).toContain('leads');
    expect(roots).toContain('inventory');
    expect(roots).toContain('dashboard-stats');
  });

  it('the create path (no booking id yet) still refreshes leads', () => {
    invalidateBookingSideEffects(client, undefined, 'ld1');
    expect(invalidatedRoots(client)).toContain('leads');
    expect(invalidatedRoots(client)).toContain('dashboard-stats');
  });

  it('ignores an empty lead id rather than invalidating the ["lead"] root', () => {
    invalidateBookingSideEffects(client, undefined, '');
    expect(invalidatedRoots(client)).not.toContain('lead');
  });
});
