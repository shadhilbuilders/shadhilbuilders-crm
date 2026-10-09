// Lead Detail endpoints - findOne + activities integration test.
// Real-DB tests (no mocks), mirroring leads.reassign.test.ts.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { createId } from '@paralleldrive/cuid2';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { recordLeadActivity } from './lead-activity';
import { LeadsService } from './leads.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL, so the
// fixture leads below need a project.
const TEST_PROJECT_ID = 'testprojdetail' + Date.now().toString();
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Per-test unique IDs using real cuid2 so they pass z.cuid2() validation.
const TEAM_A_ID = createId();
const TEAM_B_ID = createId();
const ADMIN_ID = createId();
const TC_A_ID = createId();
const TC_B_ID = createId();
const LEAD_ID = createId();

const TEST_LEAD_IDS: string[] = [LEAD_ID];
// Every business row now carries organizationId (T-ORG multitenancy).
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
    sub: overrides.sub,
    email: `${overrides.sub}@test.local`,
    role: overrides.role,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    // T-LEAD-PROJECT-REQUIRED (2026-09-16): the lead fixtures below point
    // at this project (Lead.projectId is NOT NULL).
    await db.project.upsert({
      where: { id: TEST_PROJECT_ID },
      update: {},
      create: {
        id: TEST_PROJECT_ID,
        name: `Test Project ${TEST_PROJECT_ID}`,
        slug: TEST_PROJECT_ID,
        address: 'test',
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
    });
    await db.team.upsert({
      where: { id: TEAM_A_ID },
      update: {},
      create: {
        id: TEAM_A_ID,
        name: `Detail Test Team A ${TEAM_A_ID.slice(0, 8)}`,
        organizationId: ORG,
      },
    });
    await db.team.upsert({
      where: { id: TEAM_B_ID },
      update: {},
      create: {
        id: TEAM_B_ID,
        name: `Detail Test Team B ${TEAM_B_ID.slice(0, 8)}`,
        organizationId: ORG,
      },
    });
    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: { role: 'ADMIN' },
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'Detail Test Admin',
        role: 'ADMIN',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_A_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: TC_A_ID,
        email: `${TC_A_ID}@test.local`,
        name: 'Detail Test TC A',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_B_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: TC_B_ID,
        email: `${TC_B_ID}@test.local`,
        name: 'Detail Test TC B',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    for (const [userId, teamId] of [
      [TC_A_ID, TEAM_A_ID],
      [TC_B_ID, TEAM_B_ID],
    ] as const) {
      await db.teamMember.upsert({
        where: { userId_teamId: { userId, teamId } },
        update: {},
        create: { userId, teamId, organizationId: ORG },
      });
    }
    await db.lead.upsert({
      where: { id: LEAD_ID },
      update: {
        phone: `91${LEAD_ID.slice(0, 8)}002`,
        phoneE164: `91${LEAD_ID.slice(0, 8)}002`,
      },
      create: {
        id: LEAD_ID,
        name: `Detail Test Lead ${LEAD_ID.slice(0, 8)}`,
        phone: `91${LEAD_ID.slice(0, 8)}002`,
        phoneE164: `91${LEAD_ID.slice(0, 8)}002`,
        email: 'detail@test.local',
        source: 'WEBSITE',
        state: 'NEW',
        teamId: TEAM_A_ID,
        ownerId: TC_A_ID,
        ownerType: 'TELECALLER',
        organizationId: ORG,

        projectId: TEST_PROJECT_ID,
      },
    });
  });
}, 30_000);

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (tx) => {
    const db = tx as unknown as PrismaClient;
    await db.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'Lead', entityId: { in: TEST_LEAD_IDS } },
          { userId: { in: [TC_A_ID, TC_B_ID, ADMIN_ID] } },
        ],
      },
    });
    if (TEST_LEAD_IDS.length > 0) {
      await db.lead.deleteMany({ where: { id: { in: TEST_LEAD_IDS } } });
    }
  });
  TEST_LEAD_IDS.length = 0;
}, 30_000);

