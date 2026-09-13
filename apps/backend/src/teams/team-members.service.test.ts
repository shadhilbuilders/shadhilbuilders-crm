// TeamMembersService tests - T-TEAM-AUTHORITATIVE (2026-09-13).
//
// Test strategy: stub withRlsContext to invoke the callback with a fake tx
// (mirrors teams.service.crud.test.ts / project-teams.service.test.ts).
// TeamAccessService is injected as a plain stub (`canMutateTeam`) rather
// than the real implementation - its own behavior is covered by
// team-access.service.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

vi.mock('@shadhil/database', () => {
  return {
    Prisma: { sql: (...args: unknown[]) => args },
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
        callback: (t: unknown) => unknown,
      ) => callback((globalThis as { __tx?: unknown }).__tx),
    ),
  };
});

import { computePreviewToken } from './team-removal.util';
import { TeamMembersService } from './team-members.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const NOW = Math.floor(Date.now() / 1000);
const TEAM_ID = 'team-a';
const TARGET_ID = 'target-1';

function actor(overrides: Partial<JwtPayload>): JwtPayload {
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

const adminActor = actor({ sub: 'admin-1', role: 'ADMIN' });

type Lead = {
  id: string;
  updatedAt: Date;
  ownerId: string;
  coOwnerId: string | null;
  state: string;
  projectId: string | null;
};

function makeTx(overrides: Partial<{
  team: { id: string; managerId: string | null; deletedAt: Date | null } | null;
  targetMembership: { userId: string; teamId: string } | null;
  leads: Array<Lead & { project?: { name: string } | null }>;
  teamMembers: Array<{ userId: string; user: { name: string; role: string } }>;
  manager: { name: string; role: string } | null;
  queryRawSequence: unknown[][];
  existingAudit: { batchId: string | null; after: unknown } | null;
  membershipRowPresent: boolean;
  candidateMembership: { userId: string; user: { name: string; role: string } } | null;
  candidateManager: { name: string; role: string } | null;
}> = {}) {
  const queryRawCalls = overrides.queryRawSequence ?? [];
  let callIndex = 0;
  const tx = {
    team: {
      findUnique: vi.fn(async () => overrides.team ?? null),
    },
    teamMember: {
      findUnique: vi.fn(async (args: { where: { userId_teamId: { userId: string; teamId: string } } }) => {
        const { userId } = args.where.userId_teamId;
        if (userId === TARGET_ID) {
          return overrides.membershipRowPresent === false ? null : (overrides.targetMembership ?? { userId, teamId: TEAM_ID });
        }
        return overrides.candidateMembership ?? null;
      }),
      findMany: vi.fn(async () => overrides.teamMembers ?? []),
      delete: vi.fn(async () => ({})),
    },
    user: {
      findUnique: vi.fn(async () => overrides.manager ?? overrides.candidateManager ?? null),
    },
    lead: {
      findMany: vi.fn(async () => overrides.leads ?? []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      findUnique: vi.fn(async () => overrides.existingAudit ?? null),
      create: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
    $queryRaw: vi.fn(async () => {
      const result = queryRawCalls[callIndex] ?? [];
      callIndex += 1;
      return result;
    }),
  };
  (globalThis as { __tx?: unknown }).__tx = tx;
  return tx;
}

function stubAccess(canMutate: boolean) {
  return { canMutateTeam: vi.fn(async () => canMutate) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __tx?: unknown }).__tx = undefined;
});

// ────────────────────────────────────────────────────────────────────────────
// preview()
// ────────────────────────────────────────────────────────────────────────────

describe('TeamMembersService.preview', () => {
  it('rejects when the actor cannot mutate this team', async () => {
    makeTx();
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(false));
    await expect(svc.preview(adminActor, TEAM_ID, TARGET_ID)).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });

  it('404s when the team is missing or soft-deleted', async () => {
    makeTx({ team: null });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(svc.preview(adminActor, TEAM_ID, TARGET_ID)).rejects.toMatchObject({
      name: 'NotFoundException',
    });
  });

  it('404s (TARGET_NOT_TEAM_MEMBER) when the target has no TeamMember row', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      membershipRowPresent: false,
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(svc.preview(adminActor, TEAM_ID, TARGET_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TARGET_NOT_TEAM_MEMBER' }),
    });
  });

  it('zero affected leads: succeeds with no candidates computed', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      leads: [],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    const result = await svc.preview(adminActor, TEAM_ID, TARGET_ID);
    expect(result.totalAffectedLeads).toBe(0);
    expect(result.ownedCount).toBe(0);
    expect(result.coOwnedCount).toBe(0);
    expect(result.eligibleReplacements).toEqual([]);
    expect(result.previewToken).toBe(computePreviewToken([]));
  });

  it('409s (TOO_MANY_AFFECTED_LEADS) above the 1000 cap', async () => {
    const leads = Array.from({ length: 1001 }, (_, i) => ({
      id: `lead-${i}`,
      updatedAt: new Date(),
      ownerId: TARGET_ID,
      coOwnerId: null,
      state: 'NEW',
      projectId: null,
    }));
    makeTx({ team: { id: TEAM_ID, managerId: null, deletedAt: null }, leads });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(svc.preview(adminActor, TEAM_ID, TARGET_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TOO_MANY_AFFECTED_LEADS' }),
    });
  });

  it('404s (LAST_TEAM_PARTICIPANT) when leads exist but no other member/manager', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      leads: [
        { id: 'lead-1', updatedAt: new Date(), ownerId: TARGET_ID, coOwnerId: null, state: 'NEW', projectId: null },
      ],
      teamMembers: [],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(svc.preview(adminActor, TEAM_ID, TARGET_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LAST_TEAM_PARTICIPANT' }),
    });
  });

  it('404s (NO_ELIGIBLE_REPLACEMENT) when candidates exist but none satisfy the owner-state matrix', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      // Owned lead in a SALES_EXEC-only state; the only other member is
      // a TELECALLER, which cannot own VISITED/NEGOTIATION/BOOKING_INITIATED.
      leads: [
        { id: 'lead-1', updatedAt: new Date(), ownerId: TARGET_ID, coOwnerId: null, state: 'VISITED', projectId: null },
      ],
      teamMembers: [
        { userId: 'tc-2', user: { name: 'Other Telecaller', role: 'TELECALLER' } },
      ],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(svc.preview(adminActor, TEAM_ID, TARGET_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_ELIGIBLE_REPLACEMENT' }),
    });
  });

  it('happy path: computes owned/co-owned breakdown, project summaries, and eligible replacements', async () => {
    const leads = [
      { id: 'lead-1', updatedAt: new Date('2026-01-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'NEW', projectId: 'proj-1', project: { name: 'Metro Heights' } },
      { id: 'lead-2', updatedAt: new Date('2026-01-02'), ownerId: 'other-owner', coOwnerId: TARGET_ID, state: 'CONTACTED', projectId: 'proj-1', project: { name: 'Metro Heights' } },
    ];
    makeTx({
      team: { id: TEAM_ID, managerId: 'mgr-1', deletedAt: null },
      leads,
      teamMembers: [
        { userId: 'tc-2', user: { name: 'Priya', role: 'TELECALLER' } },
      ],
      manager: { name: 'Meera', role: 'MANAGER' },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    const result = await svc.preview(adminActor, TEAM_ID, TARGET_ID);
    expect(result.ownedCount).toBe(1);
    expect(result.coOwnedCount).toBe(1);
    expect(result.totalAffectedLeads).toBe(2);
    expect(result.projects).toEqual([
      { projectId: 'proj-1', projectName: 'Metro Heights', ownedCount: 1, coOwnedCount: 1 },
    ]);
    expect(result.ownedStates).toEqual(['NEW']);
    // Both Priya (TELECALLER, can own NEW) and Meera (MANAGER, any state) qualify.
    const names = result.eligibleReplacements.map((c) => c.name).sort();
    expect(names).toEqual(['Meera', 'Priya']);
    expect(result.eligibleReplacements.find((c) => c.name === 'Meera')?.isTeamManager).toBe(true);
    expect(result.previewToken).toBe(
      computePreviewToken(leads.map((l) => ({ id: l.id, updatedAt: l.updatedAt, ownerId: l.ownerId, coOwnerId: l.coOwnerId }))),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reassignAndRemove()
// ────────────────────────────────────────────────────────────────────────────

const baseDto = {
  reason: 'departing the team',
  previewToken: '',
  requestId: '11111111-1111-1111-1111-111111111111',
};

describe('TeamMembersService.reassignAndRemove', () => {
  it('rejects SELF_REPLACEMENT before touching the database', async () => {
    const tx = makeTx();
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
        ...baseDto,
        replacementUserId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'SELF_REPLACEMENT' }) });
    expect(tx.auditLog.findUnique).not.toHaveBeenCalled();
  });

  it('rejects when the actor cannot mutate this team', async () => {
    makeTx();
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(false));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, { ...baseDto, replacementUserId: null }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('idempotent replay: returns the stored result without re-locking', async () => {
    const tx = makeTx({
      existingAudit: {
        batchId: 'batch_123',
        after: { removedUserId: TARGET_ID, teamId: TEAM_ID, replacementUserId: 'r-1', transferredLeadCount: 3 },
      },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    const result = await svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
      ...baseDto,
      replacementUserId: 'r-1',
    });
    expect(result).toEqual({
      batchId: 'batch_123',
      removedUserId: TARGET_ID,
      teamId: TEAM_ID,
      replacementUserId: 'r-1',
      transferredLeadCount: 3,
    });
    expect(tx.teamMember.delete).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('a requestId reused for a DIFFERENT removal 404s', async () => {
    makeTx({
      existingAudit: {
        batchId: 'batch_999',
        after: { removedUserId: 'someone-else', teamId: 'team-z', replacementUserId: null, transferredLeadCount: 0 },
      },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, { ...baseDto, replacementUserId: null }),
    ).rejects.toMatchObject({ name: 'NotFoundException' });
  });

  it('404s (TARGET_NOT_TEAM_MEMBER) when membership is already absent with no matching audit', async () => {
    makeTx({ membershipRowPresent: false, existingAudit: null });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, { ...baseDto, replacementUserId: null }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TARGET_NOT_TEAM_MEMBER' }),
    });
  });

  it('409s (CONCURRENT_MEMBERSHIP_CHANGE) when the member row disappears between the pre-check and the lock', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [
        [{ id: TEAM_ID }], // team lock
        [], // member lock returns nothing - removed concurrently
      ],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, { ...baseDto, replacementUserId: null }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CONCURRENT_MEMBERSHIP_CHANGE' }),
    });
  });

  it('409s (STALE_PREVIEW) when the locked leads no longer match the caller\'s previewToken', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [
        [{ id: TEAM_ID }],
        [{ userId: TARGET_ID }],
        [{ id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'NEW', projectId: null }],
      ],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
        ...baseDto,
        previewToken: 'stale-token-from-before',
        replacementUserId: 'r-1',
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'STALE_PREVIEW' }) });
  });

  it('400s (REPLACEMENT_REQUIRED) when leads are affected but no replacement was given', async () => {
    const lockedLeads = [
      { id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'NEW', projectId: null },
    ];
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], lockedLeads],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
        ...baseDto,
        previewToken: computePreviewToken(lockedLeads),
        replacementUserId: null,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REPLACEMENT_REQUIRED' }) });
  });

  it('400s (REPLACEMENT_NOT_ALLOWED) when zero leads are affected but a replacement was given', async () => {
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], []],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
        ...baseDto,
        previewToken: computePreviewToken([]),
        replacementUserId: 'r-1',
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REPLACEMENT_NOT_ALLOWED' }) });
  });

  it('400s (TARGET_NOT_TEAM_MEMBER) when the given replacement is not on this team', async () => {
    const lockedLeads = [
      { id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'NEW', projectId: null },
    ];
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], lockedLeads],
      candidateMembership: null,
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
        ...baseDto,
        previewToken: computePreviewToken(lockedLeads),
        replacementUserId: 'not-a-member',
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TARGET_NOT_TEAM_MEMBER' }) });
  });

  it('400s (TARGET_ROLE_INELIGIBLE) when the replacement cannot own every affected state', async () => {
    const lockedLeads = [
      { id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'VISITED', projectId: null },
    ];
    makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], lockedLeads],
      candidateMembership: { userId: 'tc-2', user: { name: 'Other Telecaller', role: 'TELECALLER' } },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await expect(
      svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
        ...baseDto,
        previewToken: computePreviewToken(lockedLeads),
        replacementUserId: 'tc-2',
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TARGET_ROLE_INELIGIBLE' }) });
  });

  it('happy path: zero leads removes the membership without any transfer', async () => {
    const tx = makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], []],
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    const result = await svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
      ...baseDto,
      previewToken: computePreviewToken([]),
      replacementUserId: null,
    });
    expect(result.transferredLeadCount).toBe(0);
    expect(result.replacementUserId).toBeNull();
    expect(tx.teamMember.delete).toHaveBeenCalledWith({
      where: { userId_teamId: { userId: TARGET_ID, teamId: TEAM_ID } },
    });
    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'team.member.remove',
          requestId: baseDto.requestId,
          batchId: expect.any(String),
        }),
      }),
    );
  });

  it('happy path: simple owner handoff transfers ownership + audits + removes membership', async () => {
    const lockedLeads = [
      { id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'NEW', projectId: 'proj-1' },
    ];
    const tx = makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], lockedLeads],
      candidateMembership: { userId: 'tc-2', user: { name: 'Priya', role: 'TELECALLER' } },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    const result = await svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
      ...baseDto,
      previewToken: computePreviewToken(lockedLeads),
      replacementUserId: 'tc-2',
    });
    expect(result.transferredLeadCount).toBe(1);
    expect(result.replacementUserId).toBe('tc-2');
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead-1'] } },
      data: { ownerId: 'tc-2' },
    });
    expect(tx.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: 'lead.ownership_transfer',
          entityId: 'lead-1',
          before: { ownerId: TARGET_ID, coOwnerId: null },
          after: { ownerId: 'tc-2', coOwnerId: null },
        }),
      ],
    });
    expect(tx.teamMember.delete).toHaveBeenCalled();
  });

  it('happy path: promotes an existing co-owner to owner and clears coOwnerId on collision', async () => {
    const lockedLeads = [
      { id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: 'tc-2', state: 'NEW', projectId: null },
    ];
    const tx = makeTx({
      team: { id: TEAM_ID, managerId: null, deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], lockedLeads],
      candidateMembership: { userId: 'tc-2', user: { name: 'Priya', role: 'TELECALLER' } },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    await svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
      ...baseDto,
      previewToken: computePreviewToken(lockedLeads),
      replacementUserId: 'tc-2',
    });
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead-1'] } },
      data: { ownerId: 'tc-2', coOwnerId: null },
    });
    expect(tx.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          after: { ownerId: 'tc-2', coOwnerId: null },
        }),
      ],
    });
  });

  it('happy path: the team\'s manager (no separate TeamMember row) is a valid replacement', async () => {
    const lockedLeads = [
      { id: 'lead-1', updatedAt: new Date('2026-02-01'), ownerId: TARGET_ID, coOwnerId: null, state: 'COLD', projectId: null },
    ];
    const tx = makeTx({
      team: { id: TEAM_ID, managerId: 'mgr-1', deletedAt: null },
      queryRawSequence: [[{ id: TEAM_ID }], [{ userId: TARGET_ID }], lockedLeads],
      candidateManager: { name: 'Meera', role: 'MANAGER' },
    });
    const svc = new TeamMembersService({ $client: {} } as never, stubAccess(true));
    const result = await svc.reassignAndRemove(adminActor, TEAM_ID, TARGET_ID, {
      ...baseDto,
      previewToken: computePreviewToken(lockedLeads),
      replacementUserId: 'mgr-1',
    });
    expect(result.replacementUserId).toBe('mgr-1');
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead-1'] } },
      data: { ownerId: 'mgr-1' },
    });
  });
});
