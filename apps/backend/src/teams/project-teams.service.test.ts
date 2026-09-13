// ProjectTeamsService tests - T-TEAM-AUTHORITATIVE (2026-09-13).
//
// Test strategy: stub withRlsContext to invoke the callback with a fake tx
// (mirrors teams.service.crud.test.ts's precedent).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

vi.mock('@shadhil/database', () => {
  return {
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

import { ProjectTeamsService } from './project-teams.service';

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
  project: { findUnique: ReturnType<typeof vi.fn> };
  team: { findUnique: ReturnType<typeof vi.fn> };
  projectTeam: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  teamMember: { findMany: ReturnType<typeof vi.fn> };
  lead: { count: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

function makeTx(overrides: Partial<{
  projects: Record<string, { id: string; deletedAt: Date | null; organizationId: string } | null>;
  teams: Record<
    string,
    { id: string; name: string; deletedAt: Date | null; managerId: string | null; organizationId: string } | null
  >;
  projectTeamLinks: Array<{
    teamId: string;
    team: { name: string; manager: { id: string; name: string } | null };
  }>;
  projectTeamLink: { teamId: string; projectId: string } | null;
  teamMembers: Array<{ userId: string; assignedAt: Date; user: { name: string; email: string; role: string } }>;
  leadCount: number;
  managers: Record<string, { id: string; name: string } | null>;
}> = {}): TxMock {
  const projects = overrides.projects ?? {};
  const teams = overrides.teams ?? {};
  const tx: TxMock = {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        projects[where.id] === undefined ? null : projects[where.id],
      ),
    },
    team: {
      findUnique: vi.fn(async (args: { where: { id: string }; select?: unknown }) => {
        const t = teams[args.where.id];
        if (t === undefined) return null;
        if (t === null) return null;
        if (args.select !== undefined) {
          const managerId = t.managerId;
          const manager =
            managerId !== null ? (overrides.managers?.[managerId] ?? { id: managerId, name: 'Manager' }) : null;
          return { manager };
        }
        return t;
      }),
    },
    projectTeam: {
      findMany: vi.fn(async () => overrides.projectTeamLinks ?? []),
      findUnique: vi.fn(async () =>
        overrides.projectTeamLink === undefined ? null : overrides.projectTeamLink,
      ),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    teamMember: {
      findMany: vi.fn(async () => overrides.teamMembers ?? []),
    },
    lead: {
      count: vi.fn(async () => overrides.leadCount ?? 0),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => overrides.managers?.[where.id] ?? null),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  (globalThis as { __tx?: unknown }).__tx = tx;
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __tx?: unknown }).__tx = undefined;
});

describe('ProjectTeamsService.list', () => {
  it('404s when the project is missing or soft-deleted', async () => {
    makeTx({ projects: { 'proj-1': null } });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(svc.list(adminActor, 'proj-1')).rejects.toMatchObject({
      name: 'NotFoundException',
    });
  });

  it('returns linked teams with roster, manager, lead count, and canUnlink', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      projectTeamLinks: [
        {
          teamId: 'team-a',
          team: { name: 'Metro Sales', manager: { id: 'mgr-a', name: 'Meera' } },
        },
      ],
      teamMembers: [
        {
          userId: 'user-1',
          assignedAt: new Date('2026-01-01T00:00:00Z'),
          user: { name: 'Priya', email: 'priya@x.in', role: 'TELECALLER' },
        },
      ],
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: 'mgr-a', organizationId: ORG },
      },
      managers: { 'mgr-a': { id: 'mgr-a', name: 'Meera' } },
      leadCount: 0,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    const result = await svc.list(adminActor, 'proj-1');
    expect(result.projectId).toBe('proj-1');
    expect(result.teams).toHaveLength(1);
    const row = result.teams[0]!;
    expect(row.teamId).toBe('team-a');
    expect(row.teamName).toBe('Metro Sales');
    expect(row.manager).toEqual({ id: 'mgr-a', name: 'Meera' });
    // 1 ordinary member + 1 manager slot.
    expect(row.memberCount).toBe(2);
    expect(row.members.find((m) => m.isManagerSlot)?.userId).toBe('mgr-a');
    expect(row.canUnlink).toBe(true);
  });

  it('canUnlink is false for a non-admin actor even with zero leads', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      projectTeamLinks: [
        { teamId: 'team-a', team: { name: 'Metro Sales', manager: null } },
      ],
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: null, organizationId: ORG },
      },
      leadCount: 0,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    const result = await svc.list(managerActor, 'proj-1');
    expect(result.teams[0]!.canUnlink).toBe(false);
  });

  it('canUnlink is false when the team still has leads on this project', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      projectTeamLinks: [
        { teamId: 'team-a', team: { name: 'Metro Sales', manager: null } },
      ],
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: null, organizationId: ORG },
      },
      leadCount: 3,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    const result = await svc.list(adminActor, 'proj-1');
    expect(result.teams[0]!.leadCount).toBe(3);
    expect(result.teams[0]!.canUnlink).toBe(false);
  });
});

