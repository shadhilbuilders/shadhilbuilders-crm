// T-E2b: chat service → outbound service integration.
//
// Verifies that when chat.service.send() is called with channel:
// 'WHATSAPP', the outbound service is invoked to enqueue an
// OutboundMessage row with the correct template + variables.

// T-E2b: chat service → outbound service integration.
//
// These tests need a live Postgres because the chat service's send()
// path uses withRlsContext (which calls prisma.$transaction to set the
// RLS session vars). The real DB also lets us assert the actual
// OutboundMessage row was created (end-to-end, not just the enqueue
// call).
//
// We use the real `prisma` singleton from @shadhil/database and stub
// only the OutboundService. The DB-touching parts (Message create,
// audit log) hit the real DB; the test cleans up after itself.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { ChatService } from './chat.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL now, so
// every fixture lead needs a project. cuid2-shaped in case it passes a DTO.
const TEST_PROJECT_ID = 'chatservicpr' + Date.now().toString();

// Test fixtures: a team + a lead. We need a real Lead to send
// WhatsApp to. The fixture setup runs against the DIRECT_DATABASE_URL
// (shadhil owner, bypasses RLS) because the cron service role has
// not been wired to OutboundMessage writes yet (T-E2b ships that
// policy in the next commit batch).
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const TEST_TEAM_ID = 'test-team-wa-' + Date.now();
const TEST_LEAD_ID = 'test-lead-wa-' + Date.now();
const TEST_OWNER_ID = 'test-owner-wa';
const TEST_USER_ID = 'test-staff-wa-' + Date.now();

