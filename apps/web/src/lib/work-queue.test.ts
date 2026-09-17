// Work-queue ordering tests (T-DASH-QUEUE, 2026-09-16).
//
// The ordering is the mechanism that keeps one dashboard usable instead of
// hiding things behind clicks, so it gets pinned. Note what is deliberately
// NOT tested here: the tier boundaries (10/20/30 min) are already pinned by
// lib/leads.test.ts. Re-testing OVERDUE_AFTER_MIN here would duplicate the
// owner of that rule and risk two sources disagreeing about what "overdue"
// means - the exact failure this module exists to avoid. Only the ORDER is
// this module's contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderQueue, queueBucket, queueReason, QUEUE_BUCKET } from './work-queue';

const NOW = new Date('2026-09-16T12:00:00.000Z');

function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

beforeEach(() => {
  // Moves the single source of truth: isOverdue / leadAgeTier read Date.now().
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('queueBucket', () => {
  it('puts an overdue NEW lead in the first bucket', () => {
    expect(queueBucket({ status: 'NEW', createdAt: minutesAgo(45) })).toBe(
      QUEUE_BUCKET.OVERDUE_NEW,
    );
  });

  it('keeps a fresh NEW lead out of the overdue bucket', () => {
    expect(queueBucket({ status: 'NEW', createdAt: minutesAgo(5) })).toBe(QUEUE_BUCKET.NEW);
  });

  it('maps each telecaller-lane state to its own bucket', () => {
    expect(queueBucket({ status: 'CONTACTED', createdAt: minutesAgo(5) })).toBe(
      QUEUE_BUCKET.CONTACTED,
    );
    expect(queueBucket({ status: 'VISIT_REQUESTED', createdAt: minutesAgo(5) })).toBe(
      QUEUE_BUCKET.VISIT_REQUESTED,
    );
    expect(queueBucket({ status: 'VISIT_SCHEDULED', createdAt: minutesAgo(5) })).toBe(
      QUEUE_BUCKET.VISIT_SCHEDULED,
    );
  });

  it('treats NO_SHOW and RESCHEDULED as re-engagement (the telecaller owns them again)', () => {
    expect(queueBucket({ status: 'NO_SHOW', createdAt: minutesAgo(5) })).toBe(
      QUEUE_BUCKET.RE_ENGAGE,
    );
    expect(queueBucket({ status: 'RESCHEDULED', createdAt: minutesAgo(5) })).toBe(
      QUEUE_BUCKET.RE_ENGAGE,
    );
  });

  it('falls back to OTHER for exec-lane and terminal states', () => {
    expect(queueBucket({ status: 'WON', createdAt: minutesAgo(5) })).toBe(QUEUE_BUCKET.OTHER);
    expect(queueBucket({ status: 'NEGOTIATION', createdAt: minutesAgo(5) })).toBe(
      QUEUE_BUCKET.OTHER,
    );
  });

  it('never fabricates urgency for a missing status or date', () => {
    expect(queueBucket({})).toBe(QUEUE_BUCKET.OTHER);
    expect(queueBucket({ status: 'NEW' })).toBe(QUEUE_BUCKET.NEW);
  });
});

describe('orderQueue', () => {
  it('sorts an overdue lead above everything else, regardless of input order', () => {
    const rows = [
      { id: 'fresh', status: 'NEW', createdAt: minutesAgo(2) },
      { id: 'requested', status: 'VISIT_REQUESTED', createdAt: minutesAgo(1) },
      { id: 'overdue', status: 'NEW', createdAt: minutesAgo(90) },
    ];
    expect(orderQueue(rows).map((r) => r.id)).toEqual(['overdue', 'fresh', 'requested']);
  });

  it('orders the buckets by urgency for the telecaller lane', () => {
    const rows = [
      { id: 'scheduled', status: 'VISIT_SCHEDULED', createdAt: minutesAgo(1) },
      { id: 'noshow', status: 'NO_SHOW', createdAt: minutesAgo(1) },
      { id: 'contacted', status: 'CONTACTED', createdAt: minutesAgo(1) },
      { id: 'requested', status: 'VISIT_REQUESTED', createdAt: minutesAgo(1) },
      { id: 'overdue', status: 'NEW', createdAt: minutesAgo(60) },
      { id: 'new', status: 'NEW', createdAt: minutesAgo(1) },
    ];
    expect(orderQueue(rows).map((r) => r.id)).toEqual([
      'overdue',
      'new',
      'contacted',
      'requested',
      'scheduled',
      'noshow',
    ]);
  });

  it('puts the longest-waiting lead first inside a bucket', () => {
    const rows = [
      { id: 'newer', status: 'NEW', createdAt: minutesAgo(5) },
      { id: 'older', status: 'NEW', createdAt: minutesAgo(25) },
      { id: 'oldest', status: 'NEW', createdAt: minutesAgo(20) },
    ];
    expect(orderQueue(rows).map((r) => r.id)).toEqual(['older', 'oldest', 'newer']);
  });

  it('keeps the server order for exact ties rather than shuffling', () => {
    const same = minutesAgo(5);
    const rows = [
      { id: 'first', status: 'NEW', createdAt: same },
      { id: 'second', status: 'NEW', createdAt: same },
      { id: 'third', status: 'NEW', createdAt: same },
    ];
    expect(orderQueue(rows).map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('returns a NEW array and does not mutate the input', () => {
    const rows = [
      { id: 'a', status: 'VISIT_SCHEDULED', createdAt: minutesAgo(1) },
      { id: 'b', status: 'NEW', createdAt: minutesAgo(60) },
    ];
    const snapshot = rows.map((r) => r.id);
    const out = orderQueue(rows);
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it('returns an empty array for an empty queue (the new-day case)', () => {
    expect(orderQueue([])).toEqual([]);
  });

  it('carries the full row through, not just the sort keys', () => {
    // The page renders name/phone/ownerName off these rows; a projection that
    // dropped fields would blank the queue while still sorting correctly.
    const rows = [{ id: 'x', name: 'Asha', phone: '9876543210', status: 'NEW', createdAt: minutesAgo(1) }];
    const out = orderQueue(rows);
    expect(out[0]).toEqual(rows[0]);
  });
});

describe('queueReason', () => {
  it('names the SLA breach on an overdue lead', () => {
    expect(queueReason({ status: 'NEW', createdAt: minutesAgo(40) })).toContain('Overdue');
  });

  it('tells the telecaller what the next action is, in plain words', () => {
    expect(queueReason({ status: 'VISIT_REQUESTED', createdAt: minutesAgo(1) })).toContain(
      'book it',
    );
    expect(queueReason({ status: 'NO_SHOW', createdAt: minutesAgo(1) })).toContain('re-engage');
    expect(queueReason({ status: 'VISIT_SCHEDULED', createdAt: minutesAgo(1) })).toContain(
      'confirm',
    );
  });

  it('returns nothing for states the telecaller lane does not own', () => {
    expect(queueReason({ status: 'WON', createdAt: minutesAgo(1) })).toBe('');
  });

  it('does not claim a deadline on a non-NEW lead', () => {
    // Decision 4: age-based deadlines are NEW-only. A 90-minute-old CONTACTED
    // lead must not be described as overdue.
    const reason = queueReason({ status: 'CONTACTED', createdAt: minutesAgo(90) });
    expect(reason).not.toContain('Overdue');
  });
});
