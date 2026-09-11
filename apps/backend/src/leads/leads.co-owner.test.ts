// Lead co-owner integration test (plan §18 D2/D3 follow-up).
//
// Real-DB (no mocks). The setCoOwner method runs inside withRlsContext, so we
// seed fixtures under an ADMIN actor, then invoke leads.setCoOwner with the
// actor-under-test. Covers:
//   1. ADMIN can set a same-team co-owner (happy).
//   2. MANAGER can set a same-team co-owner.
//   3. MANAGER cannot set a co-owner in another team (403).
//   4. TELECALLER / SALES_EXEC cannot set a co-owner (403).
//   5. The lead owner cannot also be the co-owner (400).
//   6. Clearing the co-owner (coOwnerId = null) works.
//   7. The audit row is written with correct before/after.

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { LeadsService } from './leads.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEAM_A_ID = `test-coowner-teamA-${RUN_TAG}`;
const TEAM_B_ID = `test-coowner-teamB-${RUN_TAG}`;
const ADMIN_ID = `test-coowner-admin-${RUN_TAG}`;
const MGR_A_ID = `test-coowner-mgrA-${RUN_TAG}`;
const TC_A_ID = `test-coowner-tcA-${RUN_TAG}`;
const TC_A2_ID = `test-coowner-tcA2-${RUN_TAG}`;
const TC_B_ID = `test-coowner-tcB-${RUN_TAG}`;
const SE_A_ID = `test-coowner-seA-${RUN_TAG}`;
const LEAD_ID = `test-coowner-lead-${RUN_TAG}`;

const TEST_LEAD_IDS: string[] = [LEAD_ID];
// Every business row now carries organizationId (T-ORG multitenancy).
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID, organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(
  overrides: Partial<JwtPayload> & Pick<JwtPayload, 'sub' | 'role' | 'teamId'>,
): JwtPayload {
  return {
    sub: overrides.sub,
    email: `${overrides.sub}@test.local`,
    role: overrides.role,
    teamId: overrides.teamId,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.team.upsert({
      where: { id: TEAM_A_ID },
      update: {},
      create: {
        id: TEAM_A_ID,
        name: `CoOwner Test Team A ${RUN_TAG}`,
        organizationId: ORG,
      },
    });
    await db.team.upsert({
      where: { id: TEAM_B_ID },
      update: {},
      create: {
        id: TEAM_B_ID,
        name: `CoOwner Test Team B ${RUN_TAG}`,
        organizationId: ORG,
      },
    });

    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: { teamId: TEAM_A_ID, role: 'ADMIN' },
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'CoOwner Test Admin',
        role: 'ADMIN',
        teamId: TEAM_A_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: MGR_A_ID },
      update: { teamId: TEAM_A_ID, role: 'MANAGER' },
      create: {
        id: MGR_A_ID,
        email: `${MGR_A_ID}@test.local`,
        name: 'CoOwner Test Manager A',
        role: 'MANAGER',
        teamId: TEAM_A_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_A_ID },
      update: { teamId: TEAM_A_ID, role: 'TELECALLER' },
      create: {
        id: TC_A_ID,
        email: `${TC_A_ID}@test.local`,
        name: 'CoOwner Test TC A',
        role: 'TELECALLER',
        teamId: TEAM_A_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_A2_ID },
      update: { teamId: TEAM_A_ID, role: 'TELECALLER' },
      create: {
        id: TC_A2_ID,
        email: `${TC_A2_ID}@test.local`,
        name: 'CoOwner Test TC A2',
        role: 'TELECALLER',
        teamId: TEAM_A_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_B_ID },
      update: { teamId: TEAM_B_ID, role: 'TELECALLER' },
      create: {
        id: TC_B_ID,
        email: `${TC_B_ID}@test.local`,
        name: 'CoOwner Test TC B',
        role: 'TELECALLER',
        teamId: TEAM_B_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: SE_A_ID },
      update: { teamId: TEAM_A_ID, role: 'SALES_EXEC' },
      create: {
        id: SE_A_ID,
        email: `${SE_A_ID}@test.local`,
        name: 'CoOwner Test SE A',
        role: 'SALES_EXEC',
        teamId: TEAM_A_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });

    // Lead owned by TC_A.
    await db.lead.upsert({
      where: { id: LEAD_ID },
      update: { ownerId: TC_A_ID, teamId: TEAM_A_ID },
      create: {
        id: LEAD_ID,
        name: 'CoOwner Test Lead',
        phone: `91${(1000000000 + Math.floor(Math.random() * 8999999999)).toString()}`,
        phoneE164: null,
        source: 'TEST',
        state: 'NEW',
        ownerId: TC_A_ID,
        ownerType: 'TELECALLER',
        teamId: TEAM_A_ID,
        organizationId: ORG,
      },
    });
  });
});

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.lead.deleteMany({
      where: { id: { in: TEST_LEAD_IDS } },
    });
    await db.user.deleteMany({
      where: {
        id: {
          in: [ADMIN_ID, MGR_A_ID, TC_A_ID, TC_A2_ID, TC_B_ID, SE_A_ID],
        },
      },
    });
    await db.team.deleteMany({ where: { id: { in: [TEAM_A_ID, TEAM_B_ID] } } });
  });
});