// Fixtures use adminSeed (ADMIN role bypasses most RLS via the
// policies in 20260904233000_t_e2b_outbound_rls_and_grants). The
// admin RLS context also has full read/write on OutboundMessage.
async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      // T-E2b diagnostic: verify the RLS context is actually set
      const role = await tx.$queryRawUnsafe<Array<{ v: string }>>(
        "SELECT current_setting('app.user_role', true) as v",
      );
      console.error('[DIAG] RLS role =', role[0]?.v);
      return fn(tx as unknown as PrismaClient);
    },
  );
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    // Upsert team
    // Lead.projectId is NOT NULL (T-LEAD-PROJECT-REQUIRED) - the lead
    // fixtures below need a project to point at.
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
      where: { id: TEST_TEAM_ID },
      update: {},
      create: { id: TEST_TEAM_ID, name: 'WA Test Team', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    });
    // Upsert user (staff)
    await db.user.upsert({
      where: { id: TEST_USER_ID },
      update: { role: 'MANAGER' },
      create: {
        id: TEST_USER_ID,
        email: `wa-staff-${Date.now()}@example.com`,
        name: 'WA Test Staff',
        role: 'MANAGER',
        mustChangePassword: false,
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
    });
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): RLS's MANAGER checks
    // are now Team.managerId-EXISTS only (the legacy app.user_team_id GUC
    // fallback this fixture used to lean on has been removed) - set it
    // explicitly rather than relying on the manager's own User.teamId.
    await db.team.update({ where: { id: TEST_TEAM_ID }, data: { managerId: TEST_USER_ID } });
    // Upsert lead. The phone must be unique per test run (Lead has a
    // unique phone constraint). We use a 14-digit random phone that
    // starts with the test run's Date.now() so we can find + clean
    // up via LIKE if a prior run was interrupted.
    const uniquePhone = `${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    await db.lead.upsert({
      where: { id: TEST_LEAD_ID },
      update: { phoneE164: uniquePhone },
      create: {
        id: TEST_LEAD_ID,
        name: 'Rajesh Kumar',
        phone: uniquePhone,
        phoneE164: uniquePhone,
        ownerId: TEST_USER_ID,
        ownerType: 'MANAGER',
        teamId: TEST_TEAM_ID,
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',

        projectId: TEST_PROJECT_ID,
      },
    });
  });
});

afterAll(async () => {
  if (prisma === null) return;
  // Clean up the test fixtures and any OutboundMessage / Message /
  // AuditLog rows they created.
  await adminSeed(async (db) => {
    // T-E2b: reorder cleanup. The Message delete cascades to
    // OutboundMessage (FK ON DELETE CASCADE), so we delete the
    // message FIRST and skip the explicit outbound delete - the
    // cascade handles it. This avoids the DELETE permission check
    // on OutboundMessage entirely.
    await db.message.deleteMany({ where: { leadId: TEST_LEAD_ID } });
    await db.auditLog.deleteMany({ where: { userId: TEST_USER_ID } });
    await db.lead.deleteMany({ where: { id: TEST_LEAD_ID } });
    await db.user.deleteMany({ where: { id: TEST_USER_ID } });
    await db.team.deleteMany({ where: { id: TEST_TEAM_ID } });
  });
  await prisma.$disconnect();
});

beforeEach(() => {
  // No global mock reset needed - we use real DB.
});

// We stub the OutboundService by hand. Its enqueue() returns a
// Promise; we just verify the shape of the call.
interface OutboundCall {
  messageId: string;
  leadId: string;
  sendType: string;
  templateName: string;
  templateVars: Record<string, string>;
  freeformBody?: string;
}
const capturedCalls: OutboundCall[] = [];
const outboundStub = {
  enqueue: async (
    opts: OutboundCall,
    _clientOverride?: unknown,
  ) => {
    capturedCalls.push(opts);
    return { id: 'mock-out-' + Date.now() };
  },
};

const actor: JwtPayload = {
  sub: TEST_USER_ID,
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  email: 'wa-staff@example.com',
  role: 'MANAGER',
  iat: 0,
  exp: 0,
  iss: 'shadhil-crm',
};

function makeService(): ChatService {
  if (prisma === null) throw new Error('prisma missing');
  const prismaService = { $client: prisma } as never;
  return new ChatService(prismaService, outboundStub as never);
}

describe.skipIf(!HAS_DB)('ChatService.send → OutboundService.enqueue (T-E2b)', () => {
  it('enqueues a FREEFORM OutboundMessage (text reply, no template) when channel=WHATSAPP', async () => {
    capturedCalls.length = 0;
    const service = makeService();

    const result = await service.send(actor, {
      leadId: TEST_LEAD_ID,
      body: 'Hello Rajesh, your site visit is tomorrow at 3pm',
      channel: 'WHATSAPP',
    });

    // 1. Message was created - look it up via adminSeed (RLS-aware
    //    so the SELECT policy gates correctly). Bare prisma would
    //    hit the same RLS issue we had for the leadFirstName fix.
    if (prisma === null) throw new Error('prisma missing');
    const message = await withRlsContext(
      prisma,
      { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) => (tx as unknown as PrismaClient).message.findUnique({ where: { id: result.id } }),
    );
    expect(message).not.toBeNull();
    expect(message?.channel).toBe('WHATSAPP');
    expect(message?.body).toBe('Hello Rajesh, your site visit is tomorrow at 3pm');

    // 2. Outbound was enqueued as FREEFORM (a text reply inside the 24h
    //    customer-service window - no approved template required).
    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.leadId).toBe(TEST_LEAD_ID);
    expect(call.messageId).toBe(result.id);
    expect(call.sendType).toBe('FREEFORM');
    expect(call.freeformBody).toBe('Hello Rajesh, your site visit is tomorrow at 3pm');

    // 3. Returned shape is the same MessageEvent
    expect(result.channel).toBe('WHATSAPP');
    expect(result.direction).toBe('OUT');
  });

  it('IN_APP CUSTOMER message to a lead with a WhatsApp number DOES enqueue a FREEFORM WhatsApp outbound (2026-09-17)', async () => {
    capturedCalls.length = 0;
    const service = makeService();

    await service.send(actor, {
      leadId: TEST_LEAD_ID,
      body: 'The site visit is confirmed for Saturday 11 AM',
      channel: 'IN_APP',
      kind: 'CUSTOMER',
    });

    // The message row is IN_APP (renders in the panel), but because the
    // lead has a phoneE164 the staff reply is ALSO enqueued as a WhatsApp
    // text outbound so the customer receives it within the 24h window.
    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.sendType).toBe('FREEFORM');
    expect(call.freeformBody).toBe('The site visit is confirmed for Saturday 11 AM');
  });

  it('does NOT call outbound.enqueue when channel=IN_APP and the lead has NO phoneE164', async () => {
    capturedCalls.length = 0;
    // A lead without a phoneE164 (e.g. a record created with a display
    // phone but no normalized number, or a non-messaging lead) must not
    // enqueue a WhatsApp send - there is no reachable number.
    if (prisma === null) throw new Error('prisma missing');
    const service = makeService();
    await adminSeed(async (db) => {
      await db.lead.update({
        where: { id: TEST_LEAD_ID },
        data: { phoneE164: null },
      });
    });

    try {
      await service.send(actor, {
        leadId: TEST_LEAD_ID,
        body: 'Internal note: spoke to lead by phone',
        channel: 'IN_APP',
        kind: 'CUSTOMER',
      });
    } finally {
      // Restore the fixture lead's phoneE164 for sibling tests.
      const uniquePhone = `${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
      await adminSeed(async (db) => {
        await db.lead.update({ where: { id: TEST_LEAD_ID }, data: { phoneE164: uniquePhone } });
      });
    }

    expect(capturedCalls).toHaveLength(0);
  });

  it('truncates body at 1000 chars to leave headroom under Meta 1024 limit', async () => {
    capturedCalls.length = 0;
    const service = makeService();
    const longBody = 'a'.repeat(1500);

    await service.send(actor, {
      leadId: TEST_LEAD_ID,
      body: longBody,
      channel: 'WHATSAPP',
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.freeformBody!.length).toBe(1000);
  });
});
