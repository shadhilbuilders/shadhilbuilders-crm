// Users service tests - T-S hardening (Week 5).
//
// changePassword is the only piece we can exercise without a real DB
// (the bare-client SELECT/UPDATE on User + Account needs a fixture,
// and that's the role of the integration tests in apps/backend/test/).
// The pure-function path - credential hash + verify - is in
// credentials.ts and gets full coverage there.
//
// What we pin here:
//   1. happy path - actor IS target (self), correct old password,
//      returns { ok: true, mustChangePassword: false }
//   2. wrong old password → 400 BadRequestException
//   3. actor is NOT self AND NOT admin/owner → 403 ForbiddenException
//   4. unknown target user → 404 NotFoundException
//   5. successful change flips User.mustChangePassword to false
//      (verified via the User.update mock being called with the right
//      data)
//
// Test strategy: instantiate UsersService with a PrismaService stub
// that satisfies the $client surface but the methods we exercise here
// (user.findUnique, account.findUnique, account.update,
// user.update, auditLog.create) are stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

import { UsersService } from './users.service';
import { hashPassword } from './credentials';

type Actor = JwtPayload;

const NOW = Math.floor(Date.now() / 1000);

const managerActor: Actor = {
  sub: 'mgr-1',
  email: 'manager@shadhilbuilders.in',
  role: 'MANAGER',
  teamId: 'team-mgr',
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};
const telecallerActor: Actor = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  teamId: 'team-tc',
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};
const adminActor: Actor = {
  sub: 'admin-1',
  email: 'admin@shadhilbuilders.in',
  role: 'ADMIN',
  teamId: null,
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};
const ownerActor: Actor = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  teamId: null,
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};

interface StubOptions {
  user?: {
    id: string;
    email: string;
    mustChangePassword: boolean;
  } | null;
  accountPassword?: string | null;
}

function makeService(opts: StubOptions = {}) {
  const userFindUnique = vi
    .fn()
    .mockResolvedValue(
      opts.user === undefined
        ? { id: 'tc-1', email: 'telecaller@x', mustChangePassword: true }
        : opts.user,
    );
  const accountFindUnique = vi
    .fn()
    .mockResolvedValue(
      opts.accountPassword === undefined
        ? { password: 'salt:hash' }
        : { password: opts.accountPassword },
    );
  const accountUpdate = vi.fn().mockResolvedValue({});
  const userUpdate = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  // The audit row is created via withRlsContext's tx callback -
  // withRlsContext first calls tx.$executeRawUnsafe('SET LOCAL ...')
  // for the actor claim, then invokes our callback with the same tx.
  // Both calls must land on the same mock surface.
  const txMock = {
    auditLog: { create: auditCreate },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };
  const fakeClient = {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
    account: {
      findUnique: accountFindUnique,
      update: accountUpdate,
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(txMock),
  } as never;
  const prismaService = { $client: fakeClient } as never;
  return {
    service: new UsersService(prismaService),
    mocks: {
      userFindUnique,
      accountFindUnique,
      accountUpdate,
      userUpdate,
      auditCreate,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('changePassword - happy path (self)', () => {
  it('returns { ok: true, mustChangePassword: false } and flips the flag', async () => {
    // Pre-hash the same password our verify expects (we don't go
    // through real scrypt here - we just feed the stub the
    // plaintext-equals-stored check by giving it a "verified" value).
    // We stub the verify function via the account row returning
    // null → verifyPassword returns false; for a positive case we
    // need the stored hash to round-trip with verifyPassword.
    //
    // The cleanest approach: stub verifyPassword via vi.mock OR
    // call hashPassword() once to produce a real stored value.
    // We pick the latter so the test exercises the real crypto path.
    const storedHash = hashPassword('OldPass123!');
    const { service, mocks } = makeService({
      user: { id: telecallerActor.sub, email: telecallerActor.email, mustChangePassword: true },
      accountPassword: storedHash,
    });

    const result = await service.changePassword(telecallerActor, telecallerActor.sub, {
      oldPassword: 'OldPass123!',
      newPassword: 'NewPass456!',
    });

    expect(result).toEqual({ ok: true, mustChangePassword: false });
    expect(mocks.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          providerId_accountId: {
            providerId: 'credential',
            accountId: telecallerActor.sub,
          },
        },
        data: expect.objectContaining({
          issuer: 'local:credential',
        }),
      }),
    );
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: telecallerActor.sub },
      data: { mustChangePassword: false },
    });
    // Audit row written - we use the wrapped $transaction stub so
    // the audit is asserted to exist.
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: telecallerActor.sub,
          action: 'user.changePassword',
          entityType: 'User',
          entityId: telecallerActor.sub,
          before: { mustChangePassword: true },
          after: { mustChangePassword: false },
        }),
      }),
    );
  });
});

