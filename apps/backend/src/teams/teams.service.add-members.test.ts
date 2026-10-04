// TeamsService.addMembers - POST /api/teams/:id/members.
// Pins: ADMIN/OWNER only; 404 team/users; 400 non-staff roles (MANAGER etc.);
// existing members skipped + reported; membership + audit written together.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

vi.mock('@shadhil/database', () => ({
  prisma: {},
  rlsContextFrom: vi.fn((a: { sub: string; role: string }) => ({
    userId: a.sub,
    role: a.role,
  })),
  withRlsContext: vi.fn(
    async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
      cb((globalThis as { __tx?: unknown }).__tx),
  ),
}));

import { TeamsService } from './teams.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const NOW = Math.floor(Date.now() / 1000);

function actor(overrides: Partial<JwtPayload>): JwtPayload {
  return {
    sub: 'admin-1',
    email: 'admin@shadhilbuilders.in',
    role: 'ADMIN',
    organizationId: ORG,
    iat: NOW,
    exp: NOW + 3600,
    iss: 'shadhil-bff',
    ...overrides,
  };
}

function makeTx(opts: {
  team?: { id: string; deletedAt: Date | null; organizationId?: string } | null;
  users?: Array<{ id: string; name: string; role: string }>;
  existing?: Array<{ userId: string }>;
}) {
  const tx = {
    team: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.team === undefined
            ? { id: 'team-1', deletedAt: null, organizationId: ORG }
            : opts.team,
        ),
    },
    user: { findMany: vi.fn().mockResolvedValue(opts.users ?? []) },
    teamMember: {
      findMany: vi.fn().mockResolvedValue(opts.existing ?? []),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  (globalThis as { __tx?: unknown }).__tx = tx;
  return tx;
}

const svc = () => new TeamsService({ $client: {} } as never);

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __tx?: unknown }).__tx = undefined;
});

describe('TeamsService.addMembers', () => {
  it('rejects non-ADMIN/OWNER actors', async () => {
    makeTx({});
    await expect(
      svc().addMembers(actor({ role: 'MANAGER' }), 'team-1', { userIds: ['u1'] }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('404s when the team is missing or soft-deleted', async () => {
    makeTx({ team: { id: 'team-1', deletedAt: new Date(), organizationId: ORG } });
    await expect(
      svc().addMembers(actor({}), 'team-1', { userIds: ['u1'] }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('404s for a team in another organization and writes nothing', async () => {
    const tx = makeTx({
      team: { id: 'team-1', deletedAt: null, organizationId: 'other-org' },
      users: [{ id: 'u1', name: 'Priya', role: 'TELECALLER' }],
    });
    await expect(
      svc().addMembers(actor({}), 'team-1', { userIds: ['u1'] }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
    expect(tx.teamMember.createMany).not.toHaveBeenCalled();
  });

  it('only looks up users inside the actor organization', async () => {
    const tx = makeTx({ users: [{ id: 'u1', name: 'Priya', role: 'TELECALLER' }] });
    await svc().addMembers(actor({}), 'team-1', { userIds: ['u1'] });
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, deletedAt: null }),
      }),
    );
  });

  it('404s naming users that are not in the org', async () => {
    makeTx({ users: [{ id: 'u1', name: 'Priya', role: 'TELECALLER' }] });
    await expect(
      svc().addMembers(actor({}), 'team-1', { userIds: ['u1', 'u2'] }),
    ).rejects.toThrow(/u2/);
  });

  it('400s for managers / admins (not team staff)', async () => {
    const tx = makeTx({ users: [{ id: 'u1', name: 'Maya', role: 'MANAGER' }] });
    await expect(
      svc().addMembers(actor({}), 'team-1', { userIds: ['u1'] }),
    ).rejects.toMatchObject({ name: 'BadRequestException' });
    expect(tx.teamMember.createMany).not.toHaveBeenCalled();
  });

  it('adds only new members, reports existing, and audits in the same tx', async () => {
    const tx = makeTx({
      users: [
        { id: 'u1', name: 'Priya', role: 'TELECALLER' },
        { id: 'u2', name: 'Vikram', role: 'SALES_EXEC' },
      ],
      existing: [{ userId: 'u2' }],
    });
    const result = await svc().addMembers(actor({}), 'team-1', {
      userIds: ['u1', 'u2', 'u1'],
    });
    expect(result).toEqual({ added: 1, alreadyMembers: 1 });
    expect(tx.teamMember.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', teamId: 'team-1', organizationId: ORG, assignedById: 'admin-1' },
      ],
      skipDuplicates: true,
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'team.add_members',
          after: { teamId: 'team-1', addedUserIds: ['u1'] },
        }),
      }),
    );
  });

  it('is a no-op (no write, no audit) when everyone is already a member', async () => {
    const tx = makeTx({
      users: [{ id: 'u1', name: 'Priya', role: 'TELECALLER' }],
      existing: [{ userId: 'u1' }],
    });
    const result = await svc().addMembers(actor({}), 'team-1', { userIds: ['u1'] });
    expect(result).toEqual({ added: 0, alreadyMembers: 1 });
    expect(tx.teamMember.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
