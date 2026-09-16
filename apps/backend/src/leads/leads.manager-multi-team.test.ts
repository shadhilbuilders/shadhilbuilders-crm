// Manager multi-team integration test - T-TEAM-AUTHORITATIVE (2026-09-13,
// Decision Audit Trail #39). Real-DB (no mocks): proves the whole cutover
// end-to-end, not just the service-layer fallback.
//
// Fixture (design doc fixture #1 - "Manager Meera leads Metro Sales and
// Launch Support"): ONE manager (MGR_ID) leads TWO teams (Team.managerId
// set on BOTH). The manager's own User.teamId points to ONLY the first
// team - so any assertion that passes for the SECOND team can only be
// satisfied by the NEW Team.managerId-based path (RLS EXISTS check +
// TeamAccessService), never by the legacy actor.teamId-equality fallback.
//
// Covers:
//   1. list(): sees leads from BOTH managed teams.
//   2. reassign(): can reassign a lead that belongs to the SECOND team
//      (the one NOT reflected in the manager's own User.teamId).
//   3. setCoOwner(): same, for the co-owner path.
//   4. RLS alone (bare tx.lead.findMany under the manager's RLS context,
//      bypassing the service's own belt-and-braces WHERE) sees leads from
//      BOTH teams - proves the DB policy itself, not just the service.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const TEAM_1_ID = `test-mmt-team1-${RUN_TAG}`;
const TEAM_2_ID = `test-mmt-team2-${RUN_TAG}`;
const ADMIN_ID = `test-mmt-admin-${RUN_TAG}`;
const MGR_ID = `test-mmt-mgr-${RUN_TAG}`;
const TC_1_ID = `test-mmt-tc1-${RUN_TAG}`;
const TC_2_ID = `test-mmt-tc2-${RUN_TAG}`;
const LEAD_1_ID = `test-mmt-lead1-${RUN_TAG}`;
const LEAD_2_ID = `test-mmt-lead2-${RUN_TAG}`;

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(overrides: Partial<JwtPayload> & Pick<JwtPayload, 'sub' | 'role'>): JwtPayload {
  return {
    email: `${overrides.sub}@test.local`,
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.team.upsert({
      where: { id: TEAM_1_ID },
      update: { managerId: MGR_ID },
      create: { id: TEAM_1_ID, name: `MMT Team 1 ${RUN_TAG}`, organizationId: ORG, managerId: null },
    });
    await db.team.upsert({
      where: { id: TEAM_2_ID },
      update: { managerId: MGR_ID },
      create: { id: TEAM_2_ID, name: `MMT Team 2 ${RUN_TAG}`, organizationId: ORG, managerId: null },
    });
    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: {},
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'MMT Admin',
        role: 'ADMIN',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    // Manager's OWN User.teamId points to team-1 ONLY - team-2 access can
    // only come from Team.managerId (set below), never the JWT/User.teamId.
    await db.user.upsert({
      where: { id: MGR_ID },
      update: { role: 'MANAGER' },
      create: {
        id: MGR_ID,
        email: `${MGR_ID}@test.local`,
        name: 'MMT Manager',
        role: 'MANAGER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    // Set Team.managerId AFTER the manager user exists (FK).
    await db.team.update({ where: { id: TEAM_1_ID }, data: { managerId: MGR_ID } });
    await db.team.update({ where: { id: TEAM_2_ID }, data: { managerId: MGR_ID } });

    await db.user.upsert({
      where: { id: TC_1_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: TC_1_ID,
        email: `${TC_1_ID}@test.local`,
        name: 'MMT TC Team1',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_2_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: TC_2_ID,
        email: `${TC_2_ID}@test.local`,
        name: 'MMT TC Team2',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });

    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): reassign()/
    // setCoOwner() resolve a target's team via TeamMember rows now (the
    // legacy User.teamId column set above is no longer read for this).
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: TC_1_ID, teamId: TEAM_1_ID } },
      update: {},
      create: { userId: TC_1_ID, teamId: TEAM_1_ID, organizationId: ORG },
    });
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: TC_2_ID, teamId: TEAM_2_ID } },
      update: {},
      create: { userId: TC_2_ID, teamId: TEAM_2_ID, organizationId: ORG },
    });

    await db.lead.upsert({
      where: { id: LEAD_1_ID },
      update: { ownerId: TC_1_ID, teamId: TEAM_1_ID },
      create: {
        id: LEAD_1_ID,
        name: 'MMT Lead Team1',
        phone: `91${(1000000000 + Math.floor(Math.random() * 8999999999)).toString()}`,
        source: 'TEST',
        state: 'NEW',
        ownerId: TC_1_ID,
        ownerType: 'TELECALLER',
        teamId: TEAM_1_ID,
        organizationId: ORG,
      },
    });
    // This lead belongs to TEAM_2 - the team the manager leads but does
    // NOT carry on their own User.teamId.
    await db.lead.upsert({
      where: { id: LEAD_2_ID },
      update: { ownerId: TC_2_ID, teamId: TEAM_2_ID },
      create: {
        id: LEAD_2_ID,
        name: 'MMT Lead Team2',
        phone: `91${(1000000000 + Math.floor(Math.random() * 8999999999)).toString()}`,
        source: 'TEST',
        state: 'NEW',
        ownerId: TC_2_ID,
        ownerType: 'TELECALLER',
        teamId: TEAM_2_ID,
        organizationId: ORG,
      },
    });
  });
});

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.lead.deleteMany({ where: { id: { in: [LEAD_1_ID, LEAD_2_ID] } } });
    await db.user.deleteMany({ where: { id: { in: [TC_1_ID, TC_2_ID, MGR_ID, ADMIN_ID] } } });
    await db.team.deleteMany({ where: { id: { in: [TEAM_1_ID, TEAM_2_ID] } } });
  });
});

