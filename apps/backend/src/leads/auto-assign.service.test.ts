// Auto-assign routing tests (T-AUTOASSIGN, 2026-09-17).
//
// Real-DB tests (no mocks) that pin how `create()` decides the owner of a NEW
// lead based on the creating team's `autoAssignLeads` flag:
//
//   true  → the lead routes to the least-loaded TELECALLER across EVERY team
//           linked to the project (ProjectTeam), scored by openLeads / weight.
//           TELECALLERS ONLY (fixed 2026-09-28): sales execs are never
//           candidates on this path, so the pool member with the LOWEST score
//           wins WITHIN the telecaller pool and an idle sales exec cannot take
//           first touch. When NO telecaller is eligible the lead goes to the
//           creating team's MANAGER as a pending handoff. Managers own nothing
//           else on this path.
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
// TEST-ONLY helper: connects as the bypass-RLS owner role, so it is deliberately
// absent from the package's production barrel. Import it from the test-only
// subpath, never from '@shadhil/database' (scripts/check-bare-prisma.mjs fails
// CI if app code names it at all).
import { createDirectPrismaClient } from '@shadhil/database/test-db-isolation';

import { PrismaService } from '../prisma/prisma.module';
import { LeadsService } from './leads.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;
// ManagerAssignmentRule has NO INSERT policy by design (rule management is an
// admin-class concern - see prisma/rls/policies.sql), so seeding a rule through
// the pooled app role fails with 42501. Its fixtures go through the owner role,
// like the seed/bootstrap path does. Everything else here uses the pooled
// client so the RLS behavior under test stays real.
const directPrisma: PrismaClient = createDirectPrismaClient();

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
const SE_B1 = `auto-se-b1-${RUN_TAG}`;
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
    // Staff in both teams: telecallers, plus a sales exec in team B.
    // SE_B1 is the auto-assign tier regression fixture - an IDLE sales exec sits
    // in the pool for every `autoAssignLeads = true` test below, so any test
    // that would let an exec out-score a working telecaller fails loudly.
    for (const [userId, role, name] of [
      [TC_A1, 'TELECALLER', 'TC A1'],
      [TC_A2, 'TELECALLER', 'TC A2'],
      [TC_B1, 'TELECALLER', 'TC B1'],
      [SE_B1, 'SALES_EXEC', 'SE B1'],
    ] as const) {
      await seedUser(db, userId, role, name);
    }
    // TeamMember rows with default weight 1.
    for (const [teamId, userId] of [
      [TEAM_A, TC_A1],
      [TEAM_A, TC_A2],
      [TEAM_B, TC_B1],
      [TEAM_B, SE_B1],
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
  // Rules are cleaned through the owner-role client for the same reason they
  // were created with it: the table is SELECT-only on the pooled app role, so a
  // pooled DELETE would silently remove nothing and strand the fixture.
  await directPrisma.managerAssignmentRule.deleteMany({
    where: { id: { contains: RUN_TAG } },
  });
});

