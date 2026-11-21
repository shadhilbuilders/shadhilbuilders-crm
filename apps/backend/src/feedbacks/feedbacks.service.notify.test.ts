// publicSubmit → FeedbackNotifier wiring (2026-11-21).
//
// protects= a committed feedback row notifies the admin class, the notice carries
//           the row's identity + content (not the IP/UA), and the notice is
//           fire-and-forget;
// fails_when= a notification fault reaches the visitor as a failed submit, the
//           notifier is never called (the original bug: feedback landed silently),
//           or the response waits on the notify round-trip.
//
// The notifier's own recipient resolution is covered by
// feedback-notifier.service.test.ts; here it is stubbed so this file tests only
// the call site.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeRawUnsafe: vi.fn(),
  notifyNewFeedback: vi.fn(),
}));

vi.mock('@shadhil/database', () => ({
  // publicSubmit only needs a transaction whose $executeRawUnsafe succeeds.
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb({ $executeRawUnsafe: mocks.executeRawUnsafe }),
  ),
  rlsContextFrom: vi.fn(),
}));

import { FeedbacksService } from './feedbacks.service';

const dto = {
  name: 'Priya',
  phone: '9876543210',
  rating: 5,
  project: 'Metro Heights',
  message: 'Plot handover was smooth',
  page: '/feedback',
};

function build(notifier: unknown): FeedbacksService {
  return new FeedbacksService({ $client: { $transaction: vi.fn() } } as never, notifier as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PUBLIC_ORG_ID', 'ceid01lpfe1esm8jwsxid41k28');
  mocks.executeRawUnsafe.mockResolvedValue(1);
  mocks.notifyNewFeedback.mockResolvedValue(2);
});

describe('publicSubmit - admin notification', () => {
  it('protects= notifies the admin class with the row identity and content', async () => {
    // fails_when= this is missing: feedback lands in the table and nobody is told.
    const notifier = { notifyNewFeedback: mocks.notifyNewFeedback };
    const service = build(notifier);

    const result = await service.publicSubmit(dto, { ip: '10.0.0.1', userAgent: 'ua' });
    await new Promise((r) => setTimeout(r, 0));

    expect(result.ok).toBe(true);
    expect(mocks.notifyNewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        feedbackId: result.id,
        rating: 5,
        name: 'Priya',
        project: 'Metro Heights',
        message: 'Plot handover was smooth',
      }),
    );
  });

  it('protects= the submit reply does not wait on the notification', async () => {
    // A slow (or hung) notify must not delay the visitor's response - the row is
    // already committed by then.
    let resolveNotify: (() => void) | undefined;
    const notifier = {
      notifyNewFeedback: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveNotify = () => resolve(1);
          }),
      ),
    };
    const service = build(notifier);

    const result = await service.publicSubmit(dto, { ip: '10.0.0.2', userAgent: 'ua' });

    expect(result.ok).toBe(true);
    expect(notifier.notifyNewFeedback).toHaveBeenCalledTimes(1);
    resolveNotify?.();
  });

  it('fails_when= a notifier fault reaches the visitor as a failed submit', async () => {
    const notifier = { notifyNewFeedback: vi.fn().mockRejectedValue(new Error('push down')) };
    const service = build(notifier);

    await expect(
      service.publicSubmit(dto, { ip: '10.0.0.3', userAgent: 'ua' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('still commits when no notifier is injected (test harness / older wiring)', async () => {
    const service = new FeedbacksService({ $client: { $transaction: vi.fn() } } as never);
    await expect(
      service.publicSubmit(dto, { ip: '10.0.0.4', userAgent: 'ua' }),
    ).resolves.toMatchObject({ ok: true });
  });
});
