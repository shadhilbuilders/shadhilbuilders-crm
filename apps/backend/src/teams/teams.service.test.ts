// Teams service tests - T-Sidebar07 (2026-09-05).
//
// Pins:
//   1. withRlsContext is called with the actor's userId, role, teamId
//      (so RLS policies see the right session vars - critical for
//      the Team table which has FORCE RLS).
//   2. The callback passed to withRlsContext queries the team table
//      with the right shape: filters to rows where the actor appears
//      in the members relation (defense-in-depth on top of the RLS
//      policy), selects id+name+defaultAssigneeId+_count, orders by
//      name asc.
//   3. The mapping to the public TeamListItem shape preserves all
//      fields and renames _count.members to memberCount.
//
// Test strategy: stub withRlsContext to invoke the callback with a
// fake tx that records the findMany args and returns canned rows.
// The service gets a fake PrismaService ({ $client: {} }).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

// Track the tx that withRlsContext hands to the callback so tests
// can introspect what findMany was called with.
const txCapture: { current: unknown } = { current: undefined };

vi.mock('@shadhil/database', () => {
  const tx = {
    team: {
      findMany: vi.fn(async () => [
        {
          id: 'team-construction',
          name: "Manager (placeholder)'s Team",
          defaultAssigneeId: 'tc-1',
          _count: { members: 4 },
        },
        {
          id: 'team-real-estate',
          name: 'Real Estate Desk',
          defaultAssigneeId: 'se-1',
          _count: { members: 2 },
        },
      ]),
    },
  };
  return {
    prisma: {},
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
                callback: (t: any) => unknown,
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
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const telecallerActor: JwtPayload = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  teamId: 'team-construction',
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
    });
  });

  it('queries teams with the actor in the members relation and the right select shape', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(ownerActor);
        const tx = txCapture.current as any;
    expect(tx).toBeDefined();
    expect(tx.team.findMany).toHaveBeenCalledTimes(1);
        const args = (tx.team.findMany.mock.calls[0]![0] as any);
    // OWNER is an overseer: no membership filter (sees every project).
    expect(args.where).toEqual({});
    expect(args.select).toMatchObject({
      id: true,
      name: true,
      defaultAssigneeId: true,
      _count: { select: { members: true } },
    });
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('scopes non-overseer roles to their team memberships', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(telecallerActor);
        const tx = txCapture.current as any;
    const args = (tx.team.findMany.mock.calls[0]![0] as any);
    expect(args.where).toEqual({ members: { some: { id: 'tc-1' } } });
  });

  it('maps the prisma row to the public TeamListItem shape (renames _count.members -> memberCount)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.list(ownerActor);
    expect(result).toEqual([
      {
        id: 'team-construction',
        name: "Manager (placeholder)'s Team",
        defaultAssigneeId: 'tc-1',
        memberCount: 4,
      },
      {
        id: 'team-real-estate',
        name: 'Real Estate Desk',
        defaultAssigneeId: 'se-1',
        memberCount: 2,
      },
    ]);
  });
});