describe.skipIf(!HAS_DB)('Manager leading multiple teams (design doc fixture #1)', () => {
  const service = new LeadsService(new PrismaService());
  const managerActor = actorFor({ sub: MGR_ID, role: 'MANAGER'});

  it('list(): the manager sees leads from BOTH teams they manage, not just their own User.teamId', async () => {
    const result = await service.list(managerActor, { limit: 50, offset: 0 });
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(LEAD_1_ID);
    expect(ids).toContain(LEAD_2_ID);
  });

  it('RLS alone (bare findMany under the manager RLS context) returns leads from BOTH teams', async () => {
    if (prisma === null) throw new Error('prisma missing');
    const rows = await withRlsContext(
      prisma,
      { userId: MGR_ID, role: 'MANAGER', organizationId: ORG },
      (tx) => tx.lead.findMany({ where: { id: { in: [LEAD_1_ID, LEAD_2_ID] } }, select: { id: true } }),
    );
    const ids = rows.map((r) => r.id);
    expect(ids.sort()).toEqual([LEAD_1_ID, LEAD_2_ID].sort());
  });

  it('reassign(): the manager can reassign a lead on the SECOND team (not their own User.teamId)', async () => {
    const result = await service.reassign(managerActor, {
      leadId: LEAD_2_ID,
      targetUserId: TC_2_ID,
      reason: 'manager reassigns within their second managed team',
    });
    expect(result.id).toBe(LEAD_2_ID);
    expect(result.ownerId).toBe(TC_2_ID);
  });

  it('setCoOwner(): the manager can set a co-owner on the SECOND team lead', async () => {
    // LEAD_2's owner is TC_2 (post-reassign test above); a same-team
    // co-owner candidate would need a second TC on team 2, which this
    // fixture doesn't seed - clearing (coOwnerId: null) is enough to
    // prove the manager's write access to team 2 without needing one.
    const result = await service.setCoOwner(managerActor, {
      leadId: LEAD_2_ID,
      coOwnerId: null,
      reason: 'manager clears co-owner on their second managed team',
    });
    expect(result.id).toBe(LEAD_2_ID);
  });
});
