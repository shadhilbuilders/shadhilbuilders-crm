// Users service tests - PATCH /api/users/:id/manager (autoplan 2026-09-13).
//
// Pins:
//   1. unknown user → 404 NotFoundException
//   2. target role is MANAGER/ADMIN/OWNER → 400 BadRequestException
//      (only TELECALLER/SALES_EXEC report to a manager here)
//   3. actor doesn't outrank target (staff→staff) → 403 ForbiddenException
//   4. unknown teamId → 404 NotFoundException
//   5. team exists but has no manager → 400 BadRequestException
//   6. ADMIN/OWNER can assign into ANY led team
//   7. MANAGER can assign into their OWN led team
//   8. MANAGER assigning into ANOTHER manager's team → 403 ForbiddenException
//   9. happy path writes User.teamId and returns the updated CreatedUser
//      shape + writes an audit row

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

import { UsersService } from './users.service';

type Actor = JwtPayload;

const NOW = Math.floor(Date.now() / 1000);
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

function actor(overrides: Partial<Actor>): Actor {
  return {
    sub: 'actor-1',
    email: 'actor@shadhilbuilders.in',
    role: 'ADMIN',
    organizationId: ORG,
    iat: NOW,
    exp: NOW + 3600,
    iss: 'shadhil-bff',
    ...overrides,
  };
}

const ownerActor = actor({ sub: 'owner-1', role: 'OWNER' });
const adminActor = actor({ sub: 'admin-1', role: 'ADMIN' });
const managerActor = actor({ sub: 'mgr-1', role: 'MANAGER' });
const otherManagerActor = actor({ sub: 'mgr-2', role: 'MANAGER' });
const telecallerActor = actor({ sub: 'tc-1', role: 'TELECALLER'});

const salesExecTarget = {
  id: 'exec-1',
  email: 'exec@x',
  name: 'Priya Sharma',
  role: 'SALES_EXEC',
  teamId: 'team-1',
};

const managerTarget = {
  id: 'mgr-9',
  email: 'mgr9@x',
  name: 'Some Manager',
  role: 'MANAGER',
  teamId: null,
};

function makeService(opts: {
  user: Record<string, unknown> | null;
  team?: { id: string; name: string; managerId: string | null } | null;
}) {
  const userFindUnique = vi.fn().mockResolvedValue(opts.user);
  const teamFindUnique = vi.fn().mockResolvedValue(opts.team ?? null);
  const auditCreate = vi.fn().mockResolvedValue({});
  // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): assignManager()
  // replaces the target's ordinary TeamMember row(s) instead of writing
  // User.teamId - resolveDisplayTeamId(target) reads the "before" value
  // via teamMember.findFirst (null here: the target's prior team isn't
  // under test in these fixtures), then deleteMany + create.
  const teamMemberFindFirst = vi.fn().mockResolvedValue(null);
  const teamMemberDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const teamMemberCreate = vi.fn().mockResolvedValue({});
  const txMock = {
    auditLog: { create: auditCreate },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };
  const fakeClient = {
    user: { findUnique: userFindUnique },
    team: { findUnique: teamFindUnique },
    teamMember: {
      findFirst: teamMemberFindFirst,
      deleteMany: teamMemberDeleteMany,
      create: teamMemberCreate,
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock),
  } as never;
  const prismaService = { $client: fakeClient } as never;
  return {
    service: new UsersService(prismaService),
    mocks: {
      userFindUnique,
      teamFindUnique,
      auditCreate,
      teamMemberFindFirst,
      teamMemberDeleteMany,
      teamMemberCreate,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assignManager - not found', () => {
  it('throws NotFoundException for an unknown user id', async () => {
    const { service } = makeService({ user: null });
    await expect(
      service.assignManager(adminActor, 'nope', { teamId: 'team-2' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });
});

describe('assignManager - role gate', () => {
  it('rejects a MANAGER/ADMIN/OWNER target (they do not report to a manager here)', async () => {
    const { service } = makeService({ user: managerTarget });
    await expect(
      service.assignManager(adminActor, managerTarget.id, { teamId: 'team-2' }),
    ).rejects.toMatchObject({
      name: 'BadRequestException',
      message: 'Only TELECALLER/SALES_EXEC report to a manager',
    });
  });
});

describe('assignManager - hierarchy gate', () => {
  it('staff cannot reassign another staff user\u2019s manager', async () => {
    const { service, mocks } = makeService({ user: salesExecTarget });
    await expect(
      service.assignManager(telecallerActor, salesExecTarget.id, { teamId: 'team-2' }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
    expect(mocks.teamMemberCreate).not.toHaveBeenCalled();
  });
});

describe('assignManager - team validation', () => {
  it('unknown teamId → NotFoundException', async () => {
    const { service } = makeService({ user: salesExecTarget, team: null });
    await expect(
      service.assignManager(adminActor, salesExecTarget.id, { teamId: 'team-404' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('team with no manager assigned → BadRequestException', async () => {
    const { service } = makeService({
      user: salesExecTarget,
      team: { id: 'team-unled', name: 'Unled Team', managerId: null },
    });
    await expect(
      service.assignManager(adminActor, salesExecTarget.id, { teamId: 'team-unled' }),
    ).rejects.toMatchObject({
      name: 'BadRequestException',
      message: 'Team "Unled Team" has no manager assigned yet',
    });
  });
});

describe('assignManager - ADMIN/OWNER scope', () => {
  it('ADMIN can assign into any led team + writes the audit row', async () => {
    const { service, mocks } = makeService({
      user: salesExecTarget,
      team: { id: 'team-2', name: "Asha's Team", managerId: 'mgr-2' },
    });
    const result = await service.assignManager(adminActor, salesExecTarget.id, {
      teamId: 'team-2',
    });
    expect(result.teamId).toBe('team-2');
    expect(mocks.teamMemberDeleteMany).toHaveBeenCalledWith({
      where: { userId: salesExecTarget.id },
    });
    expect(mocks.teamMemberCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: salesExecTarget.id}),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'user.assignManager',
          entityId: salesExecTarget.id,
          before: { teamId: null },
          after: { teamId: 'team-2' },
        }),
      }),
    );
  });

  it('OWNER can assign into any led team', async () => {
    const { service } = makeService({
      user: salesExecTarget,
      team: { id: 'team-2', name: "Asha's Team", managerId: 'mgr-2' },
    });
    const result = await service.assignManager(ownerActor, salesExecTarget.id, {
      teamId: 'team-2',
    });
    expect(result.teamId).toBe('team-2');
  });
});

describe('assignManager - MANAGER scope', () => {
  it('MANAGER can assign into their OWN led team', async () => {
    const { service } = makeService({
      user: salesExecTarget,
      team: { id: 'team-mgr1', name: "Manager 1's Team", managerId: managerActor.sub },
    });
    const result = await service.assignManager(managerActor, salesExecTarget.id, {
      teamId: 'team-mgr1',
    });
    expect(result.teamId).toBe('team-mgr1');
  });

  it('MANAGER assigning into ANOTHER manager\u2019s team → ForbiddenException', async () => {
    const { service, mocks } = makeService({
      user: salesExecTarget,
      team: { id: 'team-mgr1', name: "Manager 1's Team", managerId: managerActor.sub },
    });
    await expect(
      service.assignManager(otherManagerActor, salesExecTarget.id, {
        teamId: 'team-mgr1',
      }),
    ).rejects.toMatchObject({
      name: 'ForbiddenException',
      message: 'Managers can only assign staff into their own team',
    });
    expect(mocks.teamMemberCreate).not.toHaveBeenCalled();
  });
});
