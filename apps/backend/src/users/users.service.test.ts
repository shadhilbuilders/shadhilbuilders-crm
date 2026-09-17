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
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};
const telecallerActor: Actor = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};
const adminActor: Actor = {
  sub: 'admin-1',
  email: 'admin@shadhilbuilders.in',
  role: 'ADMIN',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
};
const ownerActor: Actor = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
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
  const teamMemberFindFirst = vi.fn().mockResolvedValue(null);
  const txMock = {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
    // update() resolves the display team inside the same transaction
    // (resolveDisplayTeamId reads Team/TeamMember, both FORCE RLS).
    teamMember: { findFirst: teamMemberFindFirst },
    team: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
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
  // T-TEAM-AUTHORITATIVE (2026-09-13): teamMembers() resolves via
  // team.findMany with TWO different where shapes - `{ managerId }` for
  // the manager's own managed teams, `{ id: { in } }` for the keyed
  // lookup that collects each team's manager. Dispatch on the where
  // shape rather than call order (a TELECALLER only ever makes the
  // second call, never the first).
  function makeTeamService(
    managedTeams: Array<{ id: string }> = [],
    teamsById: Array<{ managerId: string | null }> = [{ managerId: 'mgr-1' }],
    ownTeamMemberships: Array<{ teamId: string }> = [],
    // T-USER-PROJECT-SCOPE: project->team links, for ?projectId= scoping.
    projectTeams: Array<{ teamId: string }> = [],
  ) {
    const teamFindMany = vi.fn(
      async (args: { where: { managerId?: string; id?: { in: string[] }; deletedAt?: null } }) => {
        if ('managerId' in args.where) return managedTeams;
        return teamsById;
      },
    );
    const projectTeamFindMany = vi.fn().mockResolvedValue(projectTeams);
    // T-ORG-EXPLICIT: same cross-org validation as `list`.
    const projectFindFirst = vi.fn().mockResolvedValue({ id: 'proj-1' });
    const userFindMany = vi.fn();
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): non-manager actors
    // resolve their own teams via TeamMember, not the JWT teamId claim.
    const teamMemberFindMany = vi.fn().mockResolvedValue(ownTeamMemberships);
    // teamMembers() now runs inside ONE withRlsContext transaction, so the
    // tx must expose every accessor it touches (the outer shape alone is
    // not enough). Mocks are shared so assertions still see the calls.
    const txMock = {
      team: { findMany: teamFindMany },
      user: { findMany: userFindMany },
      teamMember: { findMany: teamMemberFindMany },
      project: { findFirst: projectFindFirst },
      projectTeam: { findMany: projectTeamFindMany },
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    };
    const fakeClient = {
      team: { findMany: teamFindMany },
      user: { findMany: userFindMany },
      teamMember: { findMany: teamMemberFindMany },
      project: { findFirst: projectFindFirst },
      projectTeam: { findMany: projectTeamFindMany },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock),
    } as never;
    const prismaService = { $client: fakeClient } as never;
    return {
      service: new UsersService(prismaService),
      mocks: {
        teamFindMany,
        userFindMany,
        teamMemberFindMany,
        projectFindFirst,
        projectTeamFindMany,
      },
    };
  }

  // ── T-USER-PROJECT-SCOPE (2026-09-16) — @mention picker ────────────────────
  // User-reported: an admin/owner's @mention list showed people from every
  // project. The chat pane now passes the active project.
  it('ADMIN + projectId → scoped to that project staff (not the whole directory)', async () => {
    const { service, mocks } = makeTeamService(
      [],
      [{ managerId: 'mgr-on-proj' }],
      [],
      [{ teamId: 'team-on-proj' }],
    );
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(adminActor, 'proj-1');
    const call = mocks.userFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where['organizationId']).toBe('ceid01lpfe1esm8jwsxid41k28');
    expect(call.where['OR']).toEqual([
      { teamMemberships: { some: { teamId: { in: ['team-on-proj'] } } } },
      { id: { in: ['mgr-on-proj'] } },
      { id: adminActor.sub },
    ]);
  });

  it('ADMIN without projectId → org-scoped, excludes soft-deleted', async () => {
    const { service, mocks } = makeTeamService();
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(adminActor);
    const call = mocks.userFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    // T-ORG-EXPLICIT: this was `{}` - the entire User table, every org, including
    // soft-deleted rows.
    expect(call.where).toEqual({
      deletedAt: null,
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
  });

  it('teamMembers: projectId from ANOTHER org → 403', async () => {
    const { service, mocks } = makeTeamService();
    mocks.projectFindFirst.mockResolvedValue(null);
    await expect(service.teamMembers(adminActor, 'other-org-proj')).rejects.toThrow(
      /not found in your organization/i,
    );
  });

  it('ADMIN + projectId with no staffed teams → only the caller', async () => {
    const { service, mocks } = makeTeamService([], [], [], []);
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(adminActor, 'proj-empty');
    const call = mocks.userFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where['OR']).toEqual([{ id: adminActor.sub }]);
  });

  it('ADMIN sees all users in their ORG (no team filter)', async () => {
    const { service, mocks } = makeTeamService();
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(adminActor);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      }),
    );
  });

  it('MANAGER resolves EVERY team they lead via Team.managerId and lists all members', async () => {
    const { service, mocks } = makeTeamService([{ id: 'team-mgr' }], [{ managerId: 'mgr-1' }]);
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(managerActor);
    expect(mocks.teamFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        managerId: 'mgr-1',
        deletedAt: null,
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
    });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          OR: [
            { teamMemberships: { some: { teamId: { in: ['team-mgr'] } } } },
            { id: { in: ['mgr-1'] } },
          ],
        },
      }),
    );
  });

  it('MANAGER leading multiple teams sees members across ALL of them', async () => {
    const { service, mocks } = makeTeamService(
      [{ id: 'team-a' }, { id: 'team-b' }],
      [{ managerId: 'mgr-1' }, { managerId: 'mgr-1' }],
    );
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(managerActor);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          OR: [
            { teamMemberships: { some: { teamId: { in: ['team-a', 'team-b'] } } } },
            { id: { in: ['mgr-1'] } },
          ],
        },
      }),
    );
  });

  it('TELECALLER sees their team + the team manager (so they can loop the manager)', async () => {
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolved via the
    // telecaller's OWN TeamMember rows, not the JWT teamId claim.
    const { service, mocks } = makeTeamService([], [{ managerId: 'mgr-1' }], [{ teamId: 'team-tc' }]);
    mocks.userFindMany.mockResolvedValue([]);
    await service.teamMembers(telecallerActor);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          OR: [
            { teamMemberships: { some: { teamId: { in: ['team-tc'] } } } },
            { id: { in: ['mgr-1'] } },
          ],
        },
      }),
    );
  });

  it('returns [] when the actor has no team', async () => {
    const { service, mocks } = makeTeamService([], [], []);
    const result = await service.teamMembers(telecallerActor);
    expect(result).toEqual([]);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });
});

