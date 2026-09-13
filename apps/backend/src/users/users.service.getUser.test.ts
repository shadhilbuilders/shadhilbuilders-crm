// Users service tests - GET /api/users/:id (autoplan 2026-09-13).
//
// Pins:
//   1. unknown user → 404 NotFoundException
//   2. OWNER/ADMIN can view anyone, incl. a SALES_EXEC's team + manager
//   3. MANAGER can view a member of their own team
//   4. MANAGER viewing a user OUTSIDE their team → 403 ForbiddenException
//   5. MANAGER can view themselves
//   6. staff (TELECALLER/SALES_EXEC) viewing another user → 403
//   7. staff viewing themselves → allowed
//   8. `manager` is populated ONLY for TELECALLER/SALES_EXEC (MANAGER/ADMIN
//      rows never report to a manager on this surface, even with a team)
//   9. projects come from the target's ProjectMember rows

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
    teamId: null,
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
const telecallerActor = actor({ sub: 'tc-1', role: 'TELECALLER', teamId: 'team-1' });

type FakeUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  teamId: string | null;
  team: {
    id: string;
    name: string;
    manager: { id: string; name: string; email: string } | null;
  } | null;
  projectMembers: Array<{ project: { id: string; name: string } }>;
};

const salesExec: FakeUserRow = {
  id: 'exec-1',
  email: 'exec@x',
  name: 'Priya Sharma',
  role: 'SALES_EXEC',
  teamId: 'team-1',
  team: {
    id: 'team-1',
    name: "Ravi's Team",
    manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@x' },
  },
  projectMembers: [{ project: { id: 'proj-1', name: 'Metro Heights' } }],
};

const managerRow: FakeUserRow = {
  id: 'mgr-1',
  email: 'ravi@x',
  name: 'Ravi Manager',
  role: 'MANAGER',
  teamId: null,
  // A manager can still have a `team` relation resolved (e.g. via a
  // different link) - the point of the test is that `manager` stays null
  // regardless, because MANAGER doesn't report to anyone on this surface.
  team: { id: 'team-1', name: "Ravi's Team", manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@x' } },
  projectMembers: [],
};

function makeService(opts: {
  user: FakeUserRow | null;
  managerTeamId?: string | null;
}) {
  const userFindUnique = vi.fn().mockResolvedValue(opts.user);
  const teamFindFirst = vi
    .fn()
    .mockResolvedValue(
      opts.managerTeamId !== undefined && opts.managerTeamId !== null
        ? { id: opts.managerTeamId }
        : null,
    );
  // T-TEAM-AUTHORITATIVE (2026-09-13): getUser()'s MANAGER scope check
  // resolves via findMany (a manager may lead multiple teams).
  const teamFindMany = vi
    .fn()
    .mockResolvedValue(
      opts.managerTeamId !== undefined && opts.managerTeamId !== null
        ? [{ id: opts.managerTeamId }]
        : [],
    );
  const fakeClient = {
    user: { findUnique: userFindUnique },
    team: { findFirst: teamFindFirst, findMany: teamFindMany },
  } as never;
  const prismaService = { $client: fakeClient } as never;
  return {
    service: new UsersService(prismaService),
    mocks: { userFindUnique, teamFindFirst, teamFindMany },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUser - not found', () => {
  it('throws NotFoundException for an unknown id', async () => {
    const { service } = makeService({ user: null });
    await expect(service.getUser(adminActor, 'nope')).rejects.toMatchObject({
      name: 'NotFoundException',
    });
  });
});

describe('getUser - ADMIN/OWNER scope', () => {
  it('ADMIN sees any user, incl. team + manager + projects', async () => {
    const { service } = makeService({ user: salesExec });
    const result = await service.getUser(adminActor, salesExec.id);
    expect(result).toEqual({
      id: 'exec-1',
      email: 'exec@x',
      name: 'Priya Sharma',
      role: 'SALES_EXEC',
      teamId: 'team-1',
      teamName: "Ravi's Team",
      manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@x' },
      projects: [{ id: 'proj-1', name: 'Metro Heights' }],
    });
  });

  it('OWNER sees any user too', async () => {
    const { service } = makeService({ user: salesExec });
    const result = await service.getUser(ownerActor, salesExec.id);
    expect(result.manager).toEqual({ id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@x' });
  });
});

describe('getUser - MANAGER scope', () => {
  it('MANAGER can view a member of their own team', async () => {
    const { service } = makeService({ user: salesExec, managerTeamId: 'team-1' });
    const result = await service.getUser(managerActor, salesExec.id);
    expect(result.id).toBe('exec-1');
  });

  it('MANAGER viewing a user outside their team → ForbiddenException', async () => {
    const { service } = makeService({ user: salesExec, managerTeamId: 'team-9' });
    await expect(
      service.getUser(otherManagerActor, salesExec.id),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('MANAGER can always view themselves, even without leading a team', async () => {
    const { service } = makeService({ user: managerRow, managerTeamId: null });
    const result = await service.getUser(managerActor, managerRow.id);
    expect(result.id).toBe('mgr-1');
  });
});

describe('getUser - staff scope', () => {
  it('TELECALLER viewing another user → ForbiddenException', async () => {
    const { service } = makeService({ user: managerRow });
    await expect(
      service.getUser(telecallerActor, managerRow.id),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('TELECALLER viewing themselves → allowed', async () => {
    const self: FakeUserRow = { ...salesExec, id: telecallerActor.sub, role: 'TELECALLER' };
    const { service } = makeService({ user: self });
    const result = await service.getUser(telecallerActor, telecallerActor.sub);
    expect(result.id).toBe(telecallerActor.sub);
  });
});

describe('getUser - manager field only applies to TELECALLER/SALES_EXEC', () => {
  it('a MANAGER row never reports a manager, even with a resolvable team', async () => {
    const { service } = makeService({ user: managerRow });
    const result = await service.getUser(adminActor, managerRow.id);
    expect(result.manager).toBeNull();
    expect(result.teamName).toBe("Ravi's Team");
  });

  it('SALES_EXEC on a team with no manager assigned → manager is null', async () => {
    const noManager: FakeUserRow = {
      ...salesExec,
      team: { id: 'team-2', name: 'Unled Team', manager: null },
    };
    const { service } = makeService({ user: noManager });
    const result = await service.getUser(adminActor, noManager.id);
    expect(result.manager).toBeNull();
    expect(result.teamName).toBe('Unled Team');
  });

  it('SALES_EXEC with no team at all → teamName and manager are null', async () => {
    const noTeam: FakeUserRow = { ...salesExec, teamId: null, team: null };
    const { service } = makeService({ user: noTeam });
    const result = await service.getUser(adminActor, noTeam.id);
    expect(result.teamId).toBeNull();
    expect(result.teamName).toBeNull();
    expect(result.manager).toBeNull();
  });
});
