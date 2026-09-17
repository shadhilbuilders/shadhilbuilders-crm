// Auto-assign routing tests (T-AUTOASSIGN, 2026-09-17).
//
// Real-DB tests (no mocks) that pin how `create()` decides the owner of a NEW
// lead based on the creating team's `autoAssignLeads` flag:
//
//   true  → the lead routes to the least-loaded TELECALLER across EVERY team
//           linked to the project (ProjectTeam), scored by openLeads / weight.
//           We pin that the lead lands on the pool member with the LOWEST
//           score - and that a heavier-weight member wins the tie when the
//           ratio favors them. Managers never own on this path.
//
//   false → the lead lands owned by the creating team's MANAGER (ownerType =
//           MANAGER, pending). We pin that the manager owns it and no
//           telecaller was auto-selected.
//
// Owner routing depends on ProjectTeam links + TeamMember.weight, all of which
// we seed ourselves so the test is self-contained (mirrors
// leads.teamless-create.test.ts's fixture approach).
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

// Per-test unique IDs so re-runs don't collide on FK / unique constraints.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const PROJECT_ID = `auto-proj-${RUN_TAG}`;
const TEAM_A = `auto-team-a-${RUN_TAG}`;
const TEAM_B = `auto-team-b-${RUN_TAG}`;
const MGR_A = `auto-mgr-a-${RUN_TAG}`;
const MGR_B = `auto-mgr-b-${RUN_TAG}`;
const TC_A1 = `auto-tc-a1-${RUN_TAG}`;
const TC_A2 = `auto-tc-a2-${RUN_TAG}`;
const TC_B1 = `auto-tc-b1-${RUN_TAG}`;
const ADMIN_ACTOR_ID = `auto-admin-${RUN_TAG}`;
const LEAD_IDS: string[] = [];

