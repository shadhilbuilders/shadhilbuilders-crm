// PushService - VAPID key fingerprint + server-truth status.
//
// WHY THIS EXISTS: after a VAPID rotation the server held no record of which key
// an endpoint was registered under, so it could not distinguish a live device
// from one whose sends the push service will reject forever (403
// VapidPkHashMismatch). The client could not answer it either: Safari may report
// `applicationServerKey` as null, and a precached bundle can predate any
// client-side check. The fingerprint on the row plus GET /push/status is the
// only authority, and the device uses it to repair itself.
//
// protects=  subscribe records the current key's fingerprint and reports whether
//            an existing row matches; status answers registered/keyMatches from
//            the row; a 403 VapidPkHashMismatch prunes the dead row.
// fails_when= a row created under an old key is reported as healthy (the device
//            then shows "enabled" while nothing can ever arrive), or a legacy
//            NULL fingerprint is trusted as a match.
// no_claim=  no real VAPID signing, no web-push network call, no RLS policy
//            execution - the Prisma client is faked.
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  tx: {
    pushSubscription: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
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

const PUBLIC_KEY = 'pub';
const OTHER_PUBLIC_KEY = 'some-other-key';
const fingerprint = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 16);
const CURRENT_FP = fingerprint(PUBLIC_KEY);

const ACTOR = { sub: 'user-1', organizationId: 'org-1', role: 'TELECALLER' } as never;
const DTO = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
  p256dh: 'pkey',
  auth: 'akey',
  platform: 'WEB' as const,
};

function serviceWith(): PushService {
  return new PushService({ $client: {} } as never);
}

// The publicKey getter reads process.env on EVERY call, so the env has to stay
// set for the whole file - not just while the service is constructed (a
// per-call save/restore made the fingerprint change under the test's feet).
const PREVIOUS_ENV = {
  public: process.env.VAPID_PUBLIC_KEY,
  private: process.env.VAPID_PRIVATE_KEY,
};

beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = PUBLIC_KEY;
  process.env.VAPID_PRIVATE_KEY = 'priv';
});

afterAll(() => {
  if (PREVIOUS_ENV.public === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = PREVIOUS_ENV.public;
  if (PREVIOUS_ENV.private === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = PREVIOUS_ENV.private;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.pushSubscription.findUnique.mockResolvedValue(null);
  mocks.tx.pushSubscription.upsert.mockResolvedValue({});
  mocks.tx.pushSubscription.delete.mockResolvedValue({});
});

describe('PushService.subscribe - records which VAPID key the endpoint belongs to', () => {
  it('a brand new endpoint matches by construction and stores the fingerprint', async () => {
    const result = await serviceWith().subscribe(ACTOR, DTO);

    expect(result).toEqual({ ok: true, keyMatches: true });
    expect(mocks.tx.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ vapidKeySha: CURRENT_FP }),
        update: expect.objectContaining({ vapidKeySha: CURRENT_FP }),
      }),
    );
  });

  it('an endpoint registered under the same key still matches', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue({ vapidKeySha: CURRENT_FP });

    const result = await serviceWith().subscribe(ACTOR, DTO);

    expect(result.keyMatches).toBe(true);
  });

  it('an endpoint registered under a retired key reports a mismatch', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue({
      vapidKeySha: fingerprint(OTHER_PUBLIC_KEY),
    });

    const result = await serviceWith().subscribe(ACTOR, DTO);

    expect(result.keyMatches).toBe(false);
  });

  it('a legacy row with no fingerprint is treated as unknown, not healthy', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue({ vapidKeySha: null });

    const result = await serviceWith().subscribe(ACTOR, DTO);

    expect(result.keyMatches).toBe(false);
  });
});

describe('PushService.status - the server is the only authority', () => {
  it('reports not registered when the server holds no row for the endpoint', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue(null);

    await expect(serviceWith().status(ACTOR, DTO.endpoint)).resolves.toEqual({
      registered: false,
      keyMatches: false,
    });
  });

  it('reports registered + matching for a row signed with the current key', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue({ vapidKeySha: CURRENT_FP });

    await expect(serviceWith().status(ACTOR, DTO.endpoint)).resolves.toEqual({
      registered: true,
      keyMatches: true,
    });
  });

  it('reports registered + mismatched for a row left over from a rotation', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue({
      vapidKeySha: fingerprint(OTHER_PUBLIC_KEY),
    });

    await expect(serviceWith().status(ACTOR, DTO.endpoint)).resolves.toEqual({
      registered: true,
      keyMatches: false,
    });
  });

  it('looks the row up by endpoint through the RLS-scoped client', async () => {
    mocks.tx.pushSubscription.findUnique.mockResolvedValue(null);

    await serviceWith().status(ACTOR, DTO.endpoint);

    expect(mocks.tx.pushSubscription.findUnique).toHaveBeenCalledWith({
      where: { endpoint: DTO.endpoint },
    });
  });
});

describe('PushService.deliver - a key mismatch prunes the dead row', () => {
  function withSubscription(row: Record<string, unknown> = {}): PushService {
    mocks.tx.pushSubscription.findMany.mockResolvedValue([
      { endpoint: DTO.endpoint, p256dh: 'pkey', auth: 'akey', platform: 'WEB', ...row },
    ]);
    return serviceWith();
  }

  it('a 403 VapidPkHashMismatch deletes the subscription', async () => {
    mocks.sendNotification.mockRejectedValue(
      Object.assign(new Error('forbidden'), {
        statusCode: 403,
        body: '{"reason":"VapidPkHashMismatch"}',
      }),
    );

    await withSubscription().sendToUser('user-1', { title: 't', body: 'b' }, 'org-1');

    expect(mocks.tx.pushSubscription.delete).toHaveBeenCalledWith({
      where: { endpoint: DTO.endpoint },
    });
  });

  it('any other 403 keeps the row (it may be a transient or non-key failure)', async () => {
    mocks.sendNotification.mockRejectedValue(
      Object.assign(new Error('forbidden'), { statusCode: 403, body: '{"reason":"BadJwtToken"}' }),
    );

    await withSubscription().sendToUser('user-1', { title: 't', body: 'b' }, 'org-1');

    expect(mocks.tx.pushSubscription.delete).not.toHaveBeenCalled();
  });
});