describe('ProjectTeamsService.link', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx();
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(
      svc.link(managerActor, 'proj-1', { teamId: 'team-a' }),
    ).rejects.toMatchObject({ name: 'CodedForbiddenException' });
    await expect(
      svc.link(telecallerActor, 'proj-1', { teamId: 'team-a' }),
    ).rejects.toMatchObject({ name: 'CodedForbiddenException' });
  });

  it('404s when the project is missing', async () => {
    makeTx({ projects: { 'proj-1': null } });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(
      svc.link(adminActor, 'proj-1', { teamId: 'team-a' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('404s when the team is missing or soft-deleted', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: { 'team-a': null },
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(
      svc.link(adminActor, 'proj-1', { teamId: 'team-a' }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('rejects a team from a different organization (400 PROJECT_TEAM_CROSS_ORG)', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: {
        'team-a': {
          id: 'team-a',
          name: 'Foreign Team',
          deletedAt: null,
          managerId: 'mgr-a',
          organizationId: 'other-org',
        },
      },
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(
      svc.link(adminActor, 'proj-1', { teamId: 'team-a' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_TEAM_CROSS_ORG' }),
    });
  });

  it('rejects a managerless team (400 TEAM_MANAGERLESS)', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: {
        'team-a': { id: 'team-a', name: 'Orphan Team', deletedAt: null, managerId: null, organizationId: ORG },
      },
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(
      svc.link(ownerActor, 'proj-1', { teamId: 'team-a' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TEAM_MANAGERLESS' }),
    });
  });

  it('upserts the link and returns the roster row on success', async () => {
    const tx = makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: 'mgr-a', organizationId: ORG },
      },
      managers: { 'mgr-a': { id: 'mgr-a', name: 'Meera' } },
      leadCount: 0,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    const row = await svc.link(adminActor, 'proj-1', { teamId: 'team-a' });
    expect(tx.projectTeam.upsert).toHaveBeenCalledWith({
      where: { projectId_teamId: { projectId: 'proj-1', teamId: 'team-a' } },
      update: {},
      create: {
        projectId: 'proj-1',
        teamId: 'team-a',
        organizationId: ORG,
        assignedById: 'admin-1',
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(row.teamId).toBe('team-a');
    expect(row.manager).toEqual({ id: 'mgr-a', name: 'Meera' });
  });
});

describe('ProjectTeamsService.unlink', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx();
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(svc.unlink(managerActor, 'proj-1', 'team-a')).rejects.toMatchObject({
      name: 'CodedForbiddenException',
    });
  });

  it('404s (PROJECT_TEAM_NOT_LINKED) when the team is not linked', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: null, organizationId: ORG },
      },
      projectTeamLink: null,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(svc.unlink(adminActor, 'proj-1', 'team-a')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_TEAM_NOT_LINKED' }),
    });
  });

  it('409s (PROJECT_TEAM_HAS_LEADS) when leads still carry this pair', async () => {
    makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: null, organizationId: ORG },
      },
      projectTeamLink: { teamId: 'team-a', projectId: 'proj-1' },
      leadCount: 5,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    await expect(svc.unlink(adminActor, 'proj-1', 'team-a')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_TEAM_HAS_LEADS', details: { leadCount: 5 } }),
    });
  });

  it('deletes the link + audits on success', async () => {
    const tx = makeTx({
      projects: { 'proj-1': { id: 'proj-1', deletedAt: null, organizationId: ORG } },
      teams: {
        'team-a': { id: 'team-a', name: 'Metro Sales', deletedAt: null, managerId: null, organizationId: ORG },
      },
      projectTeamLink: { teamId: 'team-a', projectId: 'proj-1' },
      leadCount: 0,
    });
    const svc = new ProjectTeamsService({ $client: {} } as never);
    const result = await svc.unlink(adminActor, 'proj-1', 'team-a');
    expect(result).toEqual({ ok: true });
    expect(tx.projectTeam.delete).toHaveBeenCalledWith({
      where: { projectId_teamId: { projectId: 'proj-1', teamId: 'team-a' } },
    });
    expect(tx.auditLog.create).toHaveBeenCalled();
  });
});
