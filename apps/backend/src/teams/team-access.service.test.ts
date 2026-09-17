// TeamAccessService tests - T-TEAM-AUTHORITATIVE (2026-09-13).
//
// Pure unit tests against a fake `tx` (no withRlsContext involved - the
// service is transaction-bound and takes a tx directly, so callers own the
// RLS context). Covers the authorization-matrix rules from the design doc:
//   - OWNER/ADMIN see/manage every org team and project.
//   - MANAGER sees managed UNION ordinary-member teams; may only MUTATE
//     teams they manage.
//   - Other staff see only ordinary-member teams; may mutate none.

import { describe, expect, it, vi } from 'vitest';

import { TeamAccessService } from './team-access.service';

// T-ORG-EXPLICIT (2026-09-16): every scoping call now takes/targets an explicit
// organisation. `organizationId` is REQUIRED on AccessActor so an absent org
// fails to compile instead of degrading into an unscoped query.
const ORG = 'org-test-1';
const actor = (sub: string, role: 'ADMIN' | 'OWNER' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC') => ({
  sub,
  role,
  organizationId: ORG,
});

type TxMock = {
  team: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  teamMember: { findMany: ReturnType<typeof vi.fn> };
  projectTeam: { findMany: ReturnType<typeof vi.fn> };
  project: { findMany: ReturnType<typeof vi.fn> };
};

function makeTx(overrides: Partial<{
  teams: { id: string }[];
  memberTeamIds: { teamId: string }[];
  projectTeamRows: { projectId: string }[];
  projects: { id: string }[];
}> = {}): TxMock {
  return {
    team: {
      findMany: vi.fn(async () => overrides.teams ?? []),
      // canMutateTeam now resolves the team in the actor's org.
      findFirst: vi.fn(async (args: { where?: { id?: string } }) =>
        (overrides.teams ?? []).some((t) => t.id === args?.where?.id) ? { id: args.where?.id } : null,
      ),
    },
    teamMember: {
      findMany: vi.fn(async () => overrides.memberTeamIds ?? []),
    },
    projectTeam: {
      findMany: vi.fn(async () => overrides.projectTeamRows ?? []),
    },
    project: {
      findMany: vi.fn(async () => overrides.projects ?? []),
    },
  };
}

const service = new TeamAccessService();

describe('TeamAccessService.getManagedTeamIds', () => {
  it('queries active teams managed by the given user', async () => {
    const tx = makeTx({ teams: [{ id: 'team-a' }, { id: 'team-b' }] });
    const ids = await service.getManagedTeamIds(tx as never, 'mgr-1', ORG);
    expect(ids).toEqual(['team-a', 'team-b']);
    expect(tx.team.findMany).toHaveBeenCalledWith({
      where: { managerId: 'mgr-1', deletedAt: null, organizationId: ORG },
      select: { id: true },
    });
  });
});

describe('TeamAccessService.getOrdinaryMemberTeamIds', () => {
  it('queries TeamMember rows for active teams', async () => {
    const tx = makeTx({ memberTeamIds: [{ teamId: 'team-x' }] });
    const ids = await service.getOrdinaryMemberTeamIds(tx as never, 'user-1', ORG);
    expect(ids).toEqual(['team-x']);
    expect(tx.teamMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', organizationId: ORG, team: { deletedAt: null } },
      select: { teamId: true },
    });
  });
});

describe('TeamAccessService.getAccessibleTeamIds', () => {
  it('ADMIN sees every active org team, ignoring membership', async () => {
    const tx = makeTx({ teams: [{ id: 'team-a' }, { id: 'team-b' }] });
    const ids = await service.getAccessibleTeamIds(tx as never, {
      sub: 'admin-1',
      role: 'ADMIN',
      organizationId: ORG,
    });
    expect(ids).toEqual(['team-a', 'team-b']);
    expect(tx.teamMember.findMany).not.toHaveBeenCalled();
  });

  it('OWNER travels the same admin-class path as ADMIN', async () => {
    const tx = makeTx({ teams: [{ id: 'team-a' }] });
    const ids = await service.getAccessibleTeamIds(tx as never, {
      sub: 'owner-1',
      role: 'OWNER',
      organizationId: ORG,
    });
    expect(ids).toEqual(['team-a']);
  });

  it('MANAGER sees the union of managed and ordinary-member teams, deduped', async () => {
    const tx: TxMock = {
      team: {
        findMany: vi.fn(async () => [{ id: 'team-managed' }]),
        findFirst: vi.fn(async () => null),
      },
      teamMember: {
        findMany: vi.fn(async () => [{ teamId: 'team-member' }, { teamId: 'team-managed' }]),
      },
      projectTeam: { findMany: vi.fn(async () => []) },
      project: { findMany: vi.fn(async () => []) },
    };
    const ids = await service.getAccessibleTeamIds(tx as never, {
      sub: 'mgr-1',
      role: 'MANAGER',
      organizationId: ORG,
    });
    expect([...ids].sort()).toEqual(['team-managed', 'team-member']);
  });

  it('TELECALLER/SALES_EXEC see only ordinary-member teams (plus any they manage, structurally none)', async () => {
    const tx = makeTx({ memberTeamIds: [{ teamId: 'team-x' }] });
    const ids = await service.getAccessibleTeamIds(tx as never, {
      sub: 'tc-1',
      role: 'TELECALLER',
      organizationId: ORG,
    });
    expect(ids).toEqual(['team-x']);
    // Non-admin path always checks Team.managerId too (getManagedTeamIds),
    // not just TeamMember - a TELECALLER structurally never manages a team,
    // but the query itself is role-agnostic by design (one code path).
    expect(tx.team.findMany).toHaveBeenCalledWith({
      where: { managerId: 'tc-1', deletedAt: null, organizationId: ORG },
      select: { id: true },
    });
  });
});

