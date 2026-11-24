// MediaAccessService - the byte-level wall behind GET /api/media/:key.
//
// protects= bytes are served only when an owning row is VISIBLE to the caller
//           under their own RLS context; a foreign-org key and a key with no
//           visible owner both 404;
// fails_when= a CUSTOMER (or any session) reads a key whose row RLS hides from
//           them, a cross-org key is served, or the legacy mediaUrl rows stop
//           resolving;
// no_claim= does NOT exercise real RLS (the policies themselves are proven in
//           packages/database/test/*): these tests pin the RULE and the query
//           shape, with the RLS transaction stubbed to a fake tx.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';

const mocks = vi.hoisted(() => ({
  tx: {
    progressPhoto: { findFirst: vi.fn() },
    message: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  /** Records the RLS context the lookup ran under. */
  lastCtx: null as null | { userId: string; role: string; organizationId: string },
}));

vi.mock('@shadhil/database', () => ({
  rlsContextFrom: vi.fn((a: { sub: string; role: string; organizationId: string }) => ({
    userId: a.sub,
    role: a.role,
    organizationId: a.organizationId,
  })),
  withRlsContext: vi.fn(
    async (
      _c: unknown,
      ctx: { userId: string; role: string; organizationId: string },
      cb: (t: unknown) => unknown,
    ) => {
      mocks.lastCtx = ctx;
      return cb(mocks.tx);
    },
  ),
}));

import { MediaAccessService } from './media-access.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const OTHER = 'cyid01lpfe1esm8jwsxid41k29';
const PHOTO_KEY = `${ORG}/abc123/site.jpg`;

const actor = (role: JwtPayload['role'] = 'ADMIN', organizationId = ORG): JwtPayload => ({
  sub: 'u-1',
  email: 'u@x.in',
  role,
  organizationId,
  iat: 0,
  exp: 0,
  iss: 'shadhil-bff',
});

const svc = () => new MediaAccessService({ $client: {} } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lastCtx = null;
  mocks.tx.progressPhoto.findFirst.mockResolvedValue(null);
  mocks.tx.message.findFirst.mockResolvedValue(null);
  mocks.tx.user.findFirst.mockResolvedValue(null);
});

describe('resolveOwner', () => {
  it('attributes a key to the progress photo that owns it', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ id: 'photo-1' });
    await expect(svc().resolveOwner(actor(), PHOTO_KEY)).resolves.toBe('ProgressPhoto');
  });

  it('attributes a chat attachment key to its message', async () => {
    mocks.tx.message.findFirst.mockResolvedValue({ id: 'msg-1' });
    await expect(svc().resolveOwner(actor(), PHOTO_KEY)).resolves.toBe('Message');
  });

  it('serves a video poster, which the row stores in posterKey not key', async () => {
    // Measured on 2026-11-24 against a recorded clip: the clip's own key came
    // back 200 and its poster 404, because only `key` was matched. Every video
    // tile and every WhatsApp site-update image points at the poster.
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ id: 'photo-1' });
    await expect(svc().resolveOwner(actor(), PHOTO_KEY)).resolves.toBe('ProgressPhoto');

    const arg = mocks.tx.progressPhoto.findFirst.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(arg.where.OR).toEqual([{ key: PHOTO_KEY }, { posterKey: PHOTO_KEY }]);
  });

  it('resolves a legacy row that stored only the BFF path', async () => {
    mocks.tx.message.findFirst.mockResolvedValue({ id: 'msg-legacy' });
    await svc().resolveOwner(actor(), PHOTO_KEY);

    const arg = mocks.tx.message.findFirst.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // Both shapes must be searched or every attachment older than 2026-09-18
    // would 404 after this fix.
    expect(arg.where.OR).toHaveLength(2);
    expect(arg.where.OR[0]).toEqual({ mediaKey: PHOTO_KEY });
    expect(arg.where.OR[1]).toEqual({
      mediaUrl: `/api/bff/media/${encodeURIComponent(PHOTO_KEY)}`,
    });
  });

  it('fails_when= a key owned by no visible row resolves to an owner', async () => {
    await expect(svc().resolveOwner(actor(), PHOTO_KEY)).resolves.toBeNull();
  });

  // 2026-11-24: the user's photo. Before this arm existed, an avatar key was
  // owned by no visible row, so every avatar 404'd even though the key was in
  // the caller's own org.
  it('attributes an avatar key to the user whose photo it is', async () => {
    mocks.tx.user.findFirst.mockResolvedValue({ id: 'u-1' });
    await expect(svc().resolveOwner(actor(), PHOTO_KEY)).resolves.toBe('User');
  });

  it('protects= an avatar lookup can never cross an org boundary', async () => {
    mocks.tx.user.findFirst.mockResolvedValue({ id: 'u-1' });
    await svc().resolveOwner(actor('ADMIN', ORG), PHOTO_KEY);

    // `User` carries no RLS policy at all (policies.sql grants the app role
    // straight through), so this filter is the ONLY tenant wall on the arm.
    // Drop it and one org's avatar key resolves another org's row.
    const arg = mocks.tx.user.findFirst.mock.calls[0]?.[0] as {
      where: { avatarKey: string; organizationId: string };
    };
    expect(arg.where).toEqual({ avatarKey: PHOTO_KEY, organizationId: ORG });
  });

  // The whole point: the lookup must inherit the CALLER's context, so RLS (not
  // this code) decides what is visible.
  it('runs the lookup under the caller RLS context, never a service identity', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ id: 'photo-1' });
    await svc().resolveOwner(actor('CUSTOMER'), PHOTO_KEY);
    expect(mocks.lastCtx).toEqual({ userId: 'u-1', role: 'CUSTOMER', organizationId: ORG });
  });
});

