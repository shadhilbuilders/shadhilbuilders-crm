// Marketing consent endpoint - real-DB test (no mocks), mirroring
// leads.detail.test.ts.
//
// protects= the consent ledger is append-only, the newest row decides, the row
// and its audit entry land in the same transaction, and a lead the actor cannot
// see is a 404 rather than somebody else's customer gaining an opt-in.
// fails_when= an opt-out updates or deletes the earlier opt-in row, a repeat
// click appends a meaningless second row, the audit entry is skipped, or RLS
// lets a telecaller record consent for a lead they do not own.
// no_claim= nothing about the sender actually firing. A green run here means an
// opt-in is on the ledger; whether WhatsApp accepts the template is the
// network path, still unproven.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { createId } from '@paralleldrive/cuid2';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';
import { createDirectPrismaClient } from '@shadhil/database/test-db-isolation';

import { PrismaService } from '../prisma/prisma.module';
import { LeadConsentService } from './lead-consent.service';
import { LeadsService } from './leads.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Consent is APPEND-ONLY by policy: there is no DELETE policy on the table, so
// a staff-context deleteMany removes zero rows and silently leaves a previous
// test's ledger behind. Cleanup therefore runs as the bypass-RLS owner role -
// the test-only surface, never a business path.
const directPrisma = HAS_DB ? createDirectPrismaClient() : null;

const ORG = 'ceid01lpfe1esm8jwsxid41k28'; // seeded demo org
const TEST_PROJECT_ID = 'testprojconsent' + Date.now().toString();

const ADMIN_ID = createId();
const TC_A_ID = createId(); // owns the lead
const TC_B_ID = createId(); // same org, different lead lane
const TEAM_A_ID = createId();
const TEAM_B_ID = createId();
const LEAD_ID = createId();

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
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

const admin = () => actorFor({ sub: ADMIN_ID, role: 'ADMIN' });
const owner = () => actorFor({ sub: TC_A_ID, role: 'TELECALLER' });
const outsider = () => actorFor({ sub: TC_B_ID, role: 'TELECALLER' });

function makeConsentService(): LeadConsentService {
  return new LeadConsentService({ $client: prisma } as unknown as PrismaService);
}

function makeLeadsService(): LeadsService {
  return new LeadsService({ $client: prisma } as unknown as PrismaService);
}

/** Every Consent row for the test lead, oldest first, read as ADMIN. */
async function consentRows(): Promise<Array<{ granted: boolean; source: string }>> {
  return adminSeed((db) =>
    db.consent.findMany({
      where: { leadId: LEAD_ID, consentType: 'MARKETING' },
      orderBy: [{ grantedAt: 'asc' }, { createdAt: 'asc' }],
      select: { granted: true, source: true },
    }),
  );
}

async function consentAuditRows(): Promise<Array<{ before: unknown; after: unknown }>> {
  return adminSeed((db) =>
    db.auditLog.findMany({
      where: { action: 'lead.consent.record', entityType: 'Lead', entityId: LEAD_ID },
      orderBy: { createdAt: 'asc' },
      select: { before: true, after: true },
    }),
  );
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.project.upsert({
      where: { id: TEST_PROJECT_ID },
      update: {},
      create: {
        id: TEST_PROJECT_ID,
        name: `Consent Test Project ${TEST_PROJECT_ID}`,
        slug: TEST_PROJECT_ID,
        address: 'test',
        organizationId: ORG,
      },
    });
    for (const [teamId, label] of [
      [TEAM_A_ID, 'A'],
      [TEAM_B_ID, 'B'],
    ] as const) {
      await db.team.upsert({
        where: { id: teamId },
        update: {},
        create: { id: teamId, name: `Consent Test Team ${label}`, organizationId: ORG },
      });
    }
    for (const [userId, role, label] of [
      [ADMIN_ID, 'ADMIN', 'Admin'],
      [TC_A_ID, 'TELECALLER', 'Owner'],
      [TC_B_ID, 'TELECALLER', 'Outsider'],
    ] as const) {
      await db.user.upsert({
        where: { id: userId },
        update: { role },
        create: {
          id: userId,
          email: `${userId}@test.local`,
          name: `Consent Test ${label}`,
          role,
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
    }
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
      update: {},
      create: {
        id: LEAD_ID,
        name: `Consent Test Lead ${LEAD_ID.slice(0, 8)}`,
        phone: `91${LEAD_ID.slice(0, 8)}003`,
        phoneE164: `91${LEAD_ID.slice(0, 8)}003`,
        email: 'consent@test.local',
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
  if (prisma === null || directPrisma === null) return;
  await directPrisma.consent.deleteMany({ where: { leadId: LEAD_ID } });
  await directPrisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityType: 'Lead', entityId: LEAD_ID },
        { userId: { in: [ADMIN_ID, TC_A_ID, TC_B_ID] } },
      ],
    },
  });
  await directPrisma.lead.deleteMany({ where: { id: LEAD_ID } });
  await directPrisma.teamMember.deleteMany({ where: { userId: { in: [TC_A_ID, TC_B_ID] } } });
  await directPrisma.team.deleteMany({ where: { id: { in: [TEAM_A_ID, TEAM_B_ID] } } });
  await directPrisma.user.deleteMany({ where: { id: { in: [ADMIN_ID, TC_A_ID, TC_B_ID] } } });
  await directPrisma.project.deleteMany({ where: { id: TEST_PROJECT_ID } });
  await directPrisma.$disconnect();
}, 30_000);

