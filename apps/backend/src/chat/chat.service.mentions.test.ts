// @mention resolution is multi-team aware for MANAGER - T-TEAM-
// AUTHORITATIVE (2026-09-13, design doc UI1/Decision Audit Trail #39
// follow-up).
//
// Real-DB (no mocks): proves ChatService.emitMentions() resolves @mentions
// across EVERY team a MANAGER manages (TeamAccessService.getManagedTeamIds
// - RLS-safe because the TeamMember policy's Team.managerId EXISTS clause
// already grants a manager visibility into membership rows on teams they
// lead), not the single stale `actor.teamId` JWT claim.
//
// Scope note (see chat.service.ts's emitMentions doc comment): this fix is
// deliberately bounded to MANAGER. The TeamMember SELECT RLS policy is
// intentionally non-recursive (policies.sql) - an ordinary staff member
// can only read their OWN membership row, never a teammate's - so ordinary
// TELECALLER/SALES_EXEC mention resolution stays on the legacy single
// `actor.teamId` scalar (unchanged, not a regression).
//
// Fixture (design doc fixture #1 - "Manager Meera leads Metro Sales and
// Launch Support"): ONE manager leads TWO teams (Team.managerId set on
// BOTH); the manager's own User.teamId points to ONLY the first team, so
// resolving a mention on the SECOND team's teammate can only be satisfied
// by the new Team.managerId-based path, never the legacy fallback.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { ChatService } from './chat.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEAM_1_ID = `test-mtm-team1-${RUN_TAG}`;
const TEAM_2_ID = `test-mtm-team2-${RUN_TAG}`;
const TEAM_3_ID = `test-mtm-team3-${RUN_TAG}`; // NOT managed by MGR
const ADMIN_ID = `test-mtm-admin-${RUN_TAG}`;
const MGR_ID = `test-mtm-mgr-${RUN_TAG}`;
const TC_1_ID = `test-mtm-tc1-${RUN_TAG}`;
const TC_2_ID = `test-mtm-tc2-${RUN_TAG}`;
const OUTSIDER_ID = `test-mtm-outsider-${RUN_TAG}`;
const LEAD_ID = `test-mtm-lead-${RUN_TAG}`;

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', teamId: null, organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    for (const id of [TEAM_1_ID, TEAM_2_ID, TEAM_3_ID]) {
      await db.team.upsert({
        where: { id },
        update: { managerId: null },
        create: { id, name: `MTM ${id}`, organizationId: ORG },
      });
    }

    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: {},
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'MTM Admin',
        role: 'ADMIN',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });

    // Manager's OWN User.teamId points to TEAM_1 ONLY - TEAM_2 mention
    // resolution can only come from Team.managerId (set below).
    await db.user.upsert({
      where: { id: MGR_ID },
      update: { teamId: TEAM_1_ID, role: 'MANAGER' },
      create: {
        id: MGR_ID,
        email: `${MGR_ID}@test.local`,
        name: 'MTM Manager',
        role: 'MANAGER',
        teamId: TEAM_1_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.team.update({ where: { id: TEAM_1_ID }, data: { managerId: MGR_ID } });
    await db.team.update({ where: { id: TEAM_2_ID }, data: { managerId: MGR_ID } });
    // TEAM_3 is NOT managed by MGR - its member must never be notified.

    await db.user.upsert({
      where: { id: TC_1_ID },
      update: { teamId: TEAM_1_ID, role: 'TELECALLER' },
      create: {
        id: TC_1_ID,
        email: `${TC_1_ID}@test.local`,
        name: 'Kiran Rao',
        role: 'TELECALLER',
        teamId: TEAM_1_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_2_ID },
      update: { teamId: TEAM_2_ID, role: 'TELECALLER' },
      create: {
        id: TC_2_ID,
        email: `${TC_2_ID}@test.local`,
        name: 'Meera Iyer',
        role: 'TELECALLER',
        teamId: TEAM_2_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: OUTSIDER_ID },
      update: { teamId: TEAM_3_ID, role: 'TELECALLER' },
      create: {
        id: OUTSIDER_ID,
        email: `${OUTSIDER_ID}@test.local`,
        name: 'Zara Khan',
        role: 'TELECALLER',
        teamId: TEAM_3_ID,
        organizationId: ORG,
        mustChangePassword: false,
      },
    });

    // MGR owns the lead so the Message insert's lead-visibility check
    // (MANAGER: team/ownership-based) passes.
    await db.lead.upsert({
      where: { id: LEAD_ID },
      update: { ownerId: MGR_ID, teamId: TEAM_1_ID },
      create: {
        id: LEAD_ID,
        name: 'MTM Lead',
        phone: `91${(1000000000 + Math.floor(Math.random() * 8999999999)).toString()}`,
        source: 'TEST',
        state: 'NEW',
        ownerId: MGR_ID,
        ownerType: 'MANAGER',
        teamId: TEAM_1_ID,
        organizationId: ORG,
      },
    });
  });
});

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.message.deleteMany({ where: { leadId: LEAD_ID } });
    await db.auditLog.deleteMany({
      where: { userId: { in: [MGR_ID, TC_1_ID, TC_2_ID, OUTSIDER_ID] } },
    });
    await db.lead.deleteMany({ where: { id: LEAD_ID } });
    await db.user.deleteMany({
      where: { id: { in: [MGR_ID, TC_1_ID, TC_2_ID, OUTSIDER_ID, ADMIN_ID] } },
    });
    await db.team.deleteMany({ where: { id: { in: [TEAM_1_ID, TEAM_2_ID, TEAM_3_ID] } } });
  });
});

describe.skipIf(!HAS_DB)('ChatService @mention resolution across a manager\'s multiple teams (design doc follow-up)', () => {
  const outboundStub = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const notified: string[] = [];
  const notificationsStub = {
    emit: vi.fn(async (userId: string) => {
      notified.push(userId);
    }),
  };

  const managerActor: JwtPayload = {
    sub: MGR_ID,
    email: `${MGR_ID}@test.local`,
    role: 'MANAGER',
    teamId: TEAM_1_ID, // deliberately reflects ONLY team 1
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };

  it('notifies a mentioned teammate on the SECOND managed team, not just the JWT\'s single teamId', async () => {
    notified.length = 0;
    if (prisma === null) throw new Error('prisma missing');
    const service = new ChatService(
      { $client: prisma } as never,
      outboundStub as never,
      notificationsStub as never,
    );

    await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Please loop in @Kiran Rao and @Meera Iyer and @Zara Khan on this.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
    });

    // Kiran Rao (team 1, reflected in the JWT) and Meera Iyer (team 2,
    // ONLY reachable via Team.managerId) both get notified.
    expect(notified).toContain(TC_1_ID);
    expect(notified).toContain(TC_2_ID);
    // Zara Khan is on team 3, which this manager does not manage.
    expect(notified).not.toContain(OUTSIDER_ID);
  });

  it('never notifies the actor about their own mention', async () => {
    notified.length = 0;
    if (prisma === null) throw new Error('prisma missing');
    const service = new ChatService(
      { $client: prisma } as never,
      outboundStub as never,
      notificationsStub as never,
    );

    await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Note to self: @MTM Manager should follow up tomorrow.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
    });

    expect(notified).not.toContain(MGR_ID);
  });
});
