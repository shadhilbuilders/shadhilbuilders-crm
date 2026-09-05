// T-G1 — Reassign integration test (Plan §18 D2/D3).
//
// Real-DB tests (no mocks). The reassign method runs inside
// withRlsContext(actor) so we use the bare prisma client to seed
// fixtures under an admin actor (who can write everything), then
// invoke leads.reassign with the actor-under-test.
//
// What we cover (each = one `it`):
//   1. ADMIN can reassign to a target in any team (cross-team happy).
//   2. MANAGER can reassign to a target in the same team.
//   3. MANAGER CANNOT reassign to a target in a different team (403).
//   4. TELECALLER / SALES_EXEC cannot reassign (403).
//   5. The target user's role must permit owning the lead at its
//      current state (400 on lane violation; e.g. SALES_EXEC assigned
//      a NEW lead).
//   6. The reassign writes the audit row with the right before/after.
//   7. Same-owner reassign is a no-op (returns the same row, no audit).
//
// History: the previous test file (apps/backend/src/leads/leads.service.test.ts)
// only covered the pure listWhere function. This file is the real-DB
// coverage for the reassign flow; the T-G1 verify line in
// docs/planning/IMPLEMENTATION-PLAN-v1.md calls for an "integration
// test" for reassign specifically.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { LeadsService } from './leads.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Per-test unique IDs so re-runs don't collide on FK / unique constraints.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEAM_A_ID = `test-reassign-teamA-${RUN_TAG}`;
const TEAM_B_ID = `test-reassign-teamB-${RUN_TAG}`;
const ADMIN_ID = `test-reassign-admin-${RUN_TAG}`;
const MGR_A_ID = `test-reassign-mgrA-${RUN_TAG}`;
const TC_A_ID = `test-reassign-tcA-${RUN_TAG}`;
const TC_A2_ID = `test-reassign-tcA2-${RUN_TAG}`;
const TC_B_ID = `test-reassign-tcB-${RUN_TAG}`;
const SE_A_ID = `test-reassign-seA-${RUN_TAG}`;
const SE_OWNER_ID = `test-reassign-seOwner-${RUN_TAG}`;
const SE_A2_ID = `test-reassign-seA2-${RUN_TAG}`;
const LEAD_ID = `test-reassign-lead-${RUN_TAG}`;