beforeEach(async () => {
  if (prisma === null || directPrisma === null) return;
  await directPrisma.consent.deleteMany({ where: { leadId: LEAD_ID } });
  await directPrisma.auditLog.deleteMany({ where: { entityType: 'Lead', entityId: LEAD_ID } });
});

describe.skipIf(!HAS_DB)('LeadConsentService.record', () => {
  it('appends an opt-in and audits it in the same transaction', async () => {
    const result = await makeConsentService().record(owner(), LEAD_ID, {
      granted: true,
      source: 'call_verbal',
      note: 'Buyer asked for monthly updates on the call',
    });

    expect(result.changed).toBe(true);
    expect(result.answer).toBe('granted');
    expect(result.recordedAt).not.toBeNull();

    const rows = await consentRows();
    expect(rows).toEqual([{ granted: true, source: 'call_verbal' }]);

    const audit = await consentAuditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toEqual({ marketingConsent: 'never-asked' });
    expect(audit[0]?.after).toEqual({ marketingConsent: 'granted', source: 'call_verbal' });
  });

  it('a later opt-out wins without rewriting the earlier opt-in', async () => {
    // The whole reason this is a ledger: DPDP wants the history, and the send
    // decision has to honour the most recent answer.
    const service = makeConsentService();
    await service.record(owner(), LEAD_ID, { granted: true, source: 'call_verbal' });
    const out = await service.record(owner(), LEAD_ID, { granted: false, source: 'call_verbal' });

    expect(out.answer).toBe('denied');
    const rows = await consentRows();
    expect(rows.map((r) => r.granted)).toEqual([true, false]);
    expect(await consentAuditRows()).toHaveLength(2);

    const detail = await makeLeadsService().findOne(admin(), LEAD_ID);
    expect(detail.marketingConsent).toBe('denied');
  });

  it('recording the answer already on top writes nothing, including no audit row', async () => {
    // A rep double-clicking must not turn one agreement into two rows.
    const service = makeConsentService();
    await service.record(owner(), LEAD_ID, { granted: true, source: 'call_verbal' });
    const again = await service.record(owner(), LEAD_ID, {
      granted: true,
      source: 'in_person',
    });

    expect(again.changed).toBe(false);
    expect(again.answer).toBe('granted');
    expect(again.recordedAt).not.toBeNull();
    expect(await consentRows()).toHaveLength(1);
    expect(await consentAuditRows()).toHaveLength(1);
  });

  it('a lead outside the actor lane is a 404 and writes nothing', async () => {
    // RLS-silent-zero and a missing row are indistinguishable on purpose; the
    // point here is that no consent row appears for somebody else's customer.
    await expect(
      makeConsentService().record(outsider(), LEAD_ID, { granted: true, source: 'call_verbal' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await consentRows()).toHaveLength(0);
  });

  it('an admin can record it, and the lead detail reports the moment', async () => {
    const before = await makeLeadsService().findOne(admin(), LEAD_ID);
    expect(before.marketingConsent).toBe('never-asked');
    expect(before.marketingConsentAt).toBeNull();

    const recorded = await makeConsentService().record(admin(), LEAD_ID, {
      granted: true,
      source: 'booking_form',
    });

    const after = await makeLeadsService().findOne(admin(), LEAD_ID);
    expect(after.marketingConsent).toBe('granted');
    expect(after.marketingConsentAt).toBe(recorded.recordedAt);
  });
});
