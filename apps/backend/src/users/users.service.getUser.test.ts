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
//   8. `manager` ("Reports to", T-REPORTS-TO-OWNER 2026-10-06): a
//      TELECALLER/SALES_EXEC's is their team's manager; a MANAGER/ADMIN's
//      is the org OWNER (fixed, resolved via `findOrgOwner`, not their
//      resolvable team's manager even when one exists); an OWNER's is null.
//   9. projects come from the target's TEAM's ProjectTeam rows
//      (T-TEAM-AUTHORITATIVE 2026-09-13 clean cutover: ProjectMember, the
//      per-user link this used to read, was retired)

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

/** T-REPORTS-TO-OWNER: the org's single OWNER row - findOrgOwner()'s
 * fixture (a MANAGER/ADMIN's fixed "Reports to" target). */
const orgOwner = { id: 'owner-1', name: 'Deepak Owner', email: 'owner@x' };

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
    projectTeams: Array<{ project: { id: string; name: string } }>;
  } | null;
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
    projectTeams: [{ project: { id: 'proj-1', name: 'Metro Heights' } }],
  },
};

const managerRow: FakeUserRow = {
  id: 'mgr-1',
  email: 'ravi@x',
  name: 'Ravi Manager',
  role: 'MANAGER',
  teamId: null,
  // A manager can still have a `team` relation resolved (e.g. via a
  // different link) - the point of the test is that `manager` ("Reports
  // to") is the org OWNER regardless, NOT this resolvable team's manager
  // (T-REPORTS-TO-OWNER - fixed, not derived from Team.managerId).
  team: {
    id: 'team-1',
    name: "Ravi's Team",
    manager: { id: 'mgr-1', name: 'Ravi Manager', email: 'ravi@x' },
    projectTeams: [],
  },
};

const adminRow: FakeUserRow = {
  id: 'admin-2',
  email: 'second-admin@x',
  name: 'Second Admin',
  role: 'ADMIN',
  teamId: null,
  team: null,
};

const ownerRow: FakeUserRow = {
  id: 'owner-1',
  email: 'owner@x',
  name: 'Deepak Owner',
  role: 'OWNER',
  teamId: null,
  team: null,
};

function makeService(opts: {
  user: FakeUserRow | null;
  /** The ACTOR's own managed-team id, when the actor is a MANAGER doing
   * getUser()'s scope check (a DIFFERENT query from resolveDisplayTeamId's
   * per-target lookup below). */
  managerTeamId?: string | null;
}) {
  const userFindUnique = vi.fn().mockResolvedValue(
    opts.user === null
      ? null
      : { id: opts.user.id, email: opts.user.email, name: opts.user.name, role: opts.user.role },
  );
  // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): two DISTINCT
  // team.findFirst-shaped consumers now share this table:
  //   1. resolveDisplayTeamId(target) - `where: { managerId: target.id }` -
  //      only matches when the FIXTURE user is itself a MANAGER with a team.
  //   2. (none else uses findFirst here - the actor's own MANAGER scope
  //      check uses findMany, mocked separately below via managerTeamId.)
  const teamFindFirst = vi.fn(async (args: { where: { managerId: string } }) => {
    if (
      opts.user?.role === 'MANAGER' &&
      args.where.managerId === opts.user.id &&
      opts.user.team !== null
    ) {
      return { id: opts.user.team.id };
    }
    return null;
  });
  // getUser()'s MANAGER scope check resolves via findMany (a manager may
  // lead multiple teams) - this is the ACTOR's own managed-team set.
  const teamFindMany = vi
    .fn()
    .mockResolvedValue(
      opts.managerTeamId !== undefined && opts.managerTeamId !== null
        ? [{ id: opts.managerTeamId }]
        : [],
    );
  // resolveDisplayTeamId's non-MANAGER branch: the fixture user's own
  // (single, oldest) TeamMember row.
  const teamMemberFindFirst = vi.fn().mockResolvedValue(
    opts.user?.role !== 'MANAGER' && opts.user?.team !== null && opts.user !== null
      ? { teamId: opts.user.team!.id }
      : null,
  );
  // The resolved team's full detail (manager + linked projects) - only one
  // team fixture is ever in play per test, so this ignores the id filter.
  const teamFindUnique = vi.fn().mockResolvedValue(opts.user?.team ?? null);
  // T-REPORTS-TO-OWNER: findOrgOwner() resolves the org's OWNER via
  // `user.findFirst({ where: { role: 'OWNER', ... } })` - every test gets
  // the same fixture org owner (overridable via a direct mock override
  // when a test needs a different/absent owner).
  const userFindFirst = vi.fn().mockResolvedValue(orgOwner);
  // ADMIN/OWNER targets take the "sees every org project" branch - needed
  // now that adminRow/ownerRow fixtures reach getUser() too.
  const projectFindMany = vi.fn().mockResolvedValue([]);
  // getUser() now runs entirely inside ONE withRlsContext transaction, so
  // the tx handed to the callback must expose every accessor the method
  // touches (the outer client's shape alone is not enough). The mocks are
  // shared between both so assertions still see the calls.
  const txMock = {
    user: { findUnique: userFindUnique, findFirst: userFindFirst },
    team: { findFirst: teamFindFirst, findMany: teamFindMany, findUnique: teamFindUnique },
    teamMember: { findFirst: teamMemberFindFirst },
    project: { findMany: projectFindMany },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };
  const fakeClient = {
    user: { findUnique: userFindUnique, findFirst: userFindFirst },
    team: { findFirst: teamFindFirst, findMany: teamFindMany, findUnique: teamFindUnique },
    teamMember: { findFirst: teamMemberFindFirst },
    project: { findMany: projectFindMany },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock),
  } as never;
  const prismaService = { $client: fakeClient } as never;
  return {
    service: new UsersService(prismaService),
    mocks: {
      userFindUnique,
      userFindFirst,
      teamFindFirst,
      teamFindMany,
      teamMemberFindFirst,
      teamFindUnique,
      projectFindMany,
    },
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

describe('getUser - "Reports to" depends on the TARGET role (T-REPORTS-TO-OWNER)', () => {
  it('a MANAGER row reports to the org OWNER, NOT its resolvable team\'s manager', async () => {
    const { service, mocks } = makeService({ user: managerRow });
    const result = await service.getUser(adminActor, managerRow.id);
    expect(result.manager).toEqual(orgOwner);
    expect(result.teamName).toBe("Ravi's Team");
    expect(mocks.userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: 'OWNER' }) }),
    );
  });

  it('an ADMIN row reports to the org OWNER', async () => {
    const { service } = makeService({ user: adminRow });
    const result = await service.getUser(ownerActor, adminRow.id);
    expect(result.manager).toEqual(orgOwner);
  });

  it('the OWNER row reports to nobody', async () => {
    const { service, mocks } = makeService({ user: ownerRow });
    const result = await service.getUser(adminActor, ownerRow.id);
    expect(result.manager).toBeNull();
    // Not even looked up - OWNER never reports to itself.
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it('MANAGER/ADMIN still resolve to null when the org has no OWNER row', async () => {
    const { service, mocks } = makeService({ user: managerRow });
    mocks.userFindFirst.mockResolvedValueOnce(null);
    const result = await service.getUser(adminActor, managerRow.id);
    expect(result.manager).toBeNull();
  });

  it('SALES_EXEC on a team with no manager assigned → manager is null', async () => {
    const noManager: FakeUserRow = {
      ...salesExec,
      team: { id: 'team-2', name: 'Unled Team', manager: null, projectTeams: [] },
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
