// T-E2b follow-up queue - service tests.
//
// Real-DB tests (no mocks). The service uses withRlsContext, the
// convert path uses LeadsService.createInTransaction, and the
// markSpam path mutates the row. All of this needs a live
// Postgres to be honest about RLS, FK cascades, and the unique
// convertedToLeadId constraint.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';

import { LeadsService } from '../leads/leads.service';

import { WhatsappUnknownContactsService } from './whatsapp-unknown-contacts.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const TEST_USER_ID = 'test-wa-uc-admin-' + Date.now();
const TEST_TEAM_ID = 'test-wa-uc-team-' + Date.now();

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: TEST_USER_ID, role: 'ADMIN', teamId: TEST_TEAM_ID, organizationId: 'org_bootstrap' },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

async function ensureFixtures(): Promise<void> {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    // Team first (FK target for User.teamId)
    await db.team.upsert({
      where: { id: TEST_TEAM_ID },
      update: {},
      create: { id: TEST_TEAM_ID, name: 'WA-UC Test Team', organizationId: 'org_bootstrap' },
    });
    await db.user.upsert({
      where: { id: TEST_USER_ID },
      update: { teamId: TEST_TEAM_ID, role: 'ADMIN' },
      create: {
        id: TEST_USER_ID,
        email: `wa-uc-admin-${Date.now()}@example.com`,
        name: 'WA-UC Test Admin',
        role: 'ADMIN',
        teamId: TEST_TEAM_ID,
        mustChangePassword: false,
        organizationId: 'org_bootstrap',
      },
    });
  });
}

