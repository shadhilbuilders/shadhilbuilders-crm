// Pure-function tests for the feedback service's cursor codec + per-IP
// rate limiter (no Nest/Prisma/DB dependency - `_internal` exports them),
// per the shadhil-crm-dev skill rule "extract pure-function business logic
// to *.ts + *.test.ts". See src/feedbacks/feedbacks.service.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _internal } from './feedbacks.service';

const { encodeCursor, decodeCursor, allowPublicSubmit } = _internal;

describe('feedback cursor codec', () => {
  it('round-trips a (createdAt, id) pair through base64url', () => {
    const created = new Date('2026-09-11T07:00:00.000Z');
    const id = 'cm_feedback_1';
    const cursor = encodeCursor(created, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(id);
    expect(decoded!.createdAt.toISOString()).toBe(created.toISOString());
  });

  it('is opaque and non-empty', () => {
    const cursor = encodeCursor(new Date(), 'abc_123');
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
  });

  it('returns null for garbage / malformed cursors', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64-!!')).toBeNull();
    // Valid base64url but no '|' separator
    const noSep = Buffer.from('justanid').toString('base64url');
    expect(decodeCursor(noSep)).toBeNull();
    // Separator but non-date left side
    const badDate = Buffer.from('nonsense|abc').toString('base64url');
    expect(decodeCursor(badDate)).toBeNull();
  });
});

describe('feedback per-IP rate limiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the per-IP limit then rejects within the window', () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 10; i++) {
      expect(allowPublicSubmit(ip)).toBe(true);
    }
    // 11th is over the limit in the same window
    expect(allowPublicSubmit(ip)).toBe(false);
  });

  it('allows a different IP independently', () => {
    const a = '10.0.0.1';
    for (let i = 0; i < 10; i++) allowPublicSubmit(a);
    expect(allowPublicSubmit(a)).toBe(false);
    expect(allowPublicSubmit('10.0.0.2')).toBe(true);
  });

  it('resets after the window elapses', () => {
    vi.useFakeTimers();
    const ip = '10.0.0.1';
    for (let i = 0; i < 10; i++) allowPublicSubmit(ip);
    expect(allowPublicSubmit(ip)).toBe(false);
    // Advance past the 60s window
    vi.advanceTimersByTime(60_001);
    expect(allowPublicSubmit(ip)).toBe(true);
  });
});