beforeEach(async () => {
  // Reset the test lead to its canonical starting state before each test.
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

describe.skipIf(!HAS_DB)('LeadsService.findOne', () => {
  it('returns the full detail row for a visible lead', async () => {
    const leads = makeLeadsService();
    const result = await leads.findOne(
      actorFor({ sub: ADMIN_ID, role: 'ADMIN' }),
      LEAD_ID,
    );
    expect(result.id).toBe(LEAD_ID);
    expect(result.name).toContain('Detail Test Lead');
    expect(result.phone).toContain('91');
    expect(result.email).toBe('detail@test.local');
    expect(result.source).toBe('WEBSITE');
    expect(result.status).toBe('NEW');
    expect(result.ownerId).toBe(TC_A_ID);
    expect(result.ownerName).toBe('Detail Test TC A');
    expect(result.ownerType).toBe('TELECALLER');
    expect(result.coOwnerId).toBeNull();
    expect(result.coOwnerName).toBeNull();
    expect(result.teamId).toBe(TEAM_A_ID);
    // T-LEAD-PROJECT-REQUIRED (2026-09-16): was toBeNull(). A lead now always
    // belongs to a project, so detail returns the fixture's project id.
    expect(result.projectId).toBe(TEST_PROJECT_ID);
    expect(typeof result.createdAt).toBe('string');
    expect(typeof result.updatedAt).toBe('string');
  });

  it('404s for a missing lead', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.findOne(
        actorFor({ sub: ADMIN_ID, role: 'ADMIN' }),
        createId(), // non-existent cuid2
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for a lead the actor cannot see (RLS-silent-zero)', async () => {
    const leads = makeLeadsService();
    // TC_B is in team B; the lead is in team A and owned by TC_A. RLS
    // hides it, so findOne surfaces a typed 404 (indistinguishable from
    // a missing row - correct for this actor).
    await expect(
      leads.findOne(
        actorFor({ sub: TC_B_ID, role: 'TELECALLER'}),
        LEAD_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe.skipIf(!HAS_DB)('LeadsService.activities', () => {
  it('returns the timeline oldest → newest with userName joined', async () => {
    const leads = makeLeadsService();
    // Seed two activities with distinct timestamps.
    await adminSeed(async (db) => {
      await db.activity.create({
        data: {
          leadId: LEAD_ID,
          userId: TC_A_ID,
          type: 'CALL',
          body: 'First call',
          createdAt: new Date(Date.now() - 60_000),
          organizationId: ORG,
        },
      });
      await db.activity.create({
        data: {
          leadId: LEAD_ID,
          userId: TC_A_ID,
          type: 'NOTE',
          body: 'Follow-up note',
          createdAt: new Date(),
          organizationId: ORG,
        },
      });
    });

    const result = await leads.activities(
      actorFor({ sub: ADMIN_ID, role: 'ADMIN'}),
      LEAD_ID,
    );
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.nextCursor).toBeNull();
    // Oldest first.
    expect(result.items[0].type).toBe('CALL');
    expect(result.items[0].body).toBe('First call');
    expect(result.items[0].userName).toBe('Detail Test TC A');
    expect(result.items[1].type).toBe('NOTE');
    expect(result.items[1].userName).toBe('Detail Test TC A');
    expect(typeof result.items[0].createdAt).toBe('string');
  });

  it('404s for a missing lead', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.activities(
        actorFor({ sub: ADMIN_ID, role: 'ADMIN' }),
        createId(), // non-existent cuid2
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for a lead the actor cannot see (RLS-silent-zero)', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.activities(
        actorFor({ sub: TC_B_ID, role: 'TELECALLER'}),
        LEAD_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── Timeline writes + cap ───────────────────────────────────────────────────
// Each lead-affecting action leaves exactly ONE Activity row (same tx as the
// business write); activities() returns the newest 200, oldest-first.
describe.skipIf(!HAS_DB)('Lead timeline writes', () => {
  const WRITE_LEAD_ID = createId();
  const CAP_LEAD_ID = createId();

  beforeAll(async () => {
    TEST_LEAD_IDS.push(WRITE_LEAD_ID, CAP_LEAD_ID);
    await adminSeed(async (db) => {
      for (const [id, n] of [
        [WRITE_LEAD_ID, '003'],
        [CAP_LEAD_ID, '004'],
      ] as const) {
        await db.lead.create({
          data: {
            id,
            name: `Timeline Lead ${id.slice(0, 8)}`,
            phone: `91${id.slice(0, 8)}${n}`,
            phoneE164: `91${id.slice(0, 8)}${n}`,
            source: 'WEBSITE',
            state: 'NEW',
            teamId: TEAM_A_ID,
            ownerId: TC_A_ID,
            ownerType: 'TELECALLER',
            organizationId: ORG,
            projectId: TEST_PROJECT_ID,
          },
        });
      }
    });
  }, 30_000);

  async function rows(leadId: string) {
    return adminSeed((db) =>
      db.activity.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } }),
    );
  }

  it('transition leaves exactly one STATUS_CHANGE row with the friendly sentence', async () => {
    const leads = makeLeadsService();
    await leads.transition(actorFor({ sub: TC_A_ID, role: 'TELECALLER' }), {
      leadId: WRITE_LEAD_ID,
      toState: 'CONTACTED',
      reason: 'Picked up',
    });
    const got = await rows(WRITE_LEAD_ID);
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe('STATUS_CHANGE');
    expect(got[0].body).toBe('New -> Talked - Picked up');
    expect(got[0].userId).toBe(TC_A_ID);
    expect(got[0].organizationId).toBe(ORG);
  });

  it('transitionInTransaction with activity "skip" writes no STATUS_CHANGE row', async () => {
    const leads = makeLeadsService();
    await withRlsContext(
      prisma as PrismaClient,
      { userId: TC_A_ID, role: 'TELECALLER', organizationId: ORG },
      async (tx) =>
        leads.transitionInTransaction(
          actorFor({ sub: TC_A_ID, role: 'TELECALLER' }),
          { leadId: WRITE_LEAD_ID, toState: 'VISIT_REQUESTED' },
          tx as unknown as PrismaClient,
          'skip',
        ),
    );
    expect(await rows(WRITE_LEAD_ID)).toHaveLength(1);
  });

  it('reassign and co-owner each add one ASSIGNMENT row', async () => {
    const leads = makeLeadsService();
    const admin = actorFor({ sub: ADMIN_ID, role: 'ADMIN' });
    await leads.reassign(admin, {
      leadId: WRITE_LEAD_ID,
      targetUserId: TC_B_ID,
      reason: 'Balance load',
    });
    await leads.setCoOwner(admin, {
      leadId: WRITE_LEAD_ID,
      coOwnerId: TC_A_ID,
      reason: 'Shared',
    });
    const got = (await rows(WRITE_LEAD_ID)).filter((r) => r.type === 'ASSIGNMENT');
    expect(got.map((r) => r.body)).toEqual([
      'Reassigned from Detail Test TC A to Detail Test TC B - Balance load',
      'Co-owner set: Detail Test TC A - Shared',
    ]);
  });

  it('an Activity insert rejected by RLS fails hard and writes nothing', async () => {
    // TC_B neither owns, co-owns nor manages CAP_LEAD: the insert policy rejects it.
    await expect(
      withRlsContext(
        prisma as PrismaClient,
        { userId: TC_B_ID, role: 'TELECALLER', organizationId: ORG },
        async (tx) =>
          recordLeadActivity(
            tx as unknown as PrismaClient,
            actorFor({ sub: TC_B_ID, role: 'TELECALLER' }),
            { leadId: CAP_LEAD_ID, type: 'NOTE', body: 'nope' },
          ),
      ),
    ).rejects.toBeDefined();
    expect(await rows(CAP_LEAD_ID)).toHaveLength(0);
  });

  it('pages backwards with a cursor: no gaps, no overlap, oldest-first per page', async () => {
    const leads = makeLeadsService();
    const admin = actorFor({ sub: ADMIN_ID, role: 'ADMIN' });
    const base = Date.now() - 10_000_000;
    // Same-millisecond pair exercises the (createdAt, id) tie-break.
    await adminSeed((db) =>
      db.activity.createMany({
        data: Array.from({ length: 125 }, (_, i) => ({
          leadId: CAP_LEAD_ID,
          organizationId: ORG,
          userId: TC_A_ID,
          type: 'NOTE' as const,
          body: `row ${i}`,
          createdAt: new Date(base + Math.floor(i / 2) * 1000),
        })),
      }),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await leads.activities(admin, CAP_LEAD_ID, { cursor, limit: 50 });
      pages += 1;
      expect(res.items.length).toBeLessThanOrEqual(50);
      seen.unshift(...res.items.map((r) => r.body));
      cursor = res.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(125);
    expect(new Set(seen).size).toBe(125);
    // Newest page holds the newest rows, oldest-first.
    const first = await leads.activities(admin, CAP_LEAD_ID, { limit: 50 });
    expect(first.items).toHaveLength(50);
    expect(first.items[49].body).toMatch(/^row 12[34]$/);
    expect(first.nextCursor).not.toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    const leads = makeLeadsService();
    await expect(
      leads.activities(actorFor({ sub: ADMIN_ID, role: 'ADMIN' }), CAP_LEAD_ID, {
        cursor: 'not-a-cursor',
      }),
    ).rejects.toThrow(/Invalid timeline cursor/);
  });
});
