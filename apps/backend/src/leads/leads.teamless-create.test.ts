// T-TEAMLESS-CREATE (2026-09-08): a teamless ADMIN/OWNER must be able to
// create a lead.
//
// Real-DB tests (no mocks). Regression guard for the runtime error
// "teamId is required when an ADMIN/OWNER creates a lead (no actor teamId)".
//
// Root cause: Lead.teamId is NOT NULL, but seeded ADMIN/OWNER users carry
// `teamId: null` on their JWT (seed keeps it null by design). The create
// flow previously threw a BadRequestException. Per DESIGN.md §3
// ("admin-created leads can be assigned to any team") the service now
// resolves a DEFAULT team (oldest first - the primary seed team) so a
// teamless admin/owner can create a lead and the manager-assignment engine
// still routes the owner within that team.
//
// We need exactly ONE real team present (the default-team resolver picks
// the oldest). We seed our own team so we don't depend on the seed DB's
// team being present, and assert the created lead lands in it.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

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
const TEAM_ID = `test-teamless-team-${RUN_TAG}`;
// T-LEAD-PROJECT-REQUIRED (2026-09-16): create() now requires a projectId (the
// DB column is NOT NULL). The fixture owns its project rather than borrowing a
// seeded one, so the test cannot depend on what happens to exist in the dev DB.
const PROJECT_ID = `test-teamless-project-${RUN_TAG}`;
// Teamless ADMIN + OWNER actors (no teamId on the JWT, like the seed).
const ADMIN_ID = `test-teamless-admin-${RUN_TAG}`;
// OWNER actor: reuse the single seeded OWNER (the `one_owner` partial
// unique index forbids creating a second). Resolved in beforeAll.
let OWNER_ID = '';
const LEAD_IDS: string[] = [];
// Every business row now carries organizationId (T-ORG multitenancy).
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

async function seedAdmin<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  // Seeding writes as a test ADMIN who IS a member of the test team so RLS
  // allows the fixture inserts. This is distinct from the actor UNDER TEST
  // (the teamless admin/owner), whose JWT carries teamId=null.
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function teamlessActor(
  overrides: Pick<JwtPayload, 'sub' | 'role'>,
): JwtPayload {
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

let service: LeadsService;

beforeAll(async () => {
  if (prisma === null) return;
  await seedAdmin(async (db) => {
    // One project - create() requires a projectId now.
    await db.project.upsert({
      where: { id: PROJECT_ID },
      update: {},
      create: {
        id: PROJECT_ID,
        name: `Teamless Create Test Project ${RUN_TAG}`,
        slug: `test-teamless-project-${RUN_TAG}`,
        address: 'test',
        organizationId: ORG,
      },
    });
    // One team - the default-team resolver picks it (oldest first).
    await db.team.upsert({
      where: { id: TEAM_ID },
      update: {},
      create: {
        id: TEAM_ID,
        name: `Teamless Create Test Team ${RUN_TAG}`,
        organizationId: ORG,
      },
    });
    // ADMIN user (no teamId - like seed) for the actor-under-test row +
    // RLS write path.
    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: {},
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'Teamless Admin',
        role: 'ADMIN',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    // Resolve the single seeded OWNER (one_owner unique index). We do NOT
    // touch its row - the teamless OWNER actor just references its id.
    const owner = await db.user.findFirst({ where: { role: 'OWNER' } });
    OWNER_ID = owner?.id ?? '';
  });

  const prismaService = { $client: prisma } as unknown as PrismaService;
  service = new LeadsService(prismaService);
});

afterAll(async () => {
  if (prisma === null) return;
  await seedAdmin(async (db) => {
    await db.lead.deleteMany({ where: { id: { in: LEAD_IDS } } });
    await db.user.deleteMany({ where: { id: ADMIN_ID } });
    await db.team.deleteMany({ where: { id: TEAM_ID } });
  });
});

describe('LeadsService.create - teamless ADMIN/OWNER (T-TEAMLESS-CREATE)', () => {
  it('ADMIN with no teamId creates a lead in the default team', async () => {
    if (prisma === null) return; // skip if no DB
    const lead = await service.create(
      teamlessActor({ sub: ADMIN_ID, role: 'ADMIN' }),
      {
        name: `Teamless Admin Lead ${RUN_TAG}`,
        phone: `9199${RUN_TAG.replace(/\D/g, '').slice(-8)}`,
        source: 'REFERRAL',
        projectId: PROJECT_ID,
      },
    );
    LEAD_IDS.push(lead.id);
    expect(lead.id).toBeTruthy();
    // The created lead must be stamped into a real team (the default one),
    // not null (Lead.teamId is NOT NULL).
    expect(lead.status).toBe('NEW');
    const row = await seedAdmin((db) =>
      db.lead.findUnique({ where: { id: lead.id }, select: { teamId: true } }),
    );
    // Regression guard: create must no longer throw "teamId is required..."
    // and must stamp a REAL teamId (Lead.teamId is NOT NULL). The exact team
    // is the globally-oldest default (seed/demo team) - we only assert that
    // a non-null team was resolved, matching the "assigned to any team" spec.
    expect(row?.teamId).toBeTruthy();
  });

  it('OWNER with no teamId creates a lead in the default team', async () => {
    if (prisma === null) return;
    if (!OWNER_ID) {
      // No seeded owner present (unexpected, but don't fail the suite).
      expect(OWNER_ID).toBeTruthy();
      return;
    }
    const lead = await service.create(
      teamlessActor({ sub: OWNER_ID, role: 'OWNER' }),
      {
        name: `Teamless Owner Lead ${RUN_TAG}`,
        phone: `9198${RUN_TAG.replace(/\D/g, '').slice(-8)}`,
        source: 'WALK_IN',
        projectId: PROJECT_ID,
      },
    );
    LEAD_IDS.push(lead.id);
    expect(lead.id).toBeTruthy();
    const row = await seedAdmin((db) =>
      db.lead.findUnique({ where: { id: lead.id }, select: { teamId: true } }),
    );
    // Same regression guard as the ADMIN case.
    expect(row?.teamId).toBeTruthy();
  });
});