const TEST_LEAD_IDS: string[] = [LEAD_ID];
const TEST_AUDIT_KEYS: string[] = [];

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(overrides: Partial<JwtPayload> & Pick<JwtPayload, 'sub' | 'role' | 'teamId'>): JwtPayload {
  return {
    sub: overrides.sub,
    email: `${overrides.sub}@test.local`,
    role: overrides.role,
    teamId: overrides.teamId,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    // Two teams.
    await db.team.upsert({
      where: { id: TEAM_A_ID },
      update: {},
      create: { id: TEAM_A_ID, name: `Reassign Test Team A ${RUN_TAG}` },
    });
    await db.team.upsert({
      where: { id: TEAM_B_ID },
      update: {},
      create: { id: TEAM_B_ID, name: `Reassign Test Team B ${RUN_TAG}` },
    });

    // ADMIN (cross-team, used for seeding + as a reassigner).
    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: { teamId: TEAM_A_ID, role: 'ADMIN' },
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'Reassign Test Admin',
        role: 'ADMIN',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });
    // MANAGER for team A.
    await db.user.upsert({
      where: { id: MGR_A_ID },
      update: { teamId: TEAM_A_ID, role: 'MANAGER' },
      create: {
        id: MGR_A_ID,
        email: `${MGR_A_ID}@test.local`,
        name: 'Reassign Test Manager A',
        role: 'MANAGER',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });
    // TELECALLER in team A (current owner of the test lead).
    await db.user.upsert({
      where: { id: TC_A_ID },
      update: { teamId: TEAM_A_ID, role: 'TELECALLER' },
      create: {
        id: TC_A_ID,
        email: `${TC_A_ID}@test.local`,
        name: 'Reassign Test TC A',
        role: 'TELECALLER',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });
    // Another TELECALLER in team A (same-team reassign target).
    await db.user.upsert({
      where: { id: TC_A2_ID },
      update: { teamId: TEAM_A_ID, role: 'TELECALLER' },
      create: {
        id: TC_A2_ID,
        email: `${TC_A2_ID}@test.local`,
        name: 'Reassign Test TC A2',
        role: 'TELECALLER',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });
    // TELECALLER in team B (cross-team reassign target).
    await db.user.upsert({
      where: { id: TC_B_ID },
      update: { teamId: TEAM_B_ID, role: 'TELECALLER' },
      create: {
        id: TC_B_ID,
        email: `${TC_B_ID}@test.local`,
        name: 'Reassign Test TC B',
        role: 'TELECALLER',
        teamId: TEAM_B_ID,
        mustChangePassword: false,
      },
    });
    // SALES_EXEC in team A — for the "target role can't own NEW lead" test.
    await db.user.upsert({
      where: { id: SE_A_ID },
      update: { teamId: TEAM_A_ID, role: 'SALES_EXEC' },
      create: {
        id: SE_A_ID,
        email: `${SE_A_ID}@test.local`,
        name: 'Reassign Test SE A',
        role: 'SALES_EXEC',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });
    // A SALES_EXEC in team A that CAN own the lead (after we move
    // the lead to VISITED). Also used to verify the "target lane
    // OK" path on a different lead state.
    await db.user.upsert({
      where: { id: SE_OWNER_ID },
      update: { teamId: TEAM_A_ID, role: 'SALES_EXEC' },
      create: {
        id: SE_OWNER_ID,
        email: `${SE_OWNER_ID}@test.local`,
        name: 'Reassign Test SE Owner',
        role: 'SALES_EXEC',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });
    // Yet another TELECALLER in team A — used for the same-owner
    // no-op test (reassign to current owner).
    await db.user.upsert({
      where: { id: SE_A2_ID },
      update: { teamId: TEAM_A_ID, role: 'TELECALLER' },
      create: {
        id: SE_A2_ID,
        email: `${SE_A2_ID}@test.local`,
        name: 'Reassign Test TC A2 (alt)',
        role: 'TELECALLER',
        teamId: TEAM_A_ID,
        mustChangePassword: false,
      },
    });

    // The lead under test — NEW state, telecaller-owned, team A.
    // Phone must be unique; use a per-run suffix.
    await db.lead.upsert({
      where: { id: LEAD_ID },
      update: {
        phone: `91${RUN_TAG.slice(0, 8)}001`,
        phoneE164: `91${RUN_TAG.slice(0, 8)}001`,
      },
      create: {
        id: LEAD_ID,
        name: `Reassign Test Lead ${RUN_TAG}`,
        phone: `91${RUN_TAG.slice(0, 8)}001`,
        phoneE164: `91${RUN_TAG.slice(0, 8)}001`,
        source: 'WEBSITE',
        state: 'NEW',
        teamId: TEAM_A_ID,
        ownerId: TC_A_ID,
        ownerType: 'TELECALLER',
      },
    });
  });
}, 30_000);

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (tx) => {
    const db = tx as unknown as PrismaClient;
    // Delete the audit rows for the test lead (so re-runs don't see
    // them). Audit rows aren't cascade-deleted with the lead (audit
    // log is a write-only append log).
    await db.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'Lead', entityId: { in: TEST_LEAD_IDS } },
          { userId: { in: [TC_A_ID, TC_A2_ID, TC_B_ID, SE_A_ID, SE_OWNER_ID, SE_A2_ID, MGR_A_ID, ADMIN_ID] } },
        ],
      },
    });
    if (TEST_LEAD_IDS.length > 0) {
      await db.lead.deleteMany({ where: { id: { in: TEST_LEAD_IDS } } });
    }
  });
  TEST_LEAD_IDS.length = 0;
  TEST_AUDIT_KEYS.length = 0;
}, 30_000);

beforeEach(async () => {
  // Reset the test lead to its canonical starting state before each
  // test. Many tests mutate the lead (reassign to various owners,
  // transition to VISITED); without this reset, subsequent tests
  // see stale state and fail with 404 (if the lead was deleted by
  // a prior test) or with wrong-owner assertions.
  TEST_AUDIT_KEYS.length = 0;
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.lead.update({
      where: { id: LEAD_ID },
      data: {
        ownerId: TC_A_ID,
        teamId: TEAM_A_ID,
        ownerType: 'TELECALLER',
        state: 'NEW',
      },
    });
  });
});

function makeLeadsService(): LeadsService {
  return new LeadsService({ $client: prisma } as unknown as PrismaService);
}