describe('list - role facet filter + server pagination (autoplan 2026-09-09)', () => {
  function makeListService() {
    const teamFindFirst = vi.fn();
    // T-TEAM-AUTHORITATIVE (2026-09-13): list()'s MANAGER scope resolves
    // via findMany (a manager may lead multiple teams).
    const teamFindMany = vi.fn().mockResolvedValue([]);
    const userFindMany = vi.fn();
    const userCount = vi.fn();
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): projects come from
    // the resolved team's ProjectTeam rows now (ProjectMember retired).
    const projectTeamFindMany = vi.fn().mockResolvedValue([]);
    // T-ORG-EXPLICIT: `?projectId=` is caller-supplied and is now validated
    // against the actor's org, so list() resolves the project first. Defaults to
    // "found" - tests that assert the cross-org rejection override it.
    const projectFindFirst = vi.fn().mockResolvedValue({ id: 'proj-1' });
    // list() now runs inside ONE withRlsContext transaction - the tx must
    // expose every accessor it touches. Mocks shared so assertions see calls.
    const txMock = {
      team: { findFirst: teamFindFirst, findMany: teamFindMany },
      user: { findMany: userFindMany, count: userCount },
      project: { findFirst: projectFindFirst },
      projectTeam: { findMany: projectTeamFindMany },
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    };
    const fakeClient = {
      team: { findFirst: teamFindFirst, findMany: teamFindMany },
      user: { findMany: userFindMany, count: userCount },
      project: { findFirst: projectFindFirst },
      projectTeam: { findMany: projectTeamFindMany },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock),
    } as never;
    const prismaService = { $client: fakeClient } as never;
    return {
      service: new UsersService(prismaService),
      mocks: {
        teamFindFirst,
        teamFindMany,
        userFindMany,
        userCount,
        projectFindFirst,
        projectTeamFindMany,
      },
    };
  }

  it('ADMIN with no filter → base deletedAt filter + default limit/offset', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor);
    // T-USER-PROJECT-SCOPE (2026-09-16): the ADMIN/OWNER branch now ALSO scopes
    // to the actor's organisation - before this, the list leaked users from
    // every other org.
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
        skip: 0,
        take: 50,
      }),
    );
    expect(mocks.userCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      }),
    );
  });

  it('ADMIN with a single role → deletedAt + WHERE role IN ([role])', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(adminActor, { role: 'SALES_EXEC', limit: 50, offset: 0 });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          role: { in: ['SALES_EXEC'] },
        },
      }),
    );
  });

  it('ADMIN with multiple roles → deletedAt + WHERE role IN ([...])', async () => {
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
        where: {
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          role: { in: ['SALES_EXEC', 'TELECALLER'] },
        },
      }),
    );
  });

  // ── T-USER-PROJECT-SCOPE (2026-09-16) ──────────────────────────────────────
  // User-reported: the lead "Assign to" / "Co-owner" pickers listed staff who
  // were not on the lead's project. ?projectId= narrows to the project's staff.
  it('projectId → narrows to the project staff (members + their managers)', async () => {
    const { service, mocks } = makeListService();
    mocks.projectTeamFindMany.mockResolvedValue([{ teamId: 'team-on-proj' }]);
    mocks.teamFindMany.mockResolvedValue([{ managerId: 'mgr-on-proj' }]);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);

    await service.list(adminActor, { projectId: 'proj-1', limit: 50, offset: 0 });

    const call = mocks.userFindMany.mock.calls[0][0] as {
      where: { AND?: Array<{ OR: unknown[] }> };
    };
    // The project scope is an OR of: team members, the teams' managers, and the
    // actor themselves (so a picker never hides the current owner).
    expect(call.where.AND?.[0]?.OR).toEqual([
      { teamMemberships: { some: { teamId: { in: ['team-on-proj'] } } } },
      { id: { in: ['mgr-on-proj'] } },
      { id: adminActor.sub },
    ]);
  });

  it('projectId + search → BOTH clauses survive (AND, not overwrite)', async () => {
    const { service, mocks } = makeListService();
    mocks.projectTeamFindMany.mockResolvedValue([{ teamId: 'team-on-proj' }]);
    mocks.teamFindMany.mockResolvedValue([{ managerId: 'mgr-on-proj' }]);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);

    await service.list(adminActor, {
      projectId: 'proj-1',
      search: 'priya',
      limit: 50,
      offset: 0,
    });

    const call = mocks.userFindMany.mock.calls[0][0] as {
      where: { AND?: Array<{ OR: unknown[] }> };
    };
    // Regression guard: `OR` is a single key, so assigning both the project
    // scope and the search as `where.OR` silently dropped one of them.
    expect(call.where.AND).toHaveLength(2);
    expect(call.where.AND?.[0]?.OR).toHaveLength(3); // project scope
    expect(call.where.AND?.[1]?.OR).toHaveLength(2); // name/email search
  });

  it('MANAGER team lookup is org-scoped', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(managerActor);
    // T-ORG-EXPLICIT: the manager's own team lookup carries the org, so a policy
    // change on Team can't silently turn this into a cross-org read.
    expect(mocks.teamFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'ceid01lpfe1esm8jwsxid41k28' }),
      }),
    );
  });

  it('projectId from ANOTHER org → 403 (not a misleadingly empty list)', async () => {
    const { service, mocks } = makeListService();
    // The project exists, but in a different org: the org-scoped lookup misses.
    mocks.projectFindFirst.mockResolvedValue(null);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);

    // T-ORG-EXPLICIT: Project/ProjectTeam RLS allow ANY authenticated role, so
    // RLS bounded this only by returning zero rows - which reads as "this project
    // has no staff". It must fail loudly instead.
    await expect(
      service.list(adminActor, { projectId: 'other-org-proj', limit: 50, offset: 0 }),
    ).rejects.toThrow(/not found in your organization/i);
    // And it must NOT have run the unfiltered user query.
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it('projectId with no staffed teams → still narrowed, never widens', async () => {
    const { service, mocks } = makeListService();
    mocks.projectTeamFindMany.mockResolvedValue([]);
    mocks.teamFindMany.mockResolvedValue([]);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);

    await service.list(adminActor, { projectId: 'proj-no-teams', limit: 50, offset: 0 });

    // No teams on the project => only the actor can match. It must NOT fall back
    // to the unscoped org list.
    const call = mocks.userFindMany.mock.calls[0][0] as {
      where: { AND?: Array<{ OR: unknown[] }> };
    };
    expect(call.where.AND?.[0]?.OR).toEqual([{ id: adminActor.sub }]);
  });

  it('MANAGER + projectId → manager team scope AND project scope (intersection)', async () => {
    const { service, mocks } = makeListService();
    mocks.teamFindMany.mockResolvedValue([{ id: 'team-mgr' }]);
    mocks.projectTeamFindMany.mockResolvedValue([{ teamId: 'team-on-proj' }]);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);

    await service.list(managerActor, { projectId: 'proj-1', limit: 50, offset: 0 });

    const call = mocks.userFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    // The team scope stays a top-level key; the project scope is an extra AND
    // clause. Both must be present - the project filter may only ever REDUCE.
    expect(call.where['teamMemberships']).toEqual({
      some: { teamId: { in: ['team-mgr'] } },
    });
    expect(Array.isArray(call.where['AND'])).toBe(true);
  });

  it('MANAGER with a role filter → team scope AND role IN ([...])', async () => {
    const { service, mocks } = makeListService();
    mocks.teamFindMany.mockResolvedValue([{ id: 'team-mgr' }]);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    await service.list(managerActor, { role: 'TELECALLER', limit: 50, offset: 0 });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          teamMemberships: { some: { teamId: { in: ['team-mgr'] } } },
          role: { in: ['TELECALLER'] },
        },
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
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          // OR is nested inside AND so the project scope (also an OR) cannot be
          // clobbered by the search filter.
          AND: [
            {
              OR: [
                { name: { contains: 'priya', mode: 'insensitive' } },
                { email: { contains: 'priya', mode: 'insensitive' } },
              ],
            },
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
          deletedAt: null,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          role: { in: ['SALES_EXEC'] },
          AND: [
            {
              OR: [
                { name: { contains: 'priya', mode: 'insensitive' } },
                { email: { contains: 'priya', mode: 'insensitive' } },
              ],
            },
          ],
        },
        skip: 20,
        take: 10,
      }),
    );
  });

  it('returns { rows, total } envelope (projects come from the user\'s TEAM\'s ProjectTeam rows - T-TEAM-AUTHORITATIVE 2026-09-13 clean cutover, ProjectMember retired)', async () => {
    const { service, mocks } = makeListService();
    mocks.userFindMany.mockResolvedValue([
      {
        id: 'u1',
        email: 'a@x',
        name: 'A',
        role: 'ADMIN',
        teamMemberships: [{ teamId: 'team-x' }],
      },
    ]);
    mocks.userCount.mockResolvedValue(1);
    mocks.projectTeamFindMany.mockResolvedValue([
      { teamId: 'team-x', project: { name: 'Shadhil Metro Heights' } },
    ]);
    const result = await service.list(adminActor, { limit: 50, offset: 0 });
    expect(result).toEqual({
      rows: [
        {
          id: 'u1',
          email: 'a@x',
          name: 'A',
          role: 'ADMIN',
          teamId: 'team-x',
          projects: ['Shadhil Metro Heights'],
        },
      ],
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
  // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): update()'s return
  // value resolves `teamId` via resolveDisplayTeamId - a non-manager
  // target (SALES_EXEC fixture default) reads its oldest TeamMember row.
  const teamMemberFindFirst = vi.fn().mockResolvedValue({ teamId: 't-1' });
  // update() now runs wholly inside ONE withRlsContext transaction, so the
  // tx must expose the user write, the audit row, and the Team/TeamMember
  // reads resolveDisplayTeamId performs.
  const txMock = {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
    teamMember: { findFirst: teamMemberFindFirst },
    team: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
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
    teamMember: { findFirst: teamMemberFindFirst },
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

describe('remove - DELETE /api/users/:id (SOFT delete, admin/owner only)', () => {
  it('ADMIN soft-deletes a SALES_EXEC → stamps deletedAt, keeps account, writes audit', async () => {
    const { service, mocks } = makeManageService();
    const result = await service.remove(adminActor, 'u-priya');
    expect(result).toEqual({ ok: true });
    // Soft delete: it updates the user (sets deletedAt), NOT a hard delete
    // and NOT a credential-account delete.
    expect(mocks.accountDeleteMany).not.toHaveBeenCalled();
    expect(mocks.userDelete).not.toHaveBeenCalled();
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-priya' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'user.delete' }),
      }),
    );
  });

  it('MANAGER deleting is rejected with 403 (admin/owner only)', async () => {
    const { service } = makeManageService();
    await expect(service.remove(managerActor, 'u-priya')).rejects.toThrow(
      'Only ADMIN or OWNER can delete users',
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

  it('ADMIN deleting the OWNER → 403 (OWNER is protected)', async () => {
    const { service } = makeManageService({
      target: {
        id: 'u-owner',
        email: 'owner@x',
        name: 'Owner',
        role: 'OWNER',
        teamId: null,
      },
    });
    await expect(service.remove(adminActor, 'u-owner')).rejects.toThrow(
      'The OWNER cannot be deleted',
    );
  });

  it('unknown target → 404 NotFoundException', async () => {
    const { service } = makeManageService({ target: null });
    await expect(service.remove(adminActor, 'missing')).rejects.toThrow(
      'not found',
    );
  });
});