// Webhooks controller test - T-E2b (2026-09-04).
//
// Verifies the WhatsApp inbound handler against the real Meta
// envelope shape:
//   • known-lead inbound text → Message row created
//   • unknown-number inbound text → WhatsappUnknownContact upserted
//   • status update (delivered/read/failed) → matching OutboundMessage
//     row's status field updated
//   • dedup: same Meta externalId twice → second call short-circuits
//   • GET verify-handshake unchanged
//
// Tests use a real Prisma client + real Postgres (the same shape as
// chat.service.send.test.ts). This is slower than mock-based
// testing but proves the RLS + migration actually work - a mock
// would let us skip the schema and the policies.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { WebhooksController } from './webhooks.controller';

// DB-backed test (real Postgres via pgbouncer). Skip cleanly when
// DATABASE_URL isn't loaded (e.g. bare `pnpm vitest run` without env),
// matching chat.service.send.test.ts's HAS_DB guard. Without this, the
// module-level beforeAll connects to the DB and fails loudly with
// "client password must be a string" instead of skipping.
const HAS_DB = Boolean(process.env.DATABASE_URL);

// ── Test fixtures ──────────────────────────────────────────────────
const TEST_USER_ID = 'test-wa-handler-user';
const TEST_TEAM_ID = 'test-wa-handler-team';

const uniquePhone = () =>
  `9${Date.now().toString().padStart(11, '0')}`.slice(0, 12);

let knownLeadId: string;
let knownPhone: string;
let unknownPhone: string;
let outboundMessageId: string;

