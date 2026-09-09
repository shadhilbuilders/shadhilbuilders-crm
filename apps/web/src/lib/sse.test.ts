// sse.ts - isAbortError contract.
//
// T-PUSH hardening (2026-09-08): the SSE reconnect loop must treat an
// aborted ticket mint as a silent component teardown, NOT a real failure
// (no reconnect, no onError). isAbortError is the discriminator. Pin it
// so a future refactor that drops the AbortError branch (re-introducing
// the "body.channel must be a non-empty string" 400 spam) fails the build.
import { describe, expect, it } from 'vitest';

import { isAbortError } from './sse';

describe('isAbortError', () => {
  it('returns true for a DOMException AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('returns true for a plain object with name AbortError (fetch polyfill shape)', () => {
    expect(isAbortError({ name: 'AbortError', message: 'The user aborted a request.' })).toBe(true);
  });

  it('returns false for a generic Error', () => {
    expect(isAbortError(new Error('backend down'))).toBe(false);
  });

  it('returns false for a 403 Forbidden (real channel-access failure)', () => {
    expect(isAbortError({ name: 'ApiError', status: 403, message: 'no access' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