describe('TeamAccessService.getMutableTeamIds / canMutateTeam', () => {
  it('ADMIN/OWNER may mutate every active org team', async () => {
    const tx = makeTx({ teams: [{ id: 'team-a' }, { id: 'team-b' }] });
    const ids = await service.getMutableTeamIds(tx as never, {
      sub: 'admin-1',
      role: 'ADMIN',
      organizationId: ORG,
    });
    expect(ids).toEqual(['team-a', 'team-b']);
    // T-ORG-EXPLICIT: canMutateTeam now resolves the team in the actor's org
    // instead of returning `true` unconditionally for an admin.
    expect(
      await service.canMutateTeam(tx as never, actor('admin-1', 'ADMIN'), 'team-a'),
    ).toBe(true);
    expect(
      await service.canMutateTeam(tx as never, actor('admin-1', 'ADMIN'), 'team-in-other-org'),
    ).toBe(false);
  });

  it('MANAGER may mutate only teams they manage, not ordinary-member teams', async () => {
    const tx = makeTx({ teams: [{ id: 'team-managed' }] });
    const ids = await service.getMutableTeamIds(tx as never, {
      sub: 'mgr-1',
      role: 'MANAGER',
      organizationId: ORG,
    });
    expect(ids).toEqual(['team-managed']);

    expect(
      await service.canMutateTeam(tx as never, actor('mgr-1', 'MANAGER'), 'team-managed'),
    ).toBe(true);
    expect(
      await service.canMutateTeam(tx as never, actor('mgr-1', 'MANAGER'), 'team-other'),
    ).toBe(false);
  });

  it('other staff roles may mutate no teams', async () => {
    const tx = makeTx();
    expect(
      await service.getMutableTeamIds(tx as never, actor('tc-1', 'TELECALLER')),
    ).toEqual([]);
    expect(
      await service.canMutateTeam(tx as never, actor('tc-1', 'TELECALLER'), 'team-a'),
    ).toBe(false);
  });
});

describe('TeamAccessService.getProjectIdsForTeams', () => {
  it('returns an empty array without querying when given no team ids', async () => {
    const tx = makeTx();
    const ids = await service.getProjectIdsForTeams(tx as never, [], ORG);
    expect(ids).toEqual([]);
    expect(tx.projectTeam.findMany).not.toHaveBeenCalled();
  });

  it('dedupes project ids across multiple linked teams', async () => {
    const tx = makeTx({
      projectTeamRows: [{ projectId: 'proj-1' }, { projectId: 'proj-2' }, { projectId: 'proj-1' }],
    });
    const ids = await service.getProjectIdsForTeams(tx as never, ['team-a', 'team-b'], ORG);
    expect([...ids].sort()).toEqual(['proj-1', 'proj-2']);
    expect(tx.projectTeam.findMany).toHaveBeenCalledWith({
      where: { teamId: { in: ['team-a', 'team-b'] }, organizationId: ORG },
      select: { projectId: true },
    });
  });
});

describe('TeamAccessService.getAccessibleProjectIds', () => {
  it('ADMIN sees every active org project directly', async () => {
    const tx = makeTx({ projects: [{ id: 'proj-1' }, { id: 'proj-2' }] });
    const ids = await service.getAccessibleProjectIds(tx as never, {
      sub: 'admin-1',
      role: 'ADMIN',
      organizationId: ORG,
    });
    expect(ids).toEqual(['proj-1', 'proj-2']);
    expect(tx.teamMember.findMany).not.toHaveBeenCalled();
  });

  it('staff resolve projects via their accessible teams -> ProjectTeam', async () => {
    const tx: TxMock = {
      team: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      teamMember: { findMany: vi.fn(async () => [{ teamId: 'team-x' }]) },
      projectTeam: { findMany: vi.fn(async () => [{ projectId: 'proj-9' }]) },
      project: { findMany: vi.fn(async () => []) },
    };
    const ids = await service.getAccessibleProjectIds(tx as never, {
      sub: 'tc-1',
      role: 'TELECALLER',
      organizationId: ORG,
    });
    expect(ids).toEqual(['proj-9']);
    expect(tx.projectTeam.findMany).toHaveBeenCalledWith({
      where: { teamId: { in: ['team-x'] }, organizationId: ORG },
      select: { projectId: true },
    });
  });
});