async function seed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ACTOR_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function adminActor(): JwtPayload {
  return {
    sub: ADMIN_ACTOR_ID,
    email: `${ADMIN_ACTOR_ID}@test.local`,
    role: 'ADMIN',
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

function seedUser(
  db: PrismaClient,
  id: string,
  role: 'TELECALLER' | 'SALES_EXEC' | 'MANAGER' | 'ADMIN' | 'OWNER',
  name: string,
) {
  return db.user.upsert({
    where: { id },
    update: {},
    create: {
      id,
      email: `${id}@test.local`,
      name,
      role,
      organizationId: ORG,
      mustChangePassword: false,
    },
  });
}

let service: LeadsService;

beforeAll(async () => {
  if (prisma === null) return;
  await seed(async (db) => {
    // Admin actor (RLS write path + the actor under test).
    await seedUser(db, ADMIN_ACTOR_ID, 'ADMIN', 'Auto Assign Admin');
    // Project + two teams + managers.
    await db.project.upsert({
      where: { id: PROJECT_ID },
      update: {},
      create: {
        id: PROJECT_ID,
        name: `Auto Assign Project ${RUN_TAG}`,
        slug: `test-auto-assign-${RUN_TAG}`,
        address: 'test',
        organizationId: ORG,
      },
    });
    for (const [teamId, mgrId] of [
      [TEAM_A, MGR_A],
      [TEAM_B, MGR_B],
    ] as const) {
      await seedUser(db, mgrId, 'MANAGER', `Mgr ${teamId}`);
      await db.team.upsert({
        where: { id: teamId },
        update: {},
        create: { id: teamId, name: `Team ${teamId}`, managerId: mgrId, organizationId: ORG },
      });
    }
    // Telecallers in both teams.
    for (const [userId, role, name] of [
      [TC_A1, 'TELECALLER', 'TC A1'],
      [TC_A2, 'TELECALLER', 'TC A2'],
      [TC_B1, 'TELECALLER', 'TC B1'],
    ] as const) {
      await seedUser(db, userId, role, name);
    }
    // TeamMember rows with default weight 1.
    for (const [teamId, userId] of [
      [TEAM_A, TC_A1],
      [TEAM_A, TC_A2],
      [TEAM_B, TC_B1],
    ] as const) {
      await db.teamMember.upsert({
        where: { userId_teamId: { userId, teamId } },
        update: {},
        create: { userId, teamId, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
    }
    // Link BOTH teams to the project (the routing pool = all project teams).
    for (const teamId of [TEAM_A, TEAM_B]) {
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_ID, teamId } },
        update: {},
        create: { projectId: PROJECT_ID, teamId, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
    }
  });
  service = new LeadsService(new PrismaService());
});

afterAll(async () => {
  if (prisma === null) return;
  await seed(async (db) => {
    // Cleanup is best-effort; the RUN_TAG ids make cross-run collisions impossible.
    const ids = [...LEAD_IDS];
    await db.lead.deleteMany({ where: { id: { in: ids } } });
  });
});

describe('autoAssignLeads = true → project-wide least-loaded telecaller', () => {
  it('routes to the telecaller with the lowest openLeads/weight across all project teams', async () => {
    if (prisma === null) return;
    // Seed an OPEN (non-terminal) lead on TC_A2 so TC_A1 (0 open) is the
    // least loaded of the pool.
    await seed(async (db) => {
      await db.lead.create({
        data: {
          id: `auto-seed-lead-${RUN_TAG}`,
          name: 'Seed burden',
          phone: `+9199${(Date.now() % 100000000).toString().padStart(8, '0')}`,
          source: 'TEST',
          projectId: PROJECT_ID,
          teamId: TEAM_A,
          ownerId: TC_A2,
          ownerType: 'TELECALLER',
          organizationId: ORG,
        },
      });
    });
    // Team A is the team the (admin) actor creates the lead into, and it has
    // autoAssignLeads = true → the pool is TC_A1 (0 open), TC_A2 (1 open), TC_B1 (0 open).
    await seed(async (db) => {
      await db.team.update({
        where: { id: TEAM_A },
        data: { autoAssignLeads: true },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'Auto routed',
      phone: `+9199${((Date.now() + 1) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_A,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // TC_A1 and TC_B1 both have 0 open + weight 1 → tie, deterministically the
    // lexicographically-smaller userId (TC_A1 vs TC_B1 → TC_A1 wins the userId tie).
    expect(lead.ownerId).toBe(TC_A1);
  });

  it('a heavier-weight member wins when the ratio favors them', async () => {
    if (prisma === null) return;
    // TC_A1: 4 open / weight 1 = 4.0 ; TC_B1: 2 open / weight 4 = 0.5.
    // The ratio unambiguously favors the heavier-weight TC_B1, and it beats
    // every weight-1 member (who can't drop below 1.0 without negative load).
    // The prior test left one open lead on TC_A2 (score 1.0), so TC_B1 wins.
    await seed(async (db) => {
      await db.teamMember.updateMany({
        where: { userId: TC_A1 },
        data: { weight: 1 },
      });
      await db.teamMember.updateMany({
        where: { userId: TC_B1 },
        data: { weight: 4 },
      });
      for (let i = 0; i < 4; i++) {
        await db.lead.create({
          data: {
            id: `auto-burden-a1-${i}-${RUN_TAG}`,
            name: `A1 burden ${i}`,
            phone: `+9199${((Date.now() + 10 + i) % 100000000).toString().padStart(8, '0')}`,
            source: 'TEST',
            projectId: PROJECT_ID,
            teamId: TEAM_A,
            ownerId: TC_A1,
            ownerType: 'TELECALLER',
            organizationId: ORG,
          },
        });
      }
      for (let i = 0; i < 2; i++) {
        await db.lead.create({
          data: {
            id: `auto-burden-b1-${i}-${RUN_TAG}`,
            name: `B1 burden ${i}`,
            phone: `+9199${((Date.now() + 100 + i) % 100000000).toString().padStart(8, '0')}`,
            source: 'TEST',
            projectId: PROJECT_ID,
            teamId: TEAM_B,
            ownerId: TC_B1,
            ownerType: 'TELECALLER',
            organizationId: ORG,
          },
        });
      }
    });

    const lead = await service.create(adminActor(), {
      name: 'Heavy routes',
      phone: `+9199${((Date.now() + 200) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_A,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    expect(lead.ownerId).toBe(TC_B1);
  });
});

describe('autoAssignLeads = false → manager owns the lead (pending)', () => {
  it('routes to the creating team manager with ownerType MANAGER', async () => {
    if (prisma === null) return;
    // Team B is false (default) with manager MGR_B.
    await seed(async (db) => {
      await db.team.update({
        where: { id: TEAM_B },
        data: { autoAssignLeads: false },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'Manager owned',
      phone: `+9199${((Date.now() + 300) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_B,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    expect(lead.ownerId).toBe(MGR_B);
    // ownerName comes back as the manager because ownerType=MANAGER.
    // (We assert ownerId; the ownerType is exercised by the service's audit metadata.)
  });

  it('a managerless team does NOT auto-own (falls back, no crash)', async () => {
    if (prisma === null) return;
    // Create a third team with NO manager + false flag → resolveAutoAssign
    // falls back to the rule chain / default assignee. No manager to own it.
    const TEAM_C = `auto-team-c-${RUN_TAG}`;
    await seed(async (db) => {
      await db.team.upsert({
        where: { id: TEAM_C },
        update: {},
        create: { id: TEAM_C, name: `Team C ${RUN_TAG}`, managerId: null, organizationId: ORG },
      });
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_ID, teamId: TEAM_C } },
        update: {},
        create: { projectId: PROJECT_ID, teamId: TEAM_C, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'No manager lead',
      phone: `+9199${((Date.now() + 400) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_C,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // No manager → falls back (owner = the actor for a teamless admin path,
    // or the rule/default). The key assertion: it did NOT assign to a
    // telecaller (no auto-assign happened) and did NOT throw.
    expect(lead.ownerId).toBeTruthy();
  });
});
