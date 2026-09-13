// Teams service tests - Team CRUD + delete-guard + reassign (T-TEAM-CRUD,
// 2026-09-13). Kept in a SEPARATE file from teams.service.test.ts (mirrors
// users.service.assignManager.test.ts's precedent) - the read-path mocks
// there are delicately shaped for list()/getTeam() and shouldn't be
// disturbed by these write-path fixtures.
//
// Pins:
//   create(): ADMIN/OWNER only -> 403 else; managerId must be a MANAGER
//     -> 400 else; managerId must not already lead another team -> 409
//     else; happy path creates + audits.
//   update(): same 3 manager-validation branches (excluding the team being
//     edited); 404 when missing/soft-deleted; happy path updates + audits.
//   remove(): 409 when members > 0; 409 when managerId is set; 404 when
//     missing/soft-deleted; happy path soft-deletes (deletedAt set) + audits.
//   reassignMembers(): 400 when target === source; 404 when either team is
//     missing/soft-deleted; 400 when no matching members; bulk (no
//     userIds) moves everyone; single (userIds=[x]) moves only x; audits.
//
// Test strategy: stub withRlsContext to invoke the callback with a fake tx
// (same shape as teams.service.test.ts), returning per-test canned rows.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

vi.mock('@shadhil/database', () => {
  return {
    prisma: {},
    rlsContextFrom: vi.fn((actor: {
      sub: string;
      role: string;
      organizationId?: string | null;
    }) => ({
      userId: actor.sub,
      role: actor.role,
      organizationId: actor.organizationId ?? 'ceid01lpfe1esm8jwsxid41k28',
    })),
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
        callback: (t: unknown) => unknown,
      ) => callback((globalThis as { __tx?: unknown }).__tx),
    ),
  };
});

import { TeamsService } from './teams.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const NOW = Math.floor(Date.now() / 1000);

function actor(overrides: Partial<JwtPayload>): JwtPayload {
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

const adminActor = actor({ sub: 'admin-1', role: 'ADMIN' });
const ownerActor = actor({ sub: 'owner-1', role: 'OWNER' });
const managerActor = actor({ sub: 'mgr-1', role: 'MANAGER' });
const telecallerActor = actor({ sub: 'tc-1', role: 'TELECALLER' });

type TxMock = {
  team: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  user: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  teamMember: {
    count: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

/** Build a fresh fake tx + install it as the withRlsContext callback target. */
function makeTx(overrides: Partial<{
  teams: Record<string, unknown | null>;
  users: Record<string, { id: string; role: string; name?: string } | null>;
  managerLedTeam: { id: string; name: string } | null;
  memberCount: number;
  members: Array<{ userId: string; teamId: string; organizationId: string }>;
}> = {}): TxMock {
  const teams = overrides.teams ?? {};
  const users = overrides.users ?? {};
  // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): reassignMembers() and
  // remove()'s member-count guard both read TeamMember rows now, not
  // User.teamId. `members` defaults to a count matching `memberCount` so
  // existing "N members" tests keep the same shape without listing every
  // row explicitly, unless a test needs specific rows (reassignMembers).
  const members =
    overrides.members ??
    Array.from({ length: overrides.memberCount ?? 0 }, (_, i) => ({
      userId: `member-${i}`,
      teamId: 'team-1',
      organizationId: ORG,
    }));
  const tx: TxMock = {
    team: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-team-1',
        name: data.name,
        managerId: data.managerId ?? null,
        defaultAssigneeId: null,
        deletedAt: null,
      })),
      update: vi.fn().mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          name: (data.name as string) ?? (teams[where.id] as { name?: string })?.name,
          managerId:
            'managerId' in data
              ? (data.managerId as string | null)
              : ((teams[where.id] as { managerId?: string | null })?.managerId ?? null),
          defaultAssigneeId: null,
          deletedAt: 'deletedAt' in data ? (data.deletedAt as Date) : null,
        }),
      ),
      findUnique: vi.fn().mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          teams[where.id] === undefined ? null : teams[where.id],
      ),
      findFirst: vi.fn().mockResolvedValue(overrides.managerLedTeam ?? null),
    },
    user: {
      findUnique: vi.fn().mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          users[where.id] === undefined ? null : users[where.id],
      ),
    },
    teamMember: {
      count: vi.fn().mockResolvedValue(members.length),
      findMany: vi.fn().mockResolvedValue(members),
      deleteMany: vi.fn().mockResolvedValue({ count: members.length }),
      createMany: vi.fn().mockResolvedValue({ count: members.length }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  (globalThis as { __tx?: unknown }).__tx = tx;
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __tx?: unknown }).__tx = undefined;
});

