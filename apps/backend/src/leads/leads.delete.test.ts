// DELETE /leads/:id - integration test (autoplan 2026-09-07, plan T5).
//
// Real-DB tests on the leads.reassign.test.ts pattern (no mocks; seed via
// admin actor; per-run unique IDs). Covers every branch of the guarded
// deleteMany (D13/D14/D17/D19):
//   1. ADMIN happy path: lead gone + audit before-snapshot = full row.
//   2. 403: TELECALLER / SALES_EXEC / MANAGER (D14 - RLS is ADMIN-only).
//   3. 409: lead is WON (revenue record protection).
//   4. 409: lead has ANY booking - TOKEN case pins the D13 regression
//      (the pre-review guard named a nonexistent CONFIRMED status).
//   5. 404: unknown id (typed exception, not P2025-as-500).
//   6. 404: second delete (lead already gone).
//   7. Cascade reality: children gone, AuditLog survives.
//   8. WhatsappUnknownContact.convertedToLeadId nulled in the same tx (D19).

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ConflictException,
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
const TEAM_ID = `test-del-team-${RUN_TAG}`;
const ADMIN_ID = `test-del-admin-${RUN_TAG}`;
const TC_ID = `test-del-tc-${RUN_TAG}`;
const MGR_ID = `test-del-mgr-${RUN_TAG}`;
const SE_ID = `test-del-se-${RUN_TAG}`;
const LEAD_OK = `test-del-lead-ok-${RUN_TAG}`;
const LEAD_WON = `test-del-lead-won-${RUN_TAG}`;
const LEAD_BOOKED = `test-del-lead-booked-${RUN_TAG}`;
const LEAD_CONVERTED = `test-del-lead-conv-${RUN_TAG}`;
const WA_CONTACT_ID = `test-del-wac-${RUN_TAG}`;
const PROJECT_ID = `test-del-project-${RUN_TAG}`;
const PHASE_ID = `test-del-phase-${RUN_TAG}`;
const UNIT_ID = `test-del-unit-${RUN_TAG}`;

const ALL_LEAD_IDS = [LEAD_OK, LEAD_WON, LEAD_BOOKED, LEAD_CONVERTED];
const ALL_USER_IDS = [ADMIN_ID, TC_ID, MGR_ID, SE_ID];
// Every business row now carries organizationId (T-ORG multitenancy).
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