describe('changePassword - wrong old password', () => {
  it('throws BadRequestException, no writes happen', async () => {
    const storedHash = hashPassword('OldPass123!');
    const { service, mocks } = makeService({
      user: { id: telecallerActor.sub, email: telecallerActor.email, mustChangePassword: true },
      accountPassword: storedHash,
    });

    await expect(
      service.changePassword(telecallerActor, telecallerActor.sub, {
        oldPassword: 'WRONG-OLD-PASS',
        newPassword: 'NewPass456!',
      }),
    ).rejects.toMatchObject({
      // NestJS BadRequestException
      name: 'BadRequestException',
      message: 'Current password is incorrect',
    });
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe('changePassword - actor is not self and not admin/owner', () => {
  it('throws ForbiddenException', async () => {
    // Telecaller tries to change MANAGER's password - rejected.
    const { service, mocks } = makeService({
      user: { id: managerActor.sub, email: managerActor.email, mustChangePassword: false },
    });

    await expect(
      service.changePassword(telecallerActor, managerActor.sub, {
        oldPassword: 'any',
        newPassword: 'NewPass456!',
      }),
    ).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('MANAGER trying to change another user → ForbiddenException', async () => {
    const { service, mocks } = makeService({
      user: { id: 'tc-other', email: 'x@x', mustChangePassword: false },
    });

    await expect(
      service.changePassword(managerActor, 'tc-other', {
        oldPassword: 'any',
        newPassword: 'NewPass456!',
      }),
    ).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
  });

  it('ADMIN resetting a different user → ALLOWED (privileged)', async () => {
    const storedHash = hashPassword('TargetOld123!');
    const { service, mocks } = makeService({
      user: { id: managerActor.sub, email: managerActor.email, mustChangePassword: true },
      accountPassword: storedHash,
    });

    const result = await service.changePassword(
      adminActor,
      managerActor.sub,
      { oldPassword: 'TargetOld123!', newPassword: 'NewPass456!' },
    );
    expect(result).toEqual({ ok: true, mustChangePassword: false });
    expect(mocks.userUpdate).toHaveBeenCalled();
  });

  it('OWNER resetting a different user → ALLOWED (privileged)', async () => {
    const storedHash = hashPassword('TargetOld123!');
    const { service, mocks } = makeService({
      user: { id: managerActor.sub, email: managerActor.email, mustChangePassword: true },
      accountPassword: storedHash,
    });

    const result = await service.changePassword(
      ownerActor,
      managerActor.sub,
      { oldPassword: 'TargetOld123!', newPassword: 'NewPass456!' },
    );
    expect(result).toEqual({ ok: true, mustChangePassword: false });
    expect(mocks.userUpdate).toHaveBeenCalled();
  });
});

describe('changePassword - unknown target user', () => {
  it('throws NotFoundException when user.findUnique returns null', async () => {
    const { service, mocks } = makeService({ user: null });

    await expect(
      service.changePassword(adminActor, 'no-such-user', {
        oldPassword: 'any',
        newPassword: 'NewPass456!',
      }),
    ).rejects.toMatchObject({
      name: 'NotFoundException',
    });
    expect(mocks.accountFindUnique).not.toHaveBeenCalled();
  });
});

describe('changePassword - missing Account row', () => {
  it('throws BadRequestException ("Current password is incorrect") when no credential Account exists', async () => {
    // User exists but no Account row (e.g. OAuth-only sign-in) - the
    // service treats this as a wrong-password case rather than 404 to
    // avoid leaking "this user has no password set" info.
    const { service, mocks } = makeService({
      user: { id: telecallerActor.sub, email: telecallerActor.email, mustChangePassword: false },
      accountPassword: null,
    });

    await expect(
      service.changePassword(telecallerActor, telecallerActor.sub, {
        oldPassword: 'any',
        newPassword: 'NewPass456!',
      }),
    ).rejects.toMatchObject({
      name: 'BadRequestException',
      message: 'Current password is incorrect',
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});