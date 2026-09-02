/**
 * Last-Write-Wins conflict resolver.
 *
 * Default conflict-resolution policy for offline writes. Server is the
 * source of truth on `updatedAt` ties (server-clock-skew-safe).
 *
 * Per-mutation type overrides: when a future feature needs CRDT or
 * merge semantics, add a `conflictResolvers` map keyed by endpoint
 * and look it up in the replay handler (see future `apps/web/src/lib/
 * with-offline.ts` extension).
 */
export const resolveLWW = <T extends { updatedAt: number }>(client: T, server: T): T => {
  // Client wins on strictly-greater; server wins on ties (server is the
  // canonical source when clocks match).
  return client.updatedAt > server.updatedAt ? client : server;
};