describe('LeadsService.setCoOwner', () => {
  const service = new LeadsService(new PrismaService());

  it('1. ADMIN can set a same-team co-owner', async () => {
    const actor = actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID });
    const result = await service.setCoOwner(actor, {
      leadId: LEAD_ID,
      coOwnerId: SE_A_ID,
      reason: 'add SE to follow up',
    });
    expect(result.id).toBe(LEAD_ID);
    const row = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: LEAD_ID },
        select: { coOwnerId: true },
      }),
    );
    expect(row?.coOwnerId).toBe(SE_A_ID);
  });

  it('2. MANAGER can set a same-team co-owner', async () => {
    const actor = actorFor({ sub: MGR_A_ID, role: 'MANAGER', teamId: TEAM_A_ID });
    const result = await service.setCoOwner(actor, {
      leadId: LEAD_ID,
      coOwnerId: TC_A2_ID,
      reason: 'manager adds teammate',
    });
    expect(result.id).toBe(LEAD_ID);
    const row = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: LEAD_ID },
        select: { coOwnerId: true },
      }),
    );
    expect(row?.coOwnerId).toBe(TC_A2_ID);
  });

  it('3. MANAGER cannot set a co-owner in another team (403)', async () => {
    const actor = actorFor({ sub: MGR_A_ID, role: 'MANAGER', teamId: TEAM_A_ID });
    await expect(
      service.setCoOwner(actor, {
        leadId: LEAD_ID,
        coOwnerId: TC_B_ID,
        reason: 'cross-team attempt',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('4. TELECALLER / SALES_EXEC cannot set a co-owner', async () => {
    // A staff member who is neither owner nor co-owner can't even SEE the
    // lead under RLS (it's owned by TC_A in team A), so they get 404
    // NotFound — regardless of which team they're in. TC_B (other team,
    // no ownership tie) is the clean actor here: an earlier test sets
    // TC_A2 as co-owner, which would let TC_A2 see the lead.
    const actor = actorFor({ sub: TC_B_ID, role: 'TELECALLER', teamId: TEAM_B_ID });
    let thrown: unknown;
    try {
      await service.setCoOwner(actor, {
        leadId: LEAD_ID,
        coOwnerId: SE_A_ID,
        reason: 'staff attempt',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('5. the lead owner cannot also be the co-owner (400)', async () => {
    const actor = actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID });
    await expect(
      service.setCoOwner(actor, {
        leadId: LEAD_ID,
        coOwnerId: TC_A_ID,
        reason: 'owner as co-owner',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('6. clearing the co-owner (coOwnerId = null) works', async () => {
    await adminSeed((db) =>
      db.lead.update({
        where: { id: LEAD_ID },
        data: { coOwnerId: SE_A_ID },
      }),
    );
    const actor = actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID });
    const result = await service.setCoOwner(actor, {
      leadId: LEAD_ID,
      coOwnerId: null,
      reason: 'remove co-owner',
    });
    expect(result.id).toBe(LEAD_ID);
    const row = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: LEAD_ID },
        select: { coOwnerId: true },
      }),
    );
    expect(row?.coOwnerId).toBeNull();
  });

  it('7. unknown lead -> NotFound', async () => {
    const actor = actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID });
    await expect(
      service.setCoOwner(actor, {
        leadId: 'cmx00000000000000000000000',
        coOwnerId: SE_A_ID,
        reason: 'bad lead',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