describe('assertReadable', () => {
  it('protects= a key with a visible owning row is served', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ id: 'photo-1' });
    await expect(svc().assertReadable(actor('ENGINEER'), PHOTO_KEY)).resolves.toBeUndefined();
  });

  // The regression this fix exists for: the row is hidden by RLS, so the
  // lookup returns nothing and the bytes must NOT be served.
  it('fails_when= a row hidden by RLS still yields its bytes (404)', async () => {
    // Stub models the RLS deny: the query runs, matches nothing.
    mocks.tx.progressPhoto.findFirst.mockResolvedValue(null);
    mocks.tx.message.findFirst.mockResolvedValue(null);

    await expect(svc().assertReadable(actor('CUSTOMER'), PHOTO_KEY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('protects= an avatar key in the caller org serves its bytes', async () => {
    mocks.tx.user.findFirst.mockResolvedValue({ id: 'u-1' });
    await expect(svc().assertReadable(actor('ENGINEER'), PHOTO_KEY)).resolves.toBeUndefined();
  });

  it('fails_when= a cross-org key is served (404 before any query)', async () => {
    await expect(
      svc().assertReadable(actor('ADMIN', ORG), `${OTHER}/abc123/site.jpg`),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Cheap pre-check: no transaction for an obviously foreign key.
    expect(mocks.lastCtx).toBeNull();
  });

  it('fails_when= an unparseable key reaches the resolver', async () => {
    for (const bad of ['', '/', 'site.jpg', `${ORG}/../x.jpg`]) {
      await expect(svc().assertReadable(actor(), bad)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('answers 404, never 403 - a 403 would confirm the key exists', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue(null);
    mocks.tx.message.findFirst.mockResolvedValue(null);
    const err = await svc()
      .assertReadable(actor('TELECALLER'), PHOTO_KEY)
      .catch((e: unknown) => e);
    expect((err as NotFoundException).getStatus()).toBe(404);
  });

  it('a chat attachment is readable when its message is visible', async () => {
    mocks.tx.message.findFirst.mockResolvedValue({ id: 'msg-1' });
    await expect(svc().assertReadable(actor('MANAGER'), PHOTO_KEY)).resolves.toBeUndefined();
  });
});