// T-TEAM-ROUND-ROBIN (2026-10-08): with the flag on, the lead is routed by a
// strict team rotation; WITHIN the chosen team the least-loaded telecaller wins.
// TEAM_A and TEAM_B are both ON in this block, and the tests below are
// deliberately ORDER-DEPENDENT on the rotation cursor (fresh project => both
// teams never routed => 'auto-team-a' < 'auto-team-b' by id): the 1st create
// lands on A, the 2nd on B, the 3rd on A again.
describe('autoAssignLeads = true → team round-robin, least-loaded telecaller within the team', () => {
  it('routes to the least-loaded telecaller of the team whose turn it is (A first)', async () => {
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
    // Both teams ON. Turn 1 of the rotation is TEAM_A (never routed, lowest id),
    // so the pick is the least-loaded telecaller OF TEAM_A: TC_A1 (0 open) beats
    // TC_A2 (1 open). TC_B1 (0 open) is NOT in the pool - it is another team's.
    await seed(async (db) => {
      await db.team.updateMany({
        where: { id: { in: [TEAM_A, TEAM_B] } },
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

    expect(lead.ownerId).toBe(TC_A1);
  });

  it('the next lead goes to the OTHER team (rotation), and its weighted telecaller wins', async () => {
    if (prisma === null) return;
    // Turn 2 of the rotation is TEAM_B (TEAM_A was just used). TEAM_B's only
    // telecaller is TC_B1 (the sales exec SE_B1 is never a candidate), weight 4
    // with 2 open leads (0.5). TC_A1 is loaded to 4 so a pool that wrongly
    // spanned teams would still not pick it - the assertion that matters is
    // that the lead crossed to TEAM_B at all.
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
    // ...and NOT the idle sales exec, who scores 0.0 in a shared pool.
    expect(lead.ownerId).not.toBe(SE_B1);
  });

  it('an idle sales exec never wins while a telecaller is eligible (regression)', async () => {
    if (prisma === null) return;
    // The reported bug, pinned end-to-end: with ONE shared pool scored by
    // openLeads/weight, a sales exec with 0 open leads scored 0.0 and beat every
    // telecaller, so a NEW first-touch lead landed on the exec. Sales execs are
    // now out of the pool entirely - even this weight-10, zero-load exec, which
    // is as favourable as an exec can ever look, must lose to a loaded
    // telecaller.
    //
    // Turn 3 of the rotation is TEAM_A again. Weights are set explicitly so this
    // test does not depend on the weight/load mutations the earlier tests leave
    // behind: all telecallers weight 1, exec weight 10 at 0 open. Loads carried
    // into this test: TC_A1 4 (the previous test's burden), TC_A2 1 (this file's
    // first seed) → TC_A2 has the lowest score in TEAM_A's telecaller pool.
    await seed(async (db) => {
      await db.teamMember.updateMany({
        where: { userId: { in: [TC_A1, TC_A2, TC_B1] } },
        data: { weight: 1 },
      });
      await db.teamMember.updateMany({
        where: { userId: SE_B1 },
        data: { weight: 10 },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'Tier regression',
      phone: `+9199${((Date.now() + 500) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_A,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    expect(lead.ownerId).not.toBe(SE_B1);
    expect(lead.ownerId).toBe(TC_A2);

    // ownerType stays TELECALLER (the only role this path can now pick).
    const row = await seed((db) =>
      db.lead.findUnique({
        where: { id: lead.id },
        select: { ownerId: true, ownerType: true },
      }),
    );
    expect(row?.ownerId).toBe(TC_A2);
    expect(row?.ownerType).toBe('TELECALLER');
  });

  it('hands the lead to the team manager - never a sales exec - when NO telecaller is eligible', async () => {
    if (prisma === null) return;
    // The fixed rule (owner direction 2026-09-28): auto-assign is telecaller
    // only, so a project with no eligible telecaller falls to the creating
    // team's MANAGER as a pending handoff. A sales exec teammate must NOT be
    // picked - that is the bug, in the shape it actually reached production.
    //
    // Own project on purpose: sharing PROJECT_ID would pull TEAM_A/TEAM_B's
    // telecallers into the pool and the pool would never be empty.
    const PROJECT_SE = `auto-proj-se-${RUN_TAG}`;
    const TEAM_SE = `auto-team-se-${RUN_TAG}`;
    const SE_ONLY = `auto-se-only-${RUN_TAG}`;
    const MGR_SE = `auto-mgr-se-${RUN_TAG}`;
    await seed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_SE },
        update: {},
        create: {
          id: PROJECT_SE,
          name: `SE Only Project ${RUN_TAG}`,
          slug: `test-auto-assign-se-${RUN_TAG}`,
          address: 'test',
          organizationId: ORG,
        },
      });
      await seedUser(db, SE_ONLY, 'SALES_EXEC', 'SE Only');
      await seedUser(db, MGR_SE, 'MANAGER', 'Mgr SE');
      await db.team.upsert({
        where: { id: TEAM_SE },
        update: { autoAssignLeads: true, managerId: MGR_SE },
        create: {
          id: TEAM_SE,
          name: `Team SE ${RUN_TAG}`,
          managerId: MGR_SE,
          autoAssignLeads: true,
          organizationId: ORG,
        },
      });
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: SE_ONLY, teamId: TEAM_SE } },
        update: {},
        create: { userId: SE_ONLY, teamId: TEAM_SE, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_SE, teamId: TEAM_SE } },
        update: {},
        create: { projectId: PROJECT_SE, teamId: TEAM_SE, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'SE only routes to manager',
      phone: `+9199${((Date.now() + 600) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_SE,
      teamId: TEAM_SE,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    expect(lead.ownerId).toBe(MGR_SE);
    expect(lead.ownerId).not.toBe(SE_ONLY);
    const row = await seed((db) =>
      db.lead.findUnique({
        where: { id: lead.id },
        select: { ownerId: true, ownerType: true },
      }),
    );
    expect(row?.ownerType).toBe('MANAGER');
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

// ────────────────────────────────────────────────────────────────────────────
// T-MAXOPENLEADS (2026-09-28): a per-member open-lead ceiling
// ────────────────────────────────────────────────────────────────────────────
//
// `weight` decides the share among members who can take the lead; the cap
// decides whether they can take it at all. These are service-level tests because
// the cap is read per TeamMember row and resolved across memberships there.

describe('T-MAXOPENLEADS: a capped telecaller stops receiving new leads', () => {
  it('routes past a capped telecaller to an under-cap colleague', async () => {
    if (prisma === null) return;
    // The capped member is otherwise the MOST ATTRACTIVE pick (idle), so this
    // only passes if the cap actually overrides the score. Its cap is generous
    // (50) so it wins on merit among the eligible; the capped member has a lone
    // open lead - the lowest score in the pool - and must still be skipped.
    const PROJECT_CAP = `auto-proj-cap-${RUN_TAG}`;
    const TEAM_CAP = `auto-team-cap-${RUN_TAG}`;
    await seed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_CAP },
        update: {},
        create: {
          id: PROJECT_CAP,
          name: `Cap Project ${RUN_TAG}`,
          slug: `test-auto-cap-${RUN_TAG}`,
          address: 'test',
          organizationId: ORG,
        },
      });
      await db.team.upsert({
        where: { id: TEAM_CAP },
        update: { autoAssignLeads: true },
        create: {
          id: TEAM_CAP,
          name: `Cap Team ${RUN_TAG}`,
          managerId: null,
          autoAssignLeads: true,
          organizationId: ORG,
        },
      });
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_CAP, teamId: TEAM_CAP } },
        update: {},
        create: { projectId: PROJECT_CAP, teamId: TEAM_CAP, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
      // TC_A1 is capped at 2 and holds 2 open leads -> full, ineligible.
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: TC_A1, teamId: TEAM_CAP } },
        update: { maxOpenLeads: 2, weight: 1 },
        create: {
          userId: TC_A1,
          teamId: TEAM_CAP,
          organizationId: ORG,
          assignedById: ADMIN_ACTOR_ID,
          maxOpenLeads: 2,
          weight: 1,
        },
      });
      // TC_A2 is uncapped with a generous ceiling and starts idle, so it wins
      // the eligible pool (score 0.0) - making the capped member's exclusion the
      // only reason this test can pass.
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: TC_A2, teamId: TEAM_CAP } },
        update: { maxOpenLeads: 50, weight: 1 },
        create: {
          userId: TC_A2,
          teamId: TEAM_CAP,
          organizationId: ORG,
          assignedById: ADMIN_ACTOR_ID,
          maxOpenLeads: 50,
          weight: 1,
        },
      });
      for (let i = 0; i < 2; i++) {
        await db.lead.create({
          data: {
            id: `auto-cap-burden-${i}-${RUN_TAG}`,
            name: `Cap burden ${i}`,
            phone: `+9198${((Date.now() + 900 + i) % 100000000).toString().padStart(8, '0')}`,
            source: 'TEST',
            projectId: PROJECT_CAP,
            teamId: TEAM_CAP,
            ownerId: TC_A1,
            ownerType: 'TELECALLER',
            organizationId: ORG,
          },
        });
      }
    });

    const lead = await service.create(adminActor(), {
      name: 'Cap routes past',
      phone: `+9197${((Date.now() + 950) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_CAP,
      teamId: TEAM_CAP,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // TC_A1 is full (2/2) so the lead must land on the other telecaller.
    expect(lead.ownerId).not.toBe(TC_A1);
    expect(lead.ownerId).toBe(TC_A2);
  });

  it('hands the lead to the team manager when EVERY telecaller is at their ceiling', async () => {
    if (prisma === null) return;
    const PROJECT_FULL = `auto-proj-full-${RUN_TAG}`;
    const TEAM_FULL = `auto-team-full-${RUN_TAG}`;
    const MGR_FULL = `auto-mgr-full-${RUN_TAG}`;
    const TC_FULL = `auto-tc-full-${RUN_TAG}`;
    await seed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_FULL },
        update: {},
        create: {
          id: PROJECT_FULL,
          name: `Full Project ${RUN_TAG}`,
          slug: `test-auto-full-${RUN_TAG}`,
          address: 'test',
          organizationId: ORG,
        },
      });
      await seedUser(db, MGR_FULL, 'MANAGER', 'Mgr Full');
      await seedUser(db, TC_FULL, 'TELECALLER', 'TC Full');
      await db.team.upsert({
        where: { id: TEAM_FULL },
        update: { autoAssignLeads: true, managerId: MGR_FULL },
        create: {
          id: TEAM_FULL,
          name: `Full Team ${RUN_TAG}`,
          managerId: MGR_FULL,
          autoAssignLeads: true,
          organizationId: ORG,
        },
      });
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_FULL, teamId: TEAM_FULL } },
        update: {},
        create: { projectId: PROJECT_FULL, teamId: TEAM_FULL, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
      // The only telecaller has a ceiling of 1 and already holds 1 open lead.
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: TC_FULL, teamId: TEAM_FULL } },
        update: { maxOpenLeads: 1 },
        create: {
          userId: TC_FULL,
          teamId: TEAM_FULL,
          organizationId: ORG,
          assignedById: ADMIN_ACTOR_ID,
          maxOpenLeads: 1,
        },
      });
      await db.lead.create({
        data: {
          id: `auto-full-burden-${RUN_TAG}`,
          name: 'Full burden',
          phone: `+9196${((Date.now() + 970) % 100000000).toString().padStart(8, '0')}`,
          source: 'TEST',
          projectId: PROJECT_FULL,
          teamId: TEAM_FULL,
          ownerId: TC_FULL,
          ownerType: 'TELECALLER',
          organizationId: ORG,
        },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'Everyone capped',
      phone: `+9195${((Date.now() + 980) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_FULL,
      teamId: TEAM_FULL,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // The cap is honoured rather than exceeded: the lead goes to the manager as
    // a pending handoff.
    expect(lead.ownerId).toBe(MGR_FULL);
    expect(lead.ownerId).not.toBe(TC_FULL);
    const row = await seed((db) =>
      db.lead.findUnique({ where: { id: lead.id }, select: { ownerType: true } }),
    );
    expect(row?.ownerType).toBe('MANAGER');
  });

  it('a capped member stays capped across memberships and keeps their cap after dedupe', async () => {
    if (prisma === null) return;
    // Regression for the dedupe fold (T-MAXOPENLEADS): the first version merged
    // each row's cap against the ABSENT entry's `undefined`, which read as
    // "uncapped wins" and silently threw the cap away for every
    // single-membership member. That made `withinCap` never fire on this path -
    // the feature was inert while every unit test still passed.
    //
    // The fixture is built so dropping the cap FLIPS the outcome. The capped
    // member is deliberately the LEAST loaded (score 0.0) and its colleague
    // carries far more load (score 4.0): with the cap intact the colleague wins
    // by default, and if the cap is lost the idle member wins instead. So the
    // assertion names the bug rather than passing either way.
    const PROJECT_DEDUPE = `auto-proj-dedupe-${RUN_TAG}`;
    const TEAM_DEDUPE = `auto-team-dedupe-${RUN_TAG}`;
    await seed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_DEDUPE },
        update: {},
        create: {
          id: PROJECT_DEDUPE,
          name: `Dedupe Project ${RUN_TAG}`,
          slug: `test-auto-dedupe-${RUN_TAG}`,
          address: 'test',
          organizationId: ORG,
        },
      });
      await db.team.upsert({
        where: { id: TEAM_DEDUPE },
        update: { autoAssignLeads: true },
        create: {
          id: TEAM_DEDUPE,
          name: `Dedupe Team ${RUN_TAG}`,
          managerId: null,
          autoAssignLeads: true,
          organizationId: ORG,
        },
      });
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_DEDUPE, teamId: TEAM_DEDUPE } },
        update: {},
        create: { projectId: PROJECT_DEDUPE, teamId: TEAM_DEDUPE, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
      // CAP THE LEAST-LOADED MEMBER AND BURDEN THE OTHER. TC_A1 is at its
      // ceiling but holds ZERO open leads, so if the cap is dropped it scores
      // 0.0 and wins outright; with the cap intact the pool is just TC_A2,
      // which is carrying a heavy load.
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: TC_A1, teamId: TEAM_DEDUPE } },
        update: { maxOpenLeads: 0, weight: 1 },
        create: {
          userId: TC_A1,
          teamId: TEAM_DEDUPE,
          organizationId: ORG,
          assignedById: ADMIN_ACTOR_ID,
          maxOpenLeads: 0,
          weight: 1,
        },
      });
      // Uncapped colleague on the same team, deliberately busy (score 4.0).
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: TC_A2, teamId: TEAM_DEDUPE } },
        update: { maxOpenLeads: null, weight: 1 },
        create: {
          userId: TC_A2,
          teamId: TEAM_DEDUPE,
          organizationId: ORG,
          assignedById: ADMIN_ACTOR_ID,
          maxOpenLeads: null,
          weight: 1,
        },
      });
      for (let i = 0; i < 4; i++) {
        await db.lead.create({
          data: {
            id: `auto-dedupe-burden-${i}-${RUN_TAG}`,
            name: `Dedupe burden ${i}`,
            phone: `+9192${((Date.now() + 960 + i) % 100000000).toString().padStart(8, '0')}`,
            source: 'TEST',
            projectId: PROJECT_DEDUPE,
            teamId: TEAM_DEDUPE,
            ownerId: TC_A2,
            ownerType: 'TELECALLER',
            organizationId: ORG,
          },
        });
      }
    });

    const lead = await service.create(adminActor(), {
      name: 'Dedupe keeps the cap',
      phone: `+9191${((Date.now() + 965) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_DEDUPE,
      teamId: TEAM_DEDUPE,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // TC_A1 is at its ceiling (cap 0) while holding nothing, and the only other
    // option is an uncapped member with a heavy load. With the cap intact the
    // busy member wins; if the dedupe dropped the cap, the idle TC_A1 would be
    // picked instead.
    expect(lead.ownerId).toBe(TC_A2);
    expect(lead.ownerId).not.toBe(TC_A1);
  });

  it('an uncapped member is unaffected (the cap is opt-in)', async () => {
    if (prisma === null) return;
    const PROJECT_NOCAP = `auto-proj-nocap-${RUN_TAG}`;
    const TEAM_NOCAP = `auto-team-nocap-${RUN_TAG}`;
    const TC_NOCAP = `auto-tc-nocap-${RUN_TAG}`;
    await seed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_NOCAP },
        update: {},
        create: {
          id: PROJECT_NOCAP,
          name: `NoCap Project ${RUN_TAG}`,
          slug: `test-auto-nocap-${RUN_TAG}`,
          address: 'test',
          organizationId: ORG,
        },
      });
      await seedUser(db, TC_NOCAP, 'TELECALLER', 'TC NoCap');
      await db.team.upsert({
        where: { id: TEAM_NOCAP },
        update: { autoAssignLeads: true },
        create: {
          id: TEAM_NOCAP,
          name: `NoCap Team ${RUN_TAG}`,
          managerId: null,
          autoAssignLeads: true,
          organizationId: ORG,
        },
      });
      await db.projectTeam.upsert({
        where: { projectId_teamId: { projectId: PROJECT_NOCAP, teamId: TEAM_NOCAP } },
        update: {},
        create: { projectId: PROJECT_NOCAP, teamId: TEAM_NOCAP, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: TC_NOCAP, teamId: TEAM_NOCAP } },
        update: { maxOpenLeads: null },
        create: {
          userId: TC_NOCAP,
          teamId: TEAM_NOCAP,
          organizationId: ORG,
          assignedById: ADMIN_ACTOR_ID,
          maxOpenLeads: null,
        },
      });
      // A large existing load must NOT exclude an uncapped member.
      for (let i = 0; i < 5; i++) {
        await db.lead.create({
          data: {
            id: `auto-nocap-burden-${i}-${RUN_TAG}`,
            name: `NoCap burden ${i}`,
            phone: `+9194${((Date.now() + i) % 100000000).toString().padStart(8, '0')}`,
            source: 'TEST',
            projectId: PROJECT_NOCAP,
            teamId: TEAM_NOCAP,
            ownerId: TC_NOCAP,
            ownerType: 'TELECALLER',
            organizationId: ORG,
          },
        });
      }
    });

    const lead = await service.create(adminActor(), {
      name: 'NoCap still routes',
      phone: `+9193${((Date.now() + 990) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_NOCAP,
      teamId: TEAM_NOCAP,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    expect(lead.ownerId).toBe(TC_NOCAP);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The rule chain on lead-create is telecaller-only too (2026-09-28 gap fill)
// ────────────────────────────────────────────────────────────────────────────
//
// Gap left by the auto-assign fix: when auto-assign cannot route (no eligible
// telecaller) AND the creating team has no manager, create() falls back to the
// deterministic ManagerAssignmentRule chain. That chain used to auto-pick a
// SALES_EXEC - via a rule target or a team defaultAssigneeId - which is the same
// wrong-owner bug through a different door. `create()` now passes
// mode='new-lead', so a NEW lead can only be auto-routed to a telecaller.
//
// Both teams here are MANAGERLESS (autoAssignLeads omitted => false => the
// manager path declines), so the rule chain decides.

describe('rule chain on create: a NEW lead never auto-routes to a sales exec', () => {
  it('skips a sales-exec rule and routes to the next telecaller rule', async () => {
    if (prisma === null) return;
    const TEAM_CHAIN = `auto-team-chain-${RUN_TAG}`;
    // Two separate steps on purpose: the rule rows go through the owner-role
    // client (no INSERT policy on the pooled role), and Postgres cannot see a
    // team row that is still uncommitted inside the pooled seed transaction -
    // the FK would fail. So: commit the team first, then add the rules.
    await seed(async (db) => {
      await db.team.upsert({
        where: { id: TEAM_CHAIN },
        update: {},
        create: { id: TEAM_CHAIN, name: `Chain Team ${RUN_TAG}`, managerId: null, organizationId: ORG },
      });
    });
    // priority 1 → sales exec (must NOT fire), priority 5 → telecaller (wins).
    await directPrisma.managerAssignmentRule.createMany({
      data: [
        {
          id: `auto-rule-se-${RUN_TAG}`,
          teamId: TEAM_CHAIN,
          organizationId: ORG,
          source: 'TEST',
          targetUserId: SE_B1,
          priority: 1,
          active: true,
        },
        {
          id: `auto-rule-tc-${RUN_TAG}`,
          teamId: TEAM_CHAIN,
          organizationId: ORG,
          source: 'TEST',
          targetUserId: TC_A1,
          priority: 5,
          active: true,
        },
      ],
    });

    const lead = await service.create(adminActor(), {
      name: 'Chain skips exec',
      phone: `+9199${((Date.now() + 700) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_CHAIN,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // The telecaller rule wins; the exec rule is skipped, not fatal.
    expect(lead.ownerId).toBe(TC_A1);
    expect(lead.ownerId).not.toBe(SE_B1);
    const row = await seed((db) =>
      db.lead.findUnique({ where: { id: lead.id }, select: { ownerType: true } }),
    );
    expect(row?.ownerType).toBe('TELECALLER');
  });

  it('ignores a sales-exec team defaultAssigneeId on a NEW lead', async () => {
    if (prisma === null) return;
    const TEAM_DEF = `auto-team-def-${RUN_TAG}`;
    await seed(async (db) => {
      await db.team.upsert({
        where: { id: TEAM_DEF },
        update: { defaultAssigneeId: SE_B1 },
        create: {
          id: TEAM_DEF,
          name: `Default Team ${RUN_TAG}`,
          managerId: null,
          defaultAssigneeId: SE_B1,
          organizationId: ORG,
        },
      });
    });

    const lead = await service.create(adminActor(), {
      name: 'Exec default rejected',
      phone: `+9199${((Date.now() + 800) % 100000000).toString().padStart(8, '0')}`,
      source: 'TEST',
      projectId: PROJECT_ID,
      teamId: TEAM_DEF,
    } as unknown as Parameters<LeadsService['create']>[1]);
    LEAD_IDS.push(lead.id);

    // Falls through to the actor fallback (a teamless admin resolves to its own
    // team, so the owner is the actor) - the point is only that the exec does
    // NOT take the lead.
    expect(lead.ownerId).not.toBe(SE_B1);
    expect(lead.ownerId).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-TEAM-ROUND-ROBIN (2026-10-08): strict team rotation
// ────────────────────────────────────────────────────────────────────────────
//
// Every team linked to the project takes turns, one lead each, regardless of
// headcount or load. ON team -> its least-loaded telecaller; OFF team -> its
// manager directly. A team with no telecallers is skipped (its manager never
// gets a lead just because the team is empty).
//
// Each test builds its OWN project so rotation cursors start at NULL and the
// order is fully determined by team id.

interface TeamSpec {
  key: string;
  on: boolean;
  hasManager: boolean;
  telecallers: number;
  maxOpenLeads?: number | null;
  /** Role of the team's manager user; defaults to MANAGER. */
  managerRole?: 'MANAGER' | 'ADMIN';
}

interface RrFixture {
  projectId: string;
  teams: Record<string, { id: string; managerId: string | null; telecallerIds: string[] }>;
}

let rrSeq = 0;
function nextPhone(): string {
  rrSeq += 1;
  return `+9188${(Date.now() % 1000000).toString().padStart(6, '0')}${rrSeq.toString().padStart(2, '0')}`;
}

async function buildRrFixture(label: string, specs: readonly TeamSpec[]): Promise<RrFixture> {
  const projectId = `rr-proj-${label}-${RUN_TAG}`;
  const teams: RrFixture['teams'] = {};
  await seed(async (db) => {
    await db.project.upsert({
      where: { id: projectId },
      update: {},
      create: {
        id: projectId,
        name: `RR ${label} ${RUN_TAG}`,
        slug: `test-rr-${label}-${RUN_TAG}`,
        address: 'test',
        organizationId: ORG,
      },
    });
    for (const spec of specs) {
      // Ids sort by `key` ('a' < 'b' < 'c'), which fixes the first-turn order.
      const id = `rr-team-${spec.key}-${label}-${RUN_TAG}`;
      const managerId = spec.hasManager ? `rr-mgr-${spec.key}-${label}-${RUN_TAG}` : null;
      if (managerId !== null) await seedUser(db, managerId, spec.managerRole ?? 'MANAGER', `RR Mgr ${spec.key}`);
      await db.team.upsert({
        where: { id },
        update: {},
        create: {
          id,
          name: `RR ${spec.key} ${label} ${RUN_TAG}`,
          managerId,
          autoAssignLeads: spec.on,
          organizationId: ORG,
        },
      });
      const telecallerIds: string[] = [];
      for (let i = 0; i < spec.telecallers; i++) {
        const uid = `rr-tc-${spec.key}${i}-${label}-${RUN_TAG}`;
        await seedUser(db, uid, 'TELECALLER', `RR TC ${spec.key}${i}`);
        await db.teamMember.create({
          data: {
            userId: uid,
            teamId: id,
            organizationId: ORG,
            assignedById: ADMIN_ACTOR_ID,
            maxOpenLeads: spec.maxOpenLeads ?? null,
          },
        });
        telecallerIds.push(uid);
      }
      await db.projectTeam.create({
        data: { projectId, teamId: id, organizationId: ORG, assignedById: ADMIN_ACTOR_ID },
      });
      teams[spec.key] = { id, managerId, telecallerIds };
    }
  });
  return { projectId, teams };
}

async function createLeadIn(
  fx: RrFixture,
  teamKey: string,
  extra: Record<string, unknown> = {},
) {
  const lead = await service.create(adminActor(), {
    name: `RR lead ${rrSeq}`,
    phone: nextPhone(),
    source: 'TEST',
    projectId: fx.projectId,
    teamId: fx.teams[teamKey]!.id,
    ...extra,
  } as unknown as Parameters<LeadsService['create']>[1]);
  LEAD_IDS.push(lead.id);
  return lead;
}

describe('team round-robin: ON team -> telecaller, OFF team -> manager', () => {
  it('alternates A telecaller, B manager, A telecaller, B manager... for an ON/OFF pair', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('alt', [
      { key: 'a', on: true, hasManager: true, telecallers: 2 },
      { key: 'b', on: false, hasManager: true, telecallers: 3 },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 6; i++) owners.push((await createLeadIn(fx, 'a')).ownerId);

    const a = fx.teams.a!;
    const b = fx.teams.b!;
    // Odd turns: team A -> one of A's telecallers. Even turns: team B -> B's
    // manager, NOT one of B's three telecallers.
    owners.forEach((owner, i) => {
      if (i % 2 === 0) expect(a.telecallerIds).toContain(owner);
      else expect(owner).toBe(b.managerId);
    });
    // Within team A the least-loaded rule spreads the 3 A-turns over 2 people.
    const aPicks = owners.filter((_, i) => i % 2 === 0);
    expect(new Set(aPicks).size).toBe(2);
  });

  it('a team with NO telecallers is skipped - its manager never receives a lead', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('empty', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: false, hasManager: true, telecallers: 0 }, // empty OFF team
      { key: 'c', on: true, hasManager: true, telecallers: 1 },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 4; i++) owners.push((await createLeadIn(fx, 'a')).ownerId);

    expect(owners).not.toContain(fx.teams.b!.managerId);
    // Rotation continues A, C, A, C over the two teams that have telecallers.
    expect(owners).toEqual([
      fx.teams.a!.telecallerIds[0],
      fx.teams.c!.telecallerIds[0],
      fx.teams.a!.telecallerIds[0],
      fx.teams.c!.telecallerIds[0],
    ]);
  });

  it('an OFF team with telecallers but NO manager is skipped', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('nomgr', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: false, hasManager: false, telecallers: 2 },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 3; i++) owners.push((await createLeadIn(fx, 'a')).ownerId);

    // B can never take a turn (nobody to hand off to), so every lead stays in A.
    expect(owners).toEqual(Array(3).fill(fx.teams.a!.telecallerIds[0]));
    // ...and no B telecaller silently picked it up instead.
    for (const id of fx.teams.b!.telecallerIds) expect(owners).not.toContain(id);
  });

  it('an ON team whose telecallers are all at their ceiling is skipped', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('capped', [
      { key: 'a', on: true, hasManager: true, telecallers: 1, maxOpenLeads: 0 }, // always full
      { key: 'b', on: true, hasManager: true, telecallers: 1 },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 3; i++) owners.push((await createLeadIn(fx, 'a')).ownerId);

    expect(owners).toEqual(Array(3).fill(fx.teams.b!.telecallerIds[0]));
  });

  it('hands the lead to the CREATING team manager when no team can take it', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('nobody', [
      { key: 'a', on: true, hasManager: true, telecallers: 0 },
      { key: 'b', on: true, hasManager: true, telecallers: 0 },
    ]);
    const lead = await createLeadIn(fx, 'b');
    expect(lead.ownerId).toBe(fx.teams.b!.managerId);

    // Never silent: the audit row records the fallback and why each team was skipped.
    const audit = await seed((db) =>
      db.auditLog.findFirst({
        where: { entityId: lead.id, action: 'lead.assigned' },
        select: { after: true },
      }),
    );
    const routing = (audit?.after as { routing?: { branch: string; skipped: unknown[] } }).routing;
    expect(routing?.branch).toBe('creating-team-fallback');
    expect(routing?.skipped).toEqual(
      expect.arrayContaining([
        { teamId: fx.teams.a!.id, reason: 'no-telecallers' },
        { teamId: fx.teams.b!.id, reason: 'no-telecallers' },
      ]),
    );
  });

  it('records the chosen team and previous cursor in the audit metadata', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('audit', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: false, hasManager: true, telecallers: 1 },
    ]);
    const first = await createLeadIn(fx, 'a');
    const second = await createLeadIn(fx, 'a');

    const routingOf = async (leadId: string) => {
      const row = await seed((db) =>
        db.auditLog.findFirst({
          where: { entityId: leadId, action: 'lead.assigned' },
          select: { after: true },
        }),
      );
      return (row?.after as { routing: { branch: string; chosenTeamId: string; previousLastAssignedAt: string | null } })
        .routing;
    };
    const r1 = await routingOf(first.id);
    const r2 = await routingOf(second.id);
    expect(r1).toMatchObject({ branch: 'team-telecaller', chosenTeamId: fx.teams.a!.id, previousLastAssignedAt: null });
    expect(r2).toMatchObject({ branch: 'team-manager', chosenTeamId: fx.teams.b!.id, previousLastAssignedAt: null });
  });

  it('a lead created in an OFF team goes to ITS manager and does not advance the rotation', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('offcreate', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: false, hasManager: true, telecallers: 1 },
    ]);
    const viaB = await createLeadIn(fx, 'b');
    expect(viaB.ownerId).toBe(fx.teams.b!.managerId);

    const cursors = await seed((db) =>
      db.projectTeam.findMany({
        where: { projectId: fx.projectId },
        select: { lastAssignedAt: true },
      }),
    );
    expect(cursors.every((c) => c.lastAssignedAt === null)).toBe(true);
    // The next ON-team create is therefore still turn 1 -> team A.
    const viaA = await createLeadIn(fx, 'a');
    expect(viaA.ownerId).toBe(fx.teams.a!.telecallerIds[0]);
  });

  it('an explicit assignedOwnerId does not consume a team turn', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('override', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: true, hasManager: true, telecallers: 1 },
    ]);
    const forced = await createLeadIn(fx, 'a', {
      assignedOwnerId: fx.teams.b!.telecallerIds[0],
    });
    expect(forced.ownerId).toBe(fx.teams.b!.telecallerIds[0]);

    const cursors = await seed((db) =>
      db.projectTeam.findMany({
        where: { projectId: fx.projectId },
        select: { lastAssignedAt: true },
      }),
    );
    expect(cursors.every((c) => c.lastAssignedAt === null)).toBe(true);
  });

  it('concurrent creates take different turns (advisory lock serializes the pick)', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('conc', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: true, hasManager: true, telecallers: 1 },
    ]);
    const leads = await Promise.all([createLeadIn(fx, 'a'), createLeadIn(fx, 'a')]);
    const owners = leads.map((l) => l.ownerId).sort();
    // Without the lock both reads see a NULL cursor and both pick team A.
    expect(owners).toEqual(
      [fx.teams.a!.telecallerIds[0]!, fx.teams.b!.telecallerIds[0]!].sort(),
    );
  });

  it('an OFF team whose "manager" is an ADMIN (not a MANAGER; one-owner-per-org forbids seeding a 2nd OWNER, same code path) is skipped, never handed the lead', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('ownermgr', [
      { key: 'a', on: true, hasManager: true, telecallers: 1 },
      { key: 'b', on: false, hasManager: true, telecallers: 1, managerRole: 'ADMIN' },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 3; i++) owners.push((await createLeadIn(fx, 'a')).ownerId);

    expect(owners).not.toContain(fx.teams.b!.managerId);
    expect(owners).toEqual(Array(3).fill(fx.teams.a!.telecallerIds[0]));
    // Not silent: the first create records why team B was passed over.
    const first = await seed((db) =>
      db.auditLog.findFirst({
        where: { entityType: 'Lead', action: 'lead.assigned', after: { path: ['routing', 'skipped'], array_contains: [{ teamId: fx.teams.b!.id, reason: 'invalid-manager' }] } },
        select: { id: true },
      }),
    );
    expect(first).not.toBeNull();
  });

  it('a lead created in an OFF team whose manager is an ADMIN is NOT handed to that user', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('ownercreate', [
      { key: 'a', on: false, hasManager: true, telecallers: 1, managerRole: 'ADMIN' },
    ]);
    const lead = await createLeadIn(fx, 'a');
    expect(lead.ownerId).not.toBe(fx.teams.a!.managerId);

    const audit = await seed((db) =>
      db.auditLog.findFirst({
        where: { entityId: lead.id, action: 'lead.assigned' },
        select: { after: true },
      }),
    );
    const routing = (audit?.after as { routing?: { skipped: unknown[] } }).routing;
    expect(routing?.skipped).toEqual([{ teamId: fx.teams.a!.id, reason: 'invalid-manager' }]);
  });

  it('two OFF teams: an admin creating WITHOUT a team alternates between the two managers', async () => {
    if (prisma === null) return;
    // The reported bug: a teamless admin always fell to the oldest team, so one
    // manager received every lead.
    const fx = await buildRrFixture('twooff', [
      { key: 'a', on: false, hasManager: true, telecallers: 1 },
      { key: 'b', on: false, hasManager: true, telecallers: 1 },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 4; i++) {
      const lead = await service.create(adminActor(), {
        name: `Teamless ${i}`,
        phone: nextPhone(),
        source: 'TEST',
        projectId: fx.projectId,
      } as unknown as Parameters<LeadsService['create']>[1]);
      LEAD_IDS.push(lead.id);
      owners.push(lead.ownerId);
    }
    expect(owners).toEqual([
      fx.teams.a!.managerId,
      fx.teams.b!.managerId,
      fx.teams.a!.managerId,
      fx.teams.b!.managerId,
    ]);
  });

  it('an OFF team with an invalid manager is not chosen as the default team', async () => {
    if (prisma === null) return;
    const fx = await buildRrFixture('twooffbad', [
      { key: 'a', on: false, hasManager: true, telecallers: 1, managerRole: 'ADMIN' },
      { key: 'b', on: false, hasManager: true, telecallers: 1 },
    ]);
    const owners: string[] = [];
    for (let i = 0; i < 2; i++) {
      const lead = await service.create(adminActor(), {
        name: `Teamless bad ${i}`,
        phone: nextPhone(),
        source: 'TEST',
        projectId: fx.projectId,
      } as unknown as Parameters<LeadsService['create']>[1]);
      LEAD_IDS.push(lead.id);
      owners.push(lead.ownerId);
    }
    expect(owners).toEqual([fx.teams.b!.managerId, fx.teams.b!.managerId]);
  });
});