function makeAdminActor(): JwtPayload {
  return {
    sub: TEST_USER_ID,
    email: 'wa-uc-admin@example.com',
    role: 'ADMIN',
    teamId: TEST_TEAM_ID,
    organizationId: 'org_bootstrap',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

// Per-test tracked IDs for cleanup.
const TEST_CONTACT_IDS: string[] = [];
const TEST_LEAD_IDS: string[] = [];

async function seedContact(label: string): Promise<{
  id: string;
  phoneE164: string;
}> {
  if (prisma === null) throw new Error('prisma missing');
  // Phone must be unique per test run AND per row (unique constraint
  // on phoneE164). Use a high-resolution counter (nanoseconds via
  // process.hrtime.bigint) + a per-row random suffix to avoid
  // collisions even when many seedContact calls happen within the
  // same millisecond.
  const highRes = process.hrtime.bigint().toString();
  const random = Math.random().toString(36).slice(2, 10);
  const phoneE164 = `91${highRes}${random}`.slice(0, 14);
  const id = `wa-uc-test-${label}-${highRes}-${random}`;
  await adminSeed(async (db) => {
    await db.whatsappUnknownContact.create({
      data: {
        id,
        phoneE164,
        firstMessageAt: new Date(),
        lastMessageAt: new Date(),
        firstMessageBody: 'Hi, I am interested in 3BHK in Shadhil Meadows',
      },
    });
  });
  TEST_CONTACT_IDS.push(id);
  return { id, phoneE164 };
}

async function cleanupAll(): Promise<void> {
  if (prisma === null) return;
  await adminSeed(async (tx) => {
    const db = tx as unknown as PrismaClient;
    if (TEST_LEAD_IDS.length > 0) {
      // Delete Leads (cascades to Messages, Activities, etc.)
      await db.lead.deleteMany({ where: { id: { in: TEST_LEAD_IDS } } });
    }
    if (TEST_CONTACT_IDS.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM "WhatsappUnknownContact" WHERE id = ANY($1::text[])`,
        TEST_CONTACT_IDS,
      );
    }
  });
  TEST_CONTACT_IDS.length = 0;
  TEST_LEAD_IDS.length = 0;
}

describe.skipIf(!HAS_DB)('WhatsappUnknownContactsService - T-E2b follow-up queue', () => {
  let service: WhatsappUnknownContactsService;
  let prismaService: PrismaService;
  let leadsService: LeadsService;

  beforeAll(async () => {
    await ensureFixtures();
  }, 30_000);

  afterAll(async () => {
    await cleanupAll();
  }, 30_000);

  beforeEach(() => {
    prismaService = {
      $client: prisma as unknown as PrismaClient,
    } as PrismaService;
    leadsService = new LeadsService(prismaService);
    service = new WhatsappUnknownContactsService(prismaService, leadsService);
  });

  describe('list', () => {
    it('returns the PENDING queue ordered by most recent first', async () => {
      const a = await seedContact('list-a');
      const b = await seedContact('list-b');
      const result = await service.list(makeAdminActor(), {
        status: 'PENDING',
        limit: 50,
      });
      // Both seeded contacts are in the result; b is newer (later
      // seed call) so it comes first.
      const ourRows = result.rows.filter((r) =>
        r.id === a.id || r.id === b.id,
      );
      expect(ourRows).toHaveLength(2);
      expect(ourRows[0]?.id).toBe(b.id);
      expect(ourRows[1]?.id).toBe(a.id);
      // firstMessageBody is preserved.
      expect(ourRows[0]?.firstMessageBody).toBe(
        'Hi, I am interested in 3BHK in Shadhil Meadows',
      );
    });

    it('filters by status - CONVERTED contacts are excluded from PENDING', async () => {
      const c = await seedContact('filter');
      // Mark as CONVERTED (without creating a real Lead - just flip
      // the status for this test).
      if (prisma === null) throw new Error('prisma missing');
      await adminSeed(async (db) => {
        await db.whatsappUnknownContact.update({
          where: { id: c.id },
          data: { status: 'CONVERTED', convertedToLeadId: null },
        });
      });
      const result = await service.list(makeAdminActor(), {
        status: 'PENDING',
        limit: 50,
      });
      expect(result.rows.find((r) => r.id === c.id)).toBeUndefined();
    });
  });

  describe('convert', () => {
    it('creates a Lead, links the contact, returns both', async () => {
      const c = await seedContact('convert-happy');
      const result = await service.convert(makeAdminActor(), c.id, {
        name: 'Converted Customer',
        phone: c.phoneE164,
        source: 'WHATSAPP',
        notes: 'First message: Hi, I am interested in 3BHK in Shadhil Meadows',
      });

      // The Lead has a real id, the right state (NEW), and the
      // expected shape.
      expect(result.lead.id).toBeTruthy();
      expect(result.lead.name).toBe('Converted Customer');
      expect(result.lead.phone).toBe(c.phoneE164);
      expect(result.lead.state).toBe('NEW');
      expect(result.lead.teamId).toBe(TEST_TEAM_ID);

      // The contact is now CONVERTED, linked to the Lead, with the
      // body preserved.
      expect(result.contact.status).toBe('CONVERTED');
      expect(result.contact.convertedToLeadId).toBe(result.lead.id);
      expect(result.contact.firstMessageBody).toBe(
        'Hi, I am interested in 3BHK in Shadhil Meadows',
      );

      // Track for cleanup.
      TEST_LEAD_IDS.push(result.lead.id);
    });

    it('forces the Lead source to WHATSAPP regardless of input', async () => {
      const c = await seedContact('convert-source-override');
      const result = await service.convert(makeAdminActor(), c.id, {
        // Try to set source to META_AD - the service must override.
        name: 'Source Override Attempt',
        phone: c.phoneE164,
        source: 'META_AD',
      } as never);
      TEST_LEAD_IDS.push(result.lead.id);
      // Read the Lead back; source must be 'WHATSAPP'.
      if (prisma === null) throw new Error('prisma missing');
      const lead = await adminSeed(async (db) =>
        db.lead.findUnique({ where: { id: result.lead.id }, select: { source: true } }),
      );
      expect(lead?.source).toBe('WHATSAPP');
    });

    it('returns 409 on second convert of the same contact', async () => {
      const c = await seedContact('convert-twice');
      const first = await service.convert(makeAdminActor(), c.id, {
        name: 'First Convert',
        phone: c.phoneE164,
        source: 'WHATSAPP',
      });
      TEST_LEAD_IDS.push(first.lead.id);

      // Second convert of the same contact must fail.
      await expect(
        service.convert(makeAdminActor(), c.id, {
          name: 'Second Convert',
          phone: c.phoneE164,
          source: 'WHATSAPP',
        }),
      ).rejects.toThrow(/already CONVERTED/);
    });

    it('returns 404 on unknown contact id', async () => {
      await expect(
        service.convert(makeAdminActor(), 'cxxxxxxxxxxxxxxxxxxxxxxx', {
          name: 'Nobody',
          phone: '910000000099',
          source: 'WHATSAPP',
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('markSpam', () => {
    it('flips a PENDING contact to SPAM', async () => {
      const c = await seedContact('spam-happy');
      const result = await service.markSpam(makeAdminActor(), c.id);
      expect(result.contact.status).toBe('SPAM');
      expect(result.contact.id).toBe(c.id);
      expect(result.contact.convertedToLeadId).toBeNull();
    });

    it('is idempotent on already-SPAM contacts', async () => {
      const c = await seedContact('spam-twice');
      const first = await service.markSpam(makeAdminActor(), c.id);
      expect(first.contact.status).toBe('SPAM');
      // Second call: still SPAM, no error.
      const second = await service.markSpam(makeAdminActor(), c.id);
      expect(second.contact.status).toBe('SPAM');
    });

    it('refuses to mark a CONVERTED contact as SPAM (would orphan the Lead)', async () => {
      const c = await seedContact('spam-converted');
      const convert = await service.convert(makeAdminActor(), c.id, {
        name: 'Spam Attempt Subject',
        phone: c.phoneE164,
        source: 'WHATSAPP',
      });
      TEST_LEAD_IDS.push(convert.lead.id);
      await expect(service.markSpam(makeAdminActor(), c.id)).rejects.toThrow(
        /is CONVERTED/,
      );
    });
  });
});
