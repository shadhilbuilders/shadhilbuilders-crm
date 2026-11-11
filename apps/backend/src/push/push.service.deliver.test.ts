// PushService delivery contract (issue #8 slice 2, AC9).
//
// Covers the two halves of AC9 that live in PushService rather than in
// PortalNotifier:
//   1. an expired subscription (web-push 404/410) is DELETED, so the app stops
//      retrying a device that will never receive again;
//   2. a failed delivery never breaks the caller - the upload has already
//      committed and the staff member's 201 must not turn into a 500 because a
//      buyer's phone is gone.
//
// protects= 410/404 drops the row; other failures keep it; delivery never
//           throws out of sendToUsers.
// fails_when= an expired endpoint is retried forever, or a push failure
//           propagates to the request that triggered it.
// no_claim= does NOT exercise the real web-push library, VAPID signing, or the
//           RLS policies behind PushSubscription (push_subscription_* policies
//           are owner-scoped; this is a unit test with a fake tx).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  tx: {
    pushSubscription: { findMany: vi.fn(), delete: vi.fn(async () => ({})) },
    pushNotification: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.sendNotification },
}));

vi.mock('@shadhil/database', () => ({
  rlsContextFrom: vi.fn((a: unknown) => a),
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb(mocks.tx),
  ),
}));

import { PushService } from './push.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const PAYLOAD = { title: 'New photos for A-101', body: 'Plinth November 2026', url: '/portal?photo=p1' };
const SUB = {
  endpoint: 'https://push.example/abc',
  p256dh: 'pkey',
  auth: 'akey',
  platform: 'WEB' as const,
};

/** A service with VAPID keys present, so `enabled` is true and delivery runs. */
function enabledService(): PushService {
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  try {
    return new PushService({ $client: {} } as never);
  } finally {
    if (prevPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = prevPriv;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.pushSubscription.findMany.mockResolvedValue([SUB]);
  mocks.tx.pushSubscription.delete.mockResolvedValue({});
  mocks.tx.pushNotification.create.mockResolvedValue({});
  mocks.sendNotification.mockResolvedValue({ statusCode: 201 });
});

describe('PushService delivery contract', () => {
  it('protects= a delivered push records a DELIVERED notification row', async () => {
    const n = await enabledService().sendToUsers(ORG, ['cust-1'], PAYLOAD);

    expect(n).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.tx.pushNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'cust-1', organizationId: ORG, status: 'DELIVERED' }),
    });
    expect(mocks.tx.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('protects= a 410 marks the subscription for deletion (AC9 exact)', async () => {
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));

    const n = await enabledService().sendToUsers(ORG, ['cust-1'], PAYLOAD);

    expect(n).toBe(1); // the subscription was attempted
    expect(mocks.tx.pushSubscription.delete).toHaveBeenCalledWith({ where: { endpoint: SUB.endpoint } });
  });

  it('protects= a 404 is treated the same as 410 (the other expiry signal)', async () => {
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }));

    await enabledService().sendToUsers(ORG, ['cust-1'], PAYLOAD);

    expect(mocks.tx.pushSubscription.delete).toHaveBeenCalledTimes(1);
  });

  it('fails_when= a transient failure deletes a still-valid subscription (must keep it)', async () => {
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));

    await enabledService().sendToUsers(ORG, ['cust-1'], PAYLOAD);

    expect(mocks.tx.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('fails_when= a push failure escapes to the caller (upload must stay 201)', async () => {
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));

    await expect(enabledService().sendToUsers(ORG, ['cust-1'], PAYLOAD)).resolves.toBe(1);
  });

  it('fails_when= a delete that itself fails masks the delivery result', async () => {
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    mocks.tx.pushSubscription.delete.mockRejectedValue(new Error('db down'));

    await expect(enabledService().sendToUsers(ORG, ['cust-1'], PAYLOAD)).resolves.toBe(1);
  });

  it('no-ops entirely when VAPID keys are absent (push disabled)', async () => {
    const prevPub = process.env.VAPID_PUBLIC_KEY;
    const prevPriv = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const n = await new PushService({ $client: {} } as never).sendToUsers(ORG, ['cust-1'], PAYLOAD);
      expect(n).toBe(0);
      expect(mocks.sendNotification).not.toHaveBeenCalled();
    } finally {
      if (prevPub !== undefined) process.env.VAPID_PUBLIC_KEY = prevPub;
      if (prevPriv !== undefined) process.env.VAPID_PRIVATE_KEY = prevPriv;
    }
  });
});
