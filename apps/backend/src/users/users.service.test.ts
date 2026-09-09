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

describe('teamMembers - mention-picker source (T-CHAT-INTERNAL)', () => {
  function makeTeamService() {
    const teamFindFirst = vi.fn();
    const teamFindUnique = vi.fn();
    const userFindMany = vi.fn();
    const fakeClient = {
      team: {
        findFirst: teamFindFirst,
        findUnique: teamFindUnique,
      },
      user: {
        findMany: userFindMany,
      },
    } as never;
    const prismaService = { $client: fakeClient } as never;
    return {
      service: new UsersService(prismaService),
      mocks: { teamFindFirst, teamFindUnique, userFindMany },
    };
  }

  it('ADMIN sees all users (no team filter)', async () => {
    const { service, mocks } = makeTeamService();
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(adminActor);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('MANAGER resolves their team via Team.managerId and lists its members', async () => {
    const { service, mocks } = makeTeamService();
    mocks.teamFindFirst.mockResolvedValue({ id: 'team-mgr' });
    mocks.teamFindUnique.mockResolvedValue({ managerId: 'mgr-1' });
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(managerActor);
    expect(mocks.teamFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { managerId: 'mgr-1' } }),
    );
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ teamId: 'team-mgr' }, { id: 'mgr-1' }] },
      }),
    );
  });

  it('TELECALLER sees their team + the team manager (so they can loop the manager)', async () => {
    const { service, mocks } = makeTeamService();
    mocks.teamFindUnique.mockResolvedValue({ managerId: 'mgr-1' });
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(telecallerActor);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ teamId: 'team-tc' }, { id: 'mgr-1' }] },
      }),
    );
  });

  it('returns [] when the actor has no team', async () => {
    const { service, mocks } = makeTeamService();
    const noTeamActor: Actor = { ...telecallerActor, teamId: null };
    const result = await service.teamMembers(noTeamActor);
    expect(result).toEqual([]);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });
});