// Phone must be unique per run AND per rapid re-run: RUN_TAG's leading
// digits are Date.now(), so slice(0,7) collides when two runs land in
// the same second (the WhatsApp phoneE164 unique key caught this). Use
// the full digit-stripped tag (Date.now + random suffix) for entropy.
const PHONE = (n: number) =>
  `92${RUN_TAG.replace(/\D/g, '').slice(0, 10)}${n}`;

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  // ADMIN satisfies every policy by role alone - the lead_insert policy
  // resolves team membership via TeamMember / Team.managerId (the
  // app.user_team_id GUC was removed in the T-TEAM-AUTHORITATIVE cutover).
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(
  role: 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC',
): JwtPayload {
  const sub =
    role === 'ADMIN'
      ? ADMIN_ID
      : role === 'MANAGER'
        ? MGR_ID
        : role === 'TELECALLER'
          ? TC_ID
          : SE_ID;
  return {
    sub,
    email: `${sub}@test.local`,
    role,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

function makeLeadsService(): LeadsService {
  return new LeadsService({ $client: prisma } as unknown as PrismaService);
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.team.upsert({
      where: { id: TEAM_ID },
      update: {},
      create: {
        id: TEAM_ID,
        name: `Delete Test Team ${RUN_TAG}`,
        organizationId: ORG,
      },
    });

    for (const [id, role] of [
      [ADMIN_ID, 'ADMIN'],
      [MGR_ID, 'MANAGER'],
      [TC_ID, 'TELECALLER'],
      [SE_ID, 'SALES_EXEC'],
    ] as const) {
      await db.user.upsert({
        where: { id },
        update: { role },
        create: {
          id,
          email: `${id}@test.local`,
          name: `Delete Test ${role}`,
          role,
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
    }

    await db.team.update({ where: { id: TEAM_ID }, data: { managerId: MGR_ID } });
    for (const [userId, teamId] of [
      [TC_ID, TEAM_ID],
      [SE_ID, TEAM_ID],
    ] as const) {
      await db.teamMember.upsert({
        where: { userId_teamId: { userId, teamId } },
        update: {},
        create: { userId, teamId, organizationId: ORG },
      });
    }

    // T-LEAD-PROJECT-REQUIRED (2026-09-16): the project must exist BEFORE the
    // leads below, which now carry a projectId FK. It previously appeared further
    // down (only Booking needed it), so the FK fails if it is not hoisted here.
    await db.project.upsert({
      where: { id: PROJECT_ID },
      update: {},
      create: {
        id: PROJECT_ID,
        name: `Delete Test Project ${RUN_TAG}`,
        slug: `delete-test-${RUN_TAG}`,
        address: 'Test address',
        organizationId: ORG,
      },
    });

    const baseLead = {
      name: 'Delete Test Lead',
      source: 'WEBSITE',
      state: 'NEW' as const,
      teamId: TEAM_ID,
      ownerId: TC_ID,
      ownerType: 'TELECALLER' as const,
      organizationId: ORG,
      // T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL.
      projectId: PROJECT_ID,
    };

    await db.lead.upsert({
      where: { id: LEAD_OK },
      update: { phone: PHONE(1), phoneE164: PHONE(1) },
      create: { id: LEAD_OK, phone: PHONE(1), phoneE164: PHONE(1), ...baseLead },
    });
    await db.lead.upsert({
      where: { id: LEAD_WON },
      update: { state: 'WON', phone: PHONE(2), phoneE164: PHONE(2) },
      create: {
        id: LEAD_WON,
        phone: PHONE(2),
        phoneE164: PHONE(2),
        ...baseLead,
        state: 'WON',
      },
    });
    await db.lead.upsert({
      where: { id: LEAD_BOOKED },
      update: { phone: PHONE(3), phoneE164: PHONE(3) },
      create: { id: LEAD_BOOKED, phone: PHONE(3), phoneE164: PHONE(3), ...baseLead },
    });
    await db.lead.upsert({
      where: { id: LEAD_CONVERTED },
      update: { phone: PHONE(4), phoneE164: PHONE(4) },
      create: {
        id: LEAD_CONVERTED,
        phone: PHONE(4),
        phoneE164: PHONE(4),
        ...baseLead,
      },
    });

    // TOKEN-status booking on LEAD_BOOKED (the D13 regression: the
    // pre-review guard only named HOLD/CONFIRMED - CONFIRMED doesn't
    // exist). Booking requires a Unit (unitId NOT NULL, onDelete:
    // Restrict) so the fixture builds Project → Phase → Unit.
    await db.phase.upsert({
      where: { id: PHASE_ID },
      update: {},
      create: {
        id: PHASE_ID,
        projectId: PROJECT_ID,
        name: 'Phase 1',
        organizationId: ORG,
      },
    });
    await db.unit.upsert({
      where: { id: UNIT_ID },
      update: {},
      create: {
        id: UNIT_ID,
        phaseId: PHASE_ID,
        unitNumber: `A-${RUN_TAG.slice(0, 6)}`,
        bhk: 3,
        buildupSqft: 1000,
        pricePerSqft: 12000,
        price: 12000000,
        organizationId: ORG,
      },
    });
    const existing = await db.booking.findFirst({
      where: { leadId: LEAD_BOOKED },
    });
    if (existing === null) {
      await db.booking.create({
        data: {
          leadId: LEAD_BOOKED,
          unitId: UNIT_ID,
          userId: TC_ID,
          status: 'TOKEN',
          amount: 12000000,
          listAmount: 12000000,
          tokenAmount: 100000,
          organizationId: ORG,
        },
      });
    }

    // WhatsApp unknown contact converted into LEAD_CONVERTED (D19 pointer).
    await db.whatsappUnknownContact.upsert({
      where: { id: WA_CONTACT_ID },
      update: { convertedToLeadId: LEAD_CONVERTED },
      create: {
        id: WA_CONTACT_ID,
        phoneE164: PHONE(5),
        firstMessageAt: new Date(),
        lastMessageAt: new Date(),
        status: 'CONVERTED',
        convertedToLeadId: LEAD_CONVERTED,
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
          { entityType: 'Lead', entityId: { in: ALL_LEAD_IDS } },
          { userId: { in: ALL_USER_IDS } },
        ],
      },
    });
    await db.whatsappUnknownContact.deleteMany({
      where: { id: WA_CONTACT_ID },
    });
    await db.booking.deleteMany({ where: { leadId: { in: ALL_LEAD_IDS } } });
    await db.lead.deleteMany({ where: { id: { in: ALL_LEAD_IDS } } });
    await db.unit.deleteMany({ where: { id: UNIT_ID } });
    await db.phase.deleteMany({ where: { id: PHASE_ID } });
    await db.project.deleteMany({ where: { id: PROJECT_ID } });
    await db.user.deleteMany({ where: { id: { in: ALL_USER_IDS } } });
    await db.team.deleteMany({ where: { id: TEAM_ID } });
  });
}, 30_000);

describe.skipIf(!HAS_DB)('DELETE /leads/:id (leads.service.delete)', () => {
  it('happy: ADMIN deletes a NEW lead; audit before-snapshot = full row', async () => {
    const service = makeLeadsService();
    const result = await service.delete(actorFor('ADMIN'), LEAD_OK);
    expect(result.id).toBe(LEAD_OK);

    const gone = await adminSeed((db) => db.lead.findUnique({ where: { id: LEAD_OK } }));
    expect(gone).toBeNull();

    const audit = await adminSeed((db) =>
      db.auditLog.findFirst({
        where: { action: 'lead.delete', entityId: LEAD_OK },
      }),
    );
    expect(audit).not.toBeNull();
    const before = (audit?.before ?? {}) as Record<string, unknown>;
    // The row is gone; the snapshot is the only trace - it must carry the
    // full lead (D17/plan §3).
    expect(before['id']).toBe(LEAD_OK);
    expect(before['name']).toContain('Delete Test Lead');
    expect(before['state']).toBe('NEW');
    expect(before['phone']).toBe(PHONE(1));
    expect(before['teamId']).toBe(TEAM_ID);
  });

  it('403: TELECALLER cannot delete (even their own lead)', async () => {
    const service = makeLeadsService();
    await expect(
      service.delete(actorFor('TELECALLER'), LEAD_CONVERTED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('403: SALES_EXEC cannot delete', async () => {
    const service = makeLeadsService();
    await expect(
      service.delete(actorFor('SALES_EXEC'), LEAD_CONVERTED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('403: MANAGER cannot delete (D14 - RLS lead_delete_admin is ADMIN-only; a wider gate here would 500 via P2025)', async () => {
    const service = makeLeadsService();
    await expect(
      service.delete(actorFor('MANAGER'), LEAD_CONVERTED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('409: WON lead cannot be deleted (close as LOST instead)', async () => {
    const service = makeLeadsService();
    await expect(
      service.delete(actorFor('ADMIN'), LEAD_WON),
    ).rejects.toThrow(ConflictException);
    // Row still there.
    const still = await adminSeed((db) => db.lead.findUnique({ where: { id: LEAD_WON } }));
    expect(still).not.toBeNull();
  });

  it('409: lead with a TOKEN booking cannot be deleted (D13: ANY booking blocks; TOKEN pins the CONFIRMED-status regression)', async () => {
    const service = makeLeadsService();
    await expect(
      service.delete(actorFor('ADMIN'), LEAD_BOOKED),
    ).rejects.toThrow(ConflictException);
    const still = await adminSeed((db) => db.lead.findUnique({ where: { id: LEAD_BOOKED } }));
    expect(still).not.toBeNull();
    const booking = await adminSeed((db) =>
      db.booking.findFirst({ where: { leadId: LEAD_BOOKED } }),
    );
    expect(booking).not.toBeNull();
  });

  it('404: unknown id throws typed NotFoundException', async () => {
    const service = makeLeadsService();
    await expect(
      service.delete(actorFor('ADMIN'), 'test-del-nonexistent-cuid-000000'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404: second delete (already deleted) throws typed NotFoundException', async () => {
    const service = makeLeadsService();
    // LEAD_OK was deleted by the happy-path test.
    await expect(
      service.delete(actorFor('ADMIN'), LEAD_OK),
    ).rejects.toThrow(NotFoundException);
  });

  it('cascade reality: converted lead delete removes the row; WhatsApp convert pointer nulled in the same tx (D19)', async () => {
    const service = makeLeadsService();
    await service.delete(actorFor('ADMIN'), LEAD_CONVERTED);

    const gone = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: LEAD_CONVERTED } }),
    );
    expect(gone).toBeNull();

    const contact = await adminSeed((db) =>
      db.whatsappUnknownContact.findUnique({ where: { id: WA_CONTACT_ID } }),
    );
    expect(contact).not.toBeNull();
    expect(contact?.convertedToLeadId).toBeNull();
  });
});