// ────────────────────────────────────────────────────────────────────────────
// create()
// ────────────────────────────────────────────────────────────────────────────

describe('TeamsService.create', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx();
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.create(managerActor, { name: 'New Team' }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
    await expect(
      svc.create(telecallerActor, { name: 'New Team' }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('rejects a managerId that is not a MANAGER role', async () => {
    makeTx({ users: { 'u-exec': { id: 'u-exec', role: 'SALES_EXEC' } } });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.create(adminActor, { name: 'New Team', managerId: 'u-exec' }),
    ).rejects.toMatchObject({
      name: 'BadRequestException',
      message: expect.stringContaining('not a MANAGER'),
    });
  });

  it('T-TEAM-AUTHORITATIVE: allows a managerId that already leads another team (one manager, multiple teams)', async () => {
    const tx = makeTx({
      users: { 'mgr-9': { id: 'mgr-9', role: 'MANAGER' } },
      managerLedTeam: { id: 'team-existing', name: "Mgr 9's Team" },
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.create(adminActor, { name: 'New Team', managerId: 'mgr-9' });
    expect(result.managerId).toBe('mgr-9');
    expect(tx.team.create).toHaveBeenCalledWith({
      data: { name: 'New Team', managerId: 'mgr-9', organizationId: ORG },
    });
  });

  it('creates the team + writes an audit row on the happy path (OWNER)', async () => {
    const tx = makeTx({
      users: { 'mgr-9': { id: 'mgr-9', role: 'MANAGER' } },
      managerLedTeam: null,
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.create(ownerActor, {
      name: 'New Team',
      managerId: 'mgr-9',
    });
    expect(result).toMatchObject({
      id: 'new-team-1',
      name: 'New Team',
      managerId: 'mgr-9',
      memberCount: 0,
    });
    expect(tx.team.create).toHaveBeenCalledWith({
      data: { name: 'New Team', managerId: 'mgr-9', organizationId: ORG },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'team.create', entityId: 'new-team-1' }),
      }),
    );
  });

  it('allows a null managerId (unmanaged team)', async () => {
    const tx = makeTx();
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.create(adminActor, { name: 'Unled Team' });
    expect(result.managerId).toBeNull();
    expect(tx.team.create).toHaveBeenCalledWith({
      data: { name: 'Unled Team', managerId: null, organizationId: ORG },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// update()
// ────────────────────────────────────────────────────────────────────────────

describe('TeamsService.update', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx();
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.update(managerActor, 'team-1', { name: 'Renamed' }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('404s when the team is missing or soft-deleted', async () => {
    makeTx({ teams: { 'team-1': null, 'team-deleted': { id: 'team-deleted', deletedAt: new Date() } } });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.update(adminActor, 'team-1', { name: 'Renamed' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
    await expect(
      svc.update(adminActor, 'team-deleted', { name: 'Renamed' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('T-TEAM-AUTHORITATIVE: allows reassigning to a managerId that already leads a DIFFERENT team', async () => {
    const tx = makeTx({
      teams: { 'team-1': { id: 'team-1', name: 'Team 1', managerId: null, deletedAt: null } },
      users: { 'mgr-9': { id: 'mgr-9', role: 'MANAGER' } },
      managerLedTeam: { id: 'team-other', name: 'Other Team' },
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.update(adminActor, 'team-1', { managerId: 'mgr-9' });
    expect(result.managerId).toBe('mgr-9');
    expect(tx.team.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ managerId: 'mgr-9' }) }),
    );
  });

  it('allows re-saving the SAME manager the team already has (no-op)', async () => {
    const tx = makeTx({
      teams: { 'team-1': { id: 'team-1', name: 'Team 1', managerId: 'mgr-1', deletedAt: null } },
      users: { 'mgr-1': { id: 'mgr-1', role: 'MANAGER', name: 'Maya' } },
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.update(adminActor, 'team-1', { managerId: 'mgr-1' });
    expect(result.managerId).toBe('mgr-1');
    // T-TEAM-AUTHORITATIVE (2026-09-13): the "already leads a team" guard
    // is gone, so assertManagerAssignable no longer issues a ledTeam
    // lookup at all - only the user-role lookup remains.
    expect(tx.team.findFirst).not.toHaveBeenCalled();
  });

  it('renames + writes an audit row on the happy path', async () => {
    const tx = makeTx({
      teams: { 'team-1': { id: 'team-1', name: 'Old Name', managerId: null, deletedAt: null } },
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.update(adminActor, 'team-1', { name: 'New Name' });
    expect(result.name).toBe('New Name');
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'team.update',
          before: { name: 'Old Name', managerId: null },
          after: { name: 'New Name', managerId: null },
        }),
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// remove()
// ────────────────────────────────────────────────────────────────────────────

describe('TeamsService.remove', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx();
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.remove(managerActor, 'team-1')).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });

  it('404s when the team is missing or soft-deleted', async () => {
    makeTx({ teams: { 'team-1': null } });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.remove(adminActor, 'team-1')).rejects.toMatchObject({
      name: 'NotFoundException',
    });
  });

  it('409s when the team still has members', async () => {
    makeTx({
      teams: { 'team-1': { id: 'team-1', name: 'Team 1', managerId: null, deletedAt: null } },
      memberCount: 3,
    });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.remove(adminActor, 'team-1')).rejects.toMatchObject({
      name: 'ConflictException',
      message: expect.stringContaining('3 member(s)'),
    });
  });

  it('409s when the team still has an active manager (even with zero members)', async () => {
    makeTx({
      teams: { 'team-1': { id: 'team-1', name: 'Team 1', managerId: 'mgr-1', deletedAt: null } },
      users: { 'mgr-1': { id: 'mgr-1', role: 'MANAGER', name: 'Maya Rao' } },
      memberCount: 0,
    });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.remove(adminActor, 'team-1')).rejects.toMatchObject({
      name: 'ConflictException',
      message: expect.stringContaining('still led by Maya Rao'),
    });
  });

  it('soft-deletes (deletedAt set, not a hard delete) + writes an audit row on the happy path', async () => {
    const tx = makeTx({
      teams: { 'team-1': { id: 'team-1', name: 'Team 1', managerId: null, deletedAt: null } },
      memberCount: 0,
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.remove(ownerActor, 'team-1');
    expect(result).toEqual({ id: 'team-1' });
    expect(tx.team.update).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'team.delete', entityId: 'team-1' }),
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reassignMembers()
// ────────────────────────────────────────────────────────────────────────────

describe('TeamsService.reassignMembers', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx();
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.reassignMembers(managerActor, 'team-1', { targetTeamId: 'team-2' }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('400s when targetTeamId equals the source team', async () => {
    makeTx();
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.reassignMembers(adminActor, 'team-1', { targetTeamId: 'team-1' }),
    ).rejects.toMatchObject({ name: 'BadRequestException' });
  });

  it('404s when the source team is missing', async () => {
    makeTx({ teams: { 'team-1': null, 'team-2': { id: 'team-2', deletedAt: null } } });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.reassignMembers(adminActor, 'team-1', { targetTeamId: 'team-2' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('404s when the target team is missing or soft-deleted', async () => {
    makeTx({
      teams: {
        'team-1': { id: 'team-1', deletedAt: null },
        'team-2': { id: 'team-2', deletedAt: new Date() },
      },
    });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.reassignMembers(adminActor, 'team-1', { targetTeamId: 'team-2' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('400s when there are no matching members to reassign', async () => {
    makeTx({
      teams: { 'team-1': { id: 'team-1', deletedAt: null }, 'team-2': { id: 'team-2', deletedAt: null } },
      memberCount: 0,
    });
    const svc = new TeamsService({ $client: {} } as never);
    await expect(
      svc.reassignMembers(adminActor, 'team-1', { targetTeamId: 'team-2' }),
    ).rejects.toMatchObject({ name: 'BadRequestException' });
  });

  it('bulk (no userIds) moves EVERY member of the source team + audits', async () => {
    const tx = makeTx({
      teams: { 'team-1': { id: 'team-1', deletedAt: null }, 'team-2': { id: 'team-2', deletedAt: null } },
      memberCount: 4,
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.reassignMembers(adminActor, 'team-1', { targetTeamId: 'team-2' });
    expect(result).toEqual({ count: 4 });
    expect(tx.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { teamId: 'team-1' },
    });
    expect(tx.teamMember.createMany).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'team.reassign_members',
          before: { sourceTeamId: 'team-1', memberCount: 4 },
          after: { targetTeamId: 'team-2' },
        }),
      }),
    );
  });

  it('single (userIds=[x]) moves ONLY that member', async () => {
    const tx = makeTx({
      teams: { 'team-1': { id: 'team-1', deletedAt: null }, 'team-2': { id: 'team-2', deletedAt: null } },
      memberCount: 1,
    });
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.reassignMembers(ownerActor, 'team-1', {
      targetTeamId: 'team-2',
      userIds: ['u-x'],
    });
    expect(result).toEqual({ count: 1 });
    expect(tx.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u-x'] }, teamId: 'team-1' },
    });
    expect(tx.teamMember.createMany).toHaveBeenCalled();
  });
});
