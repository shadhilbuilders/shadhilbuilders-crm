// Teams service tests - T-Sidebar07 (2026-09-05) + org-Teams (2026-09-10).
//
// Pins:
//   1. withRlsContext is called with the actor's userId, role, teamId
//      (so RLS policies see the right session vars - critical for
//      the Team table which has FORCE RLS).
//   2. list(): filters to rows where the actor appears in the members
//      relation (defense-in-depth on top of the RLS policy); selects
//      id+name+defaultAssigneeId+manager(+name)+_count; orders by name asc.
//      Maps to TeamListItem with rename _count.members->memberCount AND a
//      managerName (null when unassigned).
//   3. getTeam(): ADMIN/OWNER only (403 otherwise); not-found -> 404; returns
//      manager + members each with their EXPLICIT project assignments UNION
//      lead-owner projects (isLeadOwner=true => read-only); explicit wins.
//
// Test strategy: stub withRlsContext to invoke the callback with a
// fake tx that records calls and returns canned rows.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

// Track the tx that withRlsContext hands to the callback so tests
// can introspect what was called.
const txCapture: { current: any } = { current: undefined };

vi.mock('@shadhil/database', () => {
  const tx = {
    team: {
      findMany: vi.fn(async () => [
        {
          id: 'team-construction',
          name: "Manager (placeholder)'s Team",
          defaultAssigneeId: 'tc-1',
          managerId: 'mgr-1',
          manager: { name: 'Maya Rao' },
          _count: { members: 4 },
        },
        {
          id: 'team-real-estate',
          name: 'Real Estate Desk',
          defaultAssigneeId: 'se-1',
          managerId: null,
          manager: null,
          _count: { members: 2 },
        },
      ]),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === 'team-missing') return null;
        if (args.where.id === 'team-real-estate') {
          return {
            id: 'team-real-estate',
            name: 'Real Estate Desk',
            manager: null,
          };
        }
        return {
          id: 'team-construction',
          name: "Manager (placeholder)'s Team",
          manager: { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x' },
        };
      }),
    },
    user: {
      findMany: vi.fn(async () => [
        {
          id: 'u-tc',
          name: 'Tele Caller One',
          email: 'tc1@x',
          role: 'TELECALLER',
          // Explicit member of one project + lead-owner of another.
          projectMembers: [
            { project: { id: 'p-1', name: 'Metro' }, role: 'TELECALLER' },
          ],
          ownedLeads: [{ project: { id: 'p-1', name: 'Metro' } }, { project: { id: 'p-2', name: 'Skyline' } }],
          coOwnedLeads: [],
        },
      ]),
    },
  };
  return {
    prisma: {},
    rlsContextFrom: vi.fn((actor: {
      sub: string;
      role: string;
      teamId: string | null;
      organizationId?: string | null;
    }) => ({
      userId: actor.sub,
      role: actor.role,
      teamId: actor.teamId,
      organizationId: actor.organizationId ?? 'ceid01lpfe1esm8jwsxid41k28',
    })),
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
        callback: (t: typeof tx) => unknown,
      ) => {
        txCapture.current = tx;
        return callback(tx);
      },
    ),
  };
});

import { TeamsService } from './teams.service';
import { withRlsContext } from '@shadhil/database';

const ownerActor: JwtPayload = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  teamId: 'team-construction',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const managerActor: JwtPayload = {
  sub: 'mgr-1',
  email: 'mgr@shadhilbuilders.in',
  role: 'MANAGER',
  teamId: 'team-construction',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const telecallerActor: JwtPayload = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  teamId: 'team-construction',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

describe('TeamsService.list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = undefined;
  });

  it('passes the actor identity to withRlsContext so RLS sees the right session vars', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(ownerActor);
    expect(withRlsContext).toHaveBeenCalledTimes(1);
    const ctx = (withRlsContext as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1];
    expect(ctx).toEqual({
      userId: 'owner-1',
      role: 'OWNER',
      teamId: 'team-construction',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
  });

  it('queries teams with the actor in the members relation and the right select shape', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(ownerActor);
    const tx = txCapture.current;
    expect(tx).toBeDefined();
    expect(tx.team.findMany).toHaveBeenCalledTimes(1);
    const args = tx.team.findMany.mock.calls[0]![0];
    // OWNER is an overseer: no membership filter (sees every project).
    expect(args.where).toEqual({});
    expect(args.select).toMatchObject({
      id: true,
      name: true,
      defaultAssigneeId: true,
      managerId: true,
      manager: { select: { name: true } },
      _count: { select: { members: true } },
    });
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('scopes non-overseer roles to their team memberships', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(telecallerActor);
    const tx = txCapture.current;
    const args = tx.team.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ members: { some: { id: 'tc-1' } } });
  });

  it('maps to TeamListItem with managerName (null when unassigned)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.list(ownerActor);
    expect(result).toEqual([
      {
        id: 'team-construction',
        name: "Manager (placeholder)'s Team",
        defaultAssigneeId: 'tc-1',
        memberCount: 4,
        managerId: 'mgr-1',
        managerName: 'Maya Rao',
      },
      {
        id: 'team-real-estate',
        name: 'Real Estate Desk',
        defaultAssigneeId: 'se-1',
        memberCount: 2,
        managerId: null,
        managerName: null,
      },
    ]);
  });
});

describe('TeamsService.getTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = undefined;
  });

  it('forbids non-admin roles (ADMIN/OWNER only)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.getTeam(managerActor, 'team-construction')).rejects.toThrow(
      /ADMIN or OWNER/,
    );
    await expect(svc.getTeam(telecallerActor, 'team-construction')).rejects.toThrow(
      /ADMIN or OWNER/,
    );
  });

  it('throws 404 when the team does not exist', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.getTeam(ownerActor, 'team-missing')).rejects.toThrow(
      /not found/,
    );
  });

  it('returns manager + members with explicit AND lead-owner project union', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.getTeam(ownerActor, 'team-construction');
    expect(result).toEqual({
      id: 'team-construction',
      name: "Manager (placeholder)'s Team",
      manager: { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x' },
      members: [
        {
          userId: 'u-tc',
          name: 'Tele Caller One',
          email: 'tc1@x',
          role: 'TELECALLER',
          projects: [
            { projectId: 'p-1', projectName: 'Metro', role: 'TELECALLER', isLeadOwner: false },
            { projectId: 'p-2', projectName: 'Skyline', role: 'TELECALLER', isLeadOwner: true },
          ],
        },
      ],
    });
  });

  it('returns a null manager when the team has none', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.getTeam(ownerActor, 'team-real-estate');
    expect(result.manager).toBeNull();
    // findUnique for real-estate returns manager null; user.findMany default
    // resolves to the u-tc member row.
    expect(result.id).toBe('team-real-estate');
  });
});