beforeAll(async () => {
  if (!HAS_DB) return;
  // Seed a manager user + a team that owns the known lead. The
  // WhatsappUnknownContact / WebhookEvent / OutboundMessage rows
  // we create here are owned by CRON_SERVICE (no real actor), so
  // the user+team is only needed for the known Lead. Team is
  // upserted FIRST - User.teamId is an FK to Team (User_teamId_fkey).
  const adminClient = runtimePrisma as unknown as PrismaClient;
  await withRlsContext(
    adminClient,
    { userId: TEST_USER_ID, role: 'ADMIN', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      await tx.team.upsert({
        where: { id: TEST_TEAM_ID },
        update: {},
        create: { id: TEST_TEAM_ID, name: 'WA Handler Test Team', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      });
      await tx.user.upsert({
        where: { id: TEST_USER_ID },
        update: {},
        create: {
          id: TEST_USER_ID,
          email: 'wa-handler-admin@test.local',
          name: 'WA Handler Test Admin',
          role: 'ADMIN',
          teamId: TEST_TEAM_ID,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
    },
  );
});

beforeEach(async () => {
  // Each test starts with a clean set of fixture rows so the
  // assertions can count + look up without cross-test bleed. The
  // phone numbers include a per-test suffix to avoid unique-key
  // collisions with rows left by previous crashed runs.
  const suffix = Date.now().toString(36);
  knownPhone = `91${suffix.padStart(10, '0')}`.slice(0, 12);
  unknownPhone = `92${suffix.padStart(10, '0')}`.slice(0, 12);

  await withRlsContext(
    runtimePrisma as unknown as PrismaClient,
    { userId: TEST_USER_ID, role: 'ADMIN', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      const lead = await tx.lead.create({
        data: {
          name: 'Known Lead',
          phone: knownPhone,
          phoneE164: knownPhone,
          source: 'WEBSITE',
          teamId: TEST_TEAM_ID,
          ownerId: TEST_USER_ID,
          ownerType: 'ADMIN',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
        select: { id: true },
      });
      knownLeadId = lead.id;

      // Create an OutboundMessage with a known wamid so we can
      // test the status-update path. The Outbound row needs a
      // backing Message (FK constraint).
      const msg = await tx.message.create({
        data: {
          leadId: lead.id,
          userId: TEST_USER_ID,
          direction: 'OUT',
          channel: 'WHATSAPP',
          body: 'hi from staff',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
        select: { id: true },
      });
      const out = await tx.outboundMessage.create({
        data: {
          messageId: msg.id,
          leadId: lead.id,
          sendType: 'FREEFORM',
          freeformBody: 'hi from staff',
          status: 'SENT',
          attempts: 1,
          lastAttemptAt: new Date(),
          wamid: 'wamid.test.status.update',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
        select: { id: true },
      });
      outboundMessageId = out.id;
    },
  );
});

afterAll(async () => {
  if (!HAS_DB) return;
  // Clean up our fixtures. Order matters: WebhookEvent /
  // OutboundMessage / Message / Lead / WhatsappUnknownContact
  // before User / Team (FK cascade may already handle some of this
  // but explicit ordering avoids surprises).
  const adminClient = runtimePrisma as unknown as PrismaClient;
  await withRlsContext(
    adminClient,
    { userId: TEST_USER_ID, role: 'ADMIN', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      // Find all leads we created in this test session
      const leads = await tx.lead.findMany({
        where: { ownerId: TEST_USER_ID, source: 'WEBSITE' },
        select: { id: true },
      });
      for (const l of leads) {
        // Cascade deletes handle Message + OutboundMessage
        await tx.lead.delete({ where: { id: l.id } }).catch(() => null);
      }
      // Clean up unknown contacts we created
      await tx.whatsappUnknownContact
        .deleteMany({
          where: { phoneE164: { startsWith: '9' }, messageCount: { gte: 1 } },
        })
        .catch(() => null);
      // Clean up webhook events from this test
      await tx.webhookEvent
        .deleteMany({ where: { source: 'WHATSAPP' } })
        .catch(() => null);
    },
  );
  await runtimePrisma.$disconnect();
});

// ── The tests ──────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('WhatsApp inbound webhook - T-E2b', () => {
  const controller = new WebhooksController();

  it('writes a Message row when an inbound text comes from a known lead', async () => {
    const externalId = `wamid.test.${Date.now()}.known`;
    const result = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456' },
                messages: [
                  {
                    from: knownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hi from a real lead' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.received).toBe(true);
    expect(result.messagesCreated).toBe(1);
    expect(result.deduped).toBe(0);

    // The Message row was actually written
    const msg = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'MANAGER', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.message.findFirst({
          where: { externalId, leadId: knownLeadId },
          select: { direction: true, channel: true, body: true, userId: true },
        }),
    );
    expect(msg).toBeTruthy();
    expect(msg?.direction).toBe('IN');
    expect(msg?.channel).toBe('WHATSAPP');
    expect(msg?.body).toBe('hi from a real lead');
    expect(msg?.userId).toBeNull(); // inbound from lead, not staff
  });

  it('upserts WhatsappUnknownContact for inbound from an unknown number', async () => {
    const externalId = `wamid.test.${Date.now()}.unknown`;
    const result = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456' },
                messages: [
                  {
                    from: unknownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'is this available?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.received).toBe(true);
    expect(result.unknownContactsUpserted).toBe(1);
    expect(result.messagesCreated).toBe(0);

    // The contact row was created
    const contact = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'ADMIN', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.whatsappUnknownContact.findUnique({
          where: { phoneE164: unknownPhone },
          select: { status: true, firstMessageBody: true, messageCount: true },
        }),
    );
    expect(contact?.status).toBe('PENDING');
    expect(contact?.firstMessageBody).toBe('is this available?');
    expect(contact?.messageCount).toBe(1);

    // A second message from the same number bumps the count
    await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: unknownPhone,
                    id: `wamid.test.${Date.now()}.unknown2`,
                    timestamp: '1700000001',
                    type: 'text',
                    text: { body: 'still there?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const updated = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'ADMIN', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.whatsappUnknownContact.findUnique({
          where: { phoneE164: unknownPhone },
          select: { messageCount: true, firstMessageBody: true },
        }),
    );
    expect(updated?.messageCount).toBe(2);
    // firstMessageBody should NOT change on the 2nd+ message
    expect(updated?.firstMessageBody).toBe('is this available?');
  });

  it('updates the matching OutboundMessage when a status update arrives', async () => {
    const result = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.test.status.update',
                    status: 'delivered',
                    timestamp: '1700000000',
                    recipient_id: knownPhone,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.received).toBe(true);
    expect(result.statusesUpdated).toBe(1);

    const updated = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.outboundMessage.findUnique({
          where: { id: outboundMessageId },
          select: { status: true },
        }),
    );
    expect(updated?.status).toBe('DELIVERED');
  });

  it('dedupes by WebhookEvent.externalId (Meta retries)', async () => {
    const externalId = `wamid.test.${Date.now()}.dedup`;

    const first = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: knownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'first delivery' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(first.messagesCreated).toBe(1);

    // Second call with the SAME externalId - should be a no-op
    // for Message creation (still records the WebhookEvent
    // attempt, but the unique constraint fails and we return
    // 'deduped').
    const second = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: knownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'duplicate - should be ignored' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(second.messagesCreated).toBe(0);
    expect(second.deduped).toBe(1);

    // Only one Message row was created for that externalId
    const messages = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'MANAGER', teamId: TEST_TEAM_ID, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.message.findMany({
          where: { externalId, leadId: knownLeadId },
          select: { id: true, body: true },
        }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('first delivery');
  });

  it('GET verify-handshake echoes the challenge with a valid token', () => {
    process.env['WA_WEBHOOK_VERIFY_TOKEN'] = 'test-token';
    const challenge = controller.verify('subscribe', 'test-token', 'CHALLENGE_123');
    expect(challenge).toBe('CHALLENGE_123');
    delete process.env['WA_WEBHOOK_VERIFY_TOKEN'];
  });

  it('GET verify-handshake rejects a bad token', () => {
    process.env['WA_WEBHOOK_VERIFY_TOKEN'] = 'test-token';
    expect(() => controller.verify('subscribe', 'wrong-token', 'CHALLENGE')).toThrow();
    delete process.env['WA_WEBHOOK_VERIFY_TOKEN'];
  });
});