describe.skipIf(!HAS_DB)('T-G1 LeadsService.reassign', () => {
  it('ADMIN reassigns to a target in a different team (cross-team happy path)', async () => {
    const leads = makeLeadsService();
    const result = await leads.reassign(
      actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID }),
      {
        leadId: LEAD_ID,
        targetUserId: TC_B_ID,
        reason: 'Test: cross-team reassign',
      },
    );
    expect(result.id).toBe(LEAD_ID);
    expect(result.ownerId).toBe(TC_B_ID);
    // The lead's team follows the new owner.
    expect((result as unknown as { teamId?: string }).teamId).toBeUndefined(); // LeadRow doesn't expose teamId
    // Re-read the row to verify the teamId flipped.
    const row = await adminSeed(async (db) =>
      db.lead.findUnique({ where: { id: LEAD_ID }, select: { ownerId: true, teamId: true, ownerType: true } }),
    );
    expect(row?.ownerId).toBe(TC_B_ID);
    expect(row?.teamId).toBe(TEAM_B_ID);
    expect(row?.ownerType).toBe('TELECALLER');
    TEST_AUDIT_KEYS.push(LEAD_ID);
  });

  it('MANAGER reassigns to a target in the same team (happy path)', async () => {
    // Reset owner back to TC_A (in team A) for this test.
    await adminSeed(async (db) => {
      await db.lead.update({
        where: { id: LEAD_ID },
        data: { ownerId: TC_A_ID, teamId: TEAM_A_ID, ownerType: 'TELECALLER' },
      });
    });

    const leads = makeLeadsService();
    const result = await leads.reassign(
      actorFor({ sub: MGR_A_ID, role: 'MANAGER', teamId: TEAM_A_ID }),
      {
        leadId: LEAD_ID,
        targetUserId: TC_A2_ID,
        reason: 'Test: same-team reassign',
      },
    );
    expect(result.ownerId).toBe(TC_A2_ID);
    TEST_AUDIT_KEYS.push(LEAD_ID);
  });

  it('MANAGER CANNOT reassign to a target in a different team (403)', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.reassign(
        actorFor({ sub: MGR_A_ID, role: 'MANAGER', teamId: TEAM_A_ID }),
        {
          leadId: LEAD_ID,
          targetUserId: TC_B_ID, // in team B
          reason: 'Test: cross-team attempt',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TELECALLER cannot reassign (403 — only ADMIN/MANAGER)', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.reassign(
        actorFor({ sub: TC_A_ID, role: 'TELECALLER', teamId: TEAM_A_ID }),
        {
          leadId: LEAD_ID,
          targetUserId: TC_A2_ID,
          reason: 'Test: telecaller attempt',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('SALES_EXEC cannot reassign (403)', async () => {
    // RLS caveat: SALES_EXEC's policy only lets them SELECT leads
    // they own. If the test lead (owned by TC_A) is queried by
    // SE_A, RLS returns 0 rows → the service throws 404 BEFORE the
    // role check fires. To exercise the service-layer role check
    // (which is what the test is verifying), the lead must be
    // owned by SE_A. We do that in beforeEach for the role-reject
    // tests only — see `it.skip` block + manual owned-by-owner
    // override below.
    //
    // We re-seed the lead owned by SE_A for the duration of this
    // test, then beforeEach at the next test will reset it back
    // to TC_A.
    await adminSeed(async (db) => {
      await db.lead.update({
        where: { id: LEAD_ID },
        data: {
          ownerId: SE_A_ID,
          teamId: TEAM_A_ID,
          ownerType: 'SALES_EXEC',
          state: 'NEW',
        },
      });
    });

    const leads = makeLeadsService();
    await expect(
      leads.reassign(
        actorFor({ sub: SE_A_ID, role: 'SALES_EXEC', teamId: TEAM_A_ID }),
        {
          leadId: LEAD_ID,
          targetUserId: TC_A2_ID,
          reason: 'Test: sales exec attempt',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Target role that cannot own the lead state — 400 lane violation', async () => {
    // Lead is in NEW state. SALES_EXEC's lane starts at VISITED,
    // so assigning a NEW lead to a SALES_EXEC is invalid.
    const leads = makeLeadsService();
    await expect(
      leads.reassign(
        actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID }),
        {
          leadId: LEAD_ID,
          targetUserId: SE_A_ID, // SALES_EXEC, lane starts at VISITED
          reason: 'Test: bad lane',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Target role CAN own a lead at VISITED — SALES_EXEC happy path', async () => {
    // Move the lead through the legal state path. NEW can't go
    // directly to VISITED — must go NEW → CONTACTED →
    // VISIT_REQUESTED → VISIT_SCHEDULED → VISITED.
    const leads = makeLeadsService();
    const admin = actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID });
    await leads.transition(admin, { leadId: LEAD_ID, toState: 'CONTACTED' });
    await leads.transition(admin, { leadId: LEAD_ID, toState: 'VISIT_REQUESTED' });
    await leads.transition(admin, { leadId: LEAD_ID, toState: 'VISIT_SCHEDULED' });
    await leads.transition(admin, { leadId: LEAD_ID, toState: 'VISITED' });

    // Now reassign to SE_OWNER (SALES_EXEC in team A) — valid
    // because SALES_EXEC's lane starts at VISITED.
    const result = await leads.reassign(admin, {
      leadId: LEAD_ID,
      targetUserId: SE_OWNER_ID,
      reason: 'Test: exec lane happy',
    });
    expect(result.ownerId).toBe(SE_OWNER_ID);
    TEST_AUDIT_KEYS.push(LEAD_ID);
    // beforeEach resets state to NEW; nothing more to do.
  });

  it('Audit row is written with correct before/after', async () => {
    // The test lead was just reset by beforeEach to
    // {ownerId: TC_A_ID, state: NEW}. Reassign to TC_A2_ID.
    const before = await adminSeed(async (db) =>
      db.lead.findUnique({
        where: { id: LEAD_ID },
        select: { ownerId: true, ownerType: true, teamId: true, coOwnerId: true },
      }),
    );
    expect(before).not.toBeNull();
    expect(before?.ownerId).toBe(TC_A_ID); // belt + suspenders

    const leads = makeLeadsService();
    const reason = `Test: audit verification ${RUN_TAG}`; // RUN_TAG makes the query unique per process
    await leads.reassign(
      actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID }),
      {
        leadId: LEAD_ID,
        targetUserId: TC_A2_ID,
        reason,
      },
    );

    // Filter on the unique reason so we don't pick up audit rows
    // from previous tests in the same run.
    const audit = await adminSeed(async (db) =>
      db.auditLog.findFirst({
        where: {
          entityType: 'Lead',
          entityId: LEAD_ID,
          action: 'lead.reassign',
          userId: ADMIN_ID,
          reason,
        },
      }),
    );
    expect(audit).not.toBeNull();
    const beforeJson = audit?.before as Record<string, unknown>;
    const afterJson = audit?.after as Record<string, unknown>;
    expect(beforeJson.ownerId).toBe(TC_A_ID);
    expect(beforeJson.teamId).toBe(TEAM_A_ID);
    expect(afterJson.ownerId).toBe(TC_A2_ID);
    expect(afterJson.teamId).toBe(TEAM_A_ID); // TC_A2 is in team A
    expect(afterJson.ownerType).toBe('TELECALLER');
    TEST_AUDIT_KEYS.push(LEAD_ID);
  });

  it('Same-owner reassign is a no-op (returns the same row, no audit row for this attempt)', async () => {
    // The test lead was just reset by beforeEach to
    // {ownerId: TC_A_ID, state: NEW}. Reassign to the SAME owner.
    const leads = makeLeadsService();
    const reason = `Test: same-owner no-op ${RUN_TAG}`;
    const result = await leads.reassign(
      actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID }),
      {
        leadId: LEAD_ID,
        targetUserId: TC_A_ID, // same owner (beforeEach reset it to this)
        reason,
      },
    );
    expect(result.ownerId).toBe(TC_A_ID);

    // No new audit row should have been created (the no-op branch
    // returns before the audit insert). Filter on the unique
    // reason so we don't pick up rows from previous tests.
    const auditCount = await adminSeed(async (db) =>
      db.auditLog.count({
        where: {
          entityType: 'Lead',
          entityId: LEAD_ID,
          action: 'lead.reassign',
          reason,
        },
      }),
    );
    expect(auditCount).toBe(0);
  });

  it('Unknown lead id → 404', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.reassign(
        actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID }),
        {
          leadId: 'this-lead-does-not-exist',
          targetUserId: TC_A_ID,
          reason: 'Test: 404',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('Unknown target user id → 404', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.reassign(
        actorFor({ sub: ADMIN_ID, role: 'ADMIN', teamId: TEAM_A_ID }),
        {
          leadId: LEAD_ID,
          targetUserId: 'this-user-does-not-exist',
          reason: 'Test: 404 user',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