describe('list - role facet filter + server pagination (autoplan 2026-09-09)', () => {
  function makeListService() {
    const teamFindFirst = vi.fn();
    const userFindMany = vi.fn();
    const userCount = vi.fn();
    const fakeClient = {
      team: { findFirst: teamFindFirst },
      user: { findMany: userFindMany, count: userCount },
    } as never;
    const prismaService = { $client: fakeClient } as never;
    return {
      service: new UsersService(prismaService),
      mocks: { teamFindFirst, userFindMany, userCount },
    };
  }

  it('ADMIN with no filter → no role WHERE clause, default limit/offset', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 50 }),
    );
    expect(mocks.userCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('ADMIN with a single role → WHERE role IN ([role])', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor, { role: 'SALES_EXEC', limit: 50, offset: 0 });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: { in: ['SALES_EXEC'] } },
      }),
    );
  });

  it('ADMIN with multiple roles → WHERE role IN ([...])', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor, {
      role: ['SALES_EXEC', 'TELECALLER'],
      limit: 50,
      offset: 0,
    });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: { in: ['SALES_EXEC', 'TELECALLER'] } },
      }),
    );
  });

  it('MANAGER with a role filter → team scope AND role IN ([...])', async () => {
    const { service, mocks } = makeListService();
    mocks.teamFindFirst.mockResolvedValue({ id: 'team-mgr' });
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(managerActor, { role: 'TELECALLER', limit: 50, offset: 0 });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: 'team-mgr', role: { in: ['TELECALLER'] } },
      }),
    );
  });

  it('applies skip/take from the filter (server pagination)', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor, { limit: 10, offset: 20 });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('applies a name/email OR search clause', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor, { search: 'priya', limit: 50, offset: 0 });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { name: { contains: 'priya', mode: 'insensitive' } },
            { email: { contains: 'priya', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('combines role filter + search + pagination', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor, {
      role: 'SALES_EXEC',
      search: 'priya',
      limit: 10,
      offset: 20,
    });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: { in: ['SALES_EXEC'] },
          OR: [
            { name: { contains: 'priya', mode: 'insensitive' } },
            { email: { contains: 'priya', mode: 'insensitive' } },
          ],
        },
        skip: 20,
        take: 10,
      }),
    );
  });

  it('returns { rows, total } envelope', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([
      { id: 'u1', email: 'a@x', name: 'A', role: 'ADMIN', teamId: null },
    ]);
    mocks.userCount.mockResolvedValue(1);
    const result = await service.list(adminActor, { limit: 50, offset: 0 });
    expect(result).toEqual({
      rows: [{ id: 'u1', email: 'a@x', name: 'A', role: 'ADMIN', teamId: null }],
      total: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// update (PATCH /api/users/:id) + remove (DELETE /api/users/:id)
// Hierarchy-gated: actor must strictly outrank the target; no self-actions;
// OWNER protected. Mirrors the changeRole guards.
// ---------------------------------------------------------------------------

interface ManageStubOptions {
  target?: {
    id: string;
    email: string;
    name: string;
    role: string;
    teamId: string | null;
  } | null;
}

function makeManageService(opts: ManageStubOptions = {}) {
  const userFindUnique = vi
    .fn()
    .mockResolvedValue(
      opts.target === undefined
        ? {
            id: 'u-priya',
            email: 'priya@x',
            name: 'Priya',
            role: 'SALES_EXEC',
            teamId: 't-1',
          }
        : opts.target,
    );
  const userUpdate = vi.fn().mockResolvedValue({
    id: 'u-priya',
    email: 'priya@x',
    name: 'Priya',
    role: 'SALES_EXEC',
    teamId: 't-1',
  });
  const userDelete = vi.fn().mockResolvedValue({});
  const accountDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const auditCreate = vi.fn().mockResolvedValue({});
  const txMock = {
    auditLog: { create: auditCreate },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };
  const fakeClient = {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
      delete: userDelete,
    },
    account: { deleteMany: accountDeleteMany },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(txMock),
  } as never;
  const prismaService = { $client: fakeClient } as never;
  return {
    service: new UsersService(prismaService),
    mocks: {
      userFindUnique,
      userUpdate,
      userDelete,
      accountDeleteMany,
      auditCreate,
    },
  };
}

describe('update - PATCH /api/users/:id (hierarchy-gated)', () => {
  it('ADMIN edits a SALES_EXEC → updates name/email + writes audit', async () => {
    const { service, mocks } = makeManageService();
    const result = await service.update(adminActor, 'u-priya', {
      name: 'Priya New',
      email: 'priya.new@x',
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'u-priya' },
      data: { name: 'Priya New', email: 'priya.new@x' },
    });
    expect(result).toEqual({
      id: 'u-priya',
      email: 'priya@x',
      name: 'Priya',
      role: 'SALES_EXEC',
      teamId: 't-1',
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'user.update' }),
      }),
    );
  });

  it('ADMIN editing self → 403 ForbiddenException', async () => {
    const { service } = makeManageService({
      target: {
        id: adminActor.sub,
        email: 'admin@x',
        name: 'Admin',
        role: 'ADMIN',
        teamId: null,
      },
    });
    await expect(
      service.update(adminActor, adminActor.sub, { name: 'X' }),
    ).rejects.toThrow('You cannot edit your own user');
  });

  it('MANAGER editing an ADMIN → 403 (does not outrank)', async () => {
    const { service } = makeManageService({
      target: {
        id: 'u-admin',
        email: 'admin@x',
        name: 'Admin',
        role: 'ADMIN',
        teamId: null,
      },
    });
    await expect(
      service.update(managerActor, 'u-admin', { name: 'X' }),
    ).rejects.toThrow('MANAGER cannot edit a ADMIN user');
  });

  it('unknown target → 404 NotFoundException', async () => {
    const { service } = makeManageService({ target: null });
    await expect(
      service.update(adminActor, 'missing', { name: 'X' }),
    ).rejects.toThrow('not found');
  });
});

describe('remove - DELETE /api/users/:id (hierarchy-gated)', () => {
  it('ADMIN deletes a SALES_EXEC → deletes account + user + writes audit', async () => {
    const { service, mocks } = makeManageService();
    const result = await service.remove(adminActor, 'u-priya');
    expect(result).toEqual({ ok: true });
    expect(mocks.accountDeleteMany).toHaveBeenCalledWith({
      where: { accountId: 'u-priya' },
    });
    expect(mocks.userDelete).toHaveBeenCalledWith({
      where: { id: 'u-priya' },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'user.delete' }),
      }),
    );
  });

  it('ADMIN deleting self → 403 ForbiddenException', async () => {
    const { service } = makeManageService({
      target: {
        id: adminActor.sub,
        email: 'admin@x',
        name: 'Admin',
        role: 'ADMIN',
        teamId: null,
      },
    });
    await expect(service.remove(adminActor, adminActor.sub)).rejects.toThrow(
      'You cannot delete your own user',
    );
  });

  it('MANAGER deleting an ADMIN → 403 (does not outrank)', async () => {
    const { service } = makeManageService({
      target: {
        id: 'u-admin',
        email: 'admin@x',
        name: 'Admin',
        role: 'ADMIN',
        teamId: null,
      },
    });
    await expect(service.remove(managerActor, 'u-admin')).rejects.toThrow(
      'MANAGER cannot delete a ADMIN user',
    );
  });

  it('unknown target → 404 NotFoundException', async () => {
    const { service } = makeManageService({ target: null });
    await expect(service.remove(adminActor, 'missing')).rejects.toThrow(
      'not found',
    );
  });